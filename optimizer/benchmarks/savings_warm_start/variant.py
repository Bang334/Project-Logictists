"""Multi-trajectory portfolio Hybrid ALNS optimizer (no per-case heuristics)."""

from __future__ import annotations

import atexit
import concurrent.futures
from concurrent.futures.process import BrokenProcessPool
import contextlib
import multiprocessing
import os
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union
from unittest.mock import patch

from app import alns_engine as alns_engine_mod
from app import stacking
from app.alns_engine import calendar_salary_for_span
from app.hybrid_alns import advanced_metaheuristics as advanced_meta_mod
from app.hybrid_alns import greedy_insertion, packing_checker, route_evaluator, solution_validator
from app.hybrid_alns import solver as hybrid_solver_mod
from app.hybrid_alns.advanced_metaheuristics import solve_simulated_annealing
from app.hybrid_alns.models import OptimizationSolution
from app.hybrid_alns.objective import solution_key
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import (
    FleetOptimizationRequest, FleetOptimizationResponse, ScheduledStop,
    SpatialValidationResult, StopAction, UnassignedOrder, VehicleFloor,
)
from app.ortools_seed import extract_ortools_seed_pool
from app.packing_rules import resolve_can_rotate
from app.planning_objective import apply_planning_objective, operational_late_daily_weight_vnd
from app.route_costing import calculate_route_economic_metrics
from app.spatial_validator import _DEFAULT_MAX_SEARCH_NODES
from benchmarks.algorithm_comparison.benchmark_objective import audited_quality
from benchmarks.algorithm_comparison.unified_audit import audit_solution
from benchmarks.savings_warm_start.cycle_validator import CycleCachingSpatialValidator
from benchmarks.savings_warm_start.dynamic_packing import FastDynamicPackingChecker
from benchmarks.savings_warm_start.search_helpers import (
    bounded_optimize_production_vehicles,
    bounded_vehicle_reassignment,
    plan_operational_lateness_vnd,
    request_packing_intensity,
    route_operational_lateness_vnd,
    route_stop_signature,
    spare_budget_lns_polish,
)
from benchmarks.savings_warm_start.timed_workers import publish_checkpoint, run_timed_workers

__all__ = [
    "VariantHybridALNSOptimizer",
    "audited_quality",
    "extract_ortools_seed_pool",
]

_ORTOOLS_SEED_STRATEGIES = ("parallel-insertion-gls", "path-cheapest-arc-gls")
_MIN_PORTFOLIO_BUDGET_SECONDS = 6.0
_MIN_TIMED_SPAWN_BUDGET_SECONDS = 8.0 if os.name == "nt" else 6.0
_MIN_PORTFOLIO_ORDERS = 4
_PORTFOLIO_WORKERS = 3
_RAW_VALIDATE_STOP_ACTIONS = stacking.validate_stop_actions
_RAW_FAST_VALIDATE_STACKED_ROUTE = stacking.fast_validate_stacked_route
_RAW_REPAIR_AND_AUDIT = solution_validator.repair_and_audit_solution

StackingActionCache = Dict[Tuple[Any, ...], Tuple[int, SpatialValidationResult]]
FastStackingCache = Dict[Tuple[Any, ...], Tuple[bool, str]]


def _vehicle_geometry_key(vehicle: Any) -> Tuple[Any, ...]:
    return (
        vehicle.length_cm,
        vehicle.width_cm,
        vehicle.height_cm,
        vehicle.payload_limit_kg,
        getattr(vehicle, "door_position", "REAR"),
        getattr(vehicle, "door_width_cm", None),
    )


def _stacking_policy_key(policy: Any) -> Tuple[Any, ...]:
    return (
        int(policy.max_tiers),
        float(policy.lift_clearance_cm),
        str(policy.owner_mode),
    )


def _cargo_item_physical_key(item: Any) -> Tuple[Any, ...]:
    return (
        item.id,
        item.order_id,
        getattr(item, "customer_id", None),
        item.length_cm,
        item.width_cm,
        item.height_cm,
        item.weight_kg,
        getattr(item, "cargo_kind", "UNCLASSIFIED"),
        bool(getattr(item, "allow_upper_tier", False)),
        bool(getattr(item, "no_top_load_requested", False)),
        getattr(item, "max_top_load_g", None),
        bool(resolve_can_rotate(item)),
        tuple(getattr(item, "allowed_orientations", None) or ()),
    )


def _stacking_actions_key(
    policy: Any,
    vehicle: Any,
    actions: Sequence[StopAction],
) -> Tuple[Any, ...]:
    return (
        _vehicle_geometry_key(vehicle),
        _stacking_policy_key(policy),
        tuple(
            (
                action.stop_type,
                tuple(_cargo_item_physical_key(item) for item in action.items_to_load),
                tuple(action.items_to_unload),
            )
            for action in actions
        ),
    )


def _clone_spatial_result_for_actions(
    cached: SpatialValidationResult,
    actions: Sequence[StopAction],
) -> SpatialValidationResult:
    if actions and len(cached.step_states) == len(actions):
        cloned_states = [
            state.model_copy(
                deep=True,
                update={
                    "stop_id": action.stop_id,
                    "action_description": (
                        f"Stop {action.sequence} ({action.stop_type}) - {action.address}"
                    ),
                },
            )
            for action, state in zip(actions, cached.step_states)
        ]
    else:
        cloned_states = [state.model_copy(deep=True) for state in cached.step_states]
    return cached.model_copy(deep=True, update={"step_states": cloned_states})


def _cached_stacking_validate(
    raw_validate: Callable[..., SpatialValidationResult],
    cache: Optional[StackingActionCache],
    policy: Any,
    vehicle: Any,
    actions: Sequence[StopAction],
    *,
    max_search_nodes: Optional[int] = None,
    max_time_seconds: Optional[float] = None,
) -> SpatialValidationResult:
    action_list = list(actions)
    if cache is None:
        return raw_validate(
            policy,
            vehicle,
            action_list,
            max_search_nodes=max_search_nodes,
            max_time_seconds=max_time_seconds,
        )
    req_nodes = _DEFAULT_MAX_SEARCH_NODES if max_search_nodes is None else int(max_search_nodes)
    key = _stacking_actions_key(policy, vehicle, action_list)
    entry = cache.get(key)
    if entry is not None:
        cached_nodes, cached_result = entry
        if cached_result.is_valid or (
            cached_result.violation_code != "PLACEMENT_SEARCH_LIMIT_REACHED"
            and req_nodes <= cached_nodes
        ):
            return _clone_spatial_result_for_actions(cached_result, action_list)

    result = raw_validate(
        policy,
        vehicle,
        action_list,
        max_search_nodes=max_search_nodes,
        max_time_seconds=max_time_seconds,
    )
    if result.is_valid or result.violation_code != "PLACEMENT_SEARCH_LIMIT_REACHED":
        prev = cache.get(key)
        should_store = (
            prev is None
            or result.is_valid
            or (not prev[1].is_valid and req_nodes >= prev[0])
        )
        if should_store:
            if len(cache) >= 4096 and key not in cache:
                del cache[next(iter(cache))]
            cache[key] = (req_nodes, _clone_spatial_result_for_actions(result, ()))
    return result


@contextlib.contextmanager
def _fast_packing_context(
    enabled: bool,
    cycle_validators: Optional[
        dict[tuple[float, float, float, float, str, Optional[float]], CycleCachingSpatialValidator]
    ] = None,
    *,
    validation_deadline: Optional[Union[float, Callable[[], Optional[float]]]] = None,
    stacking_cache: Optional[StackingActionCache] = None,
    fast_stacking_cache: Optional[FastStackingCache] = None,
):
    if not enabled:
        yield
        return
    FastDynamicPackingChecker.placements_tried = 0
    validator_cache = {} if cycle_validators is None else cycle_validators
    active_stacking_cache: StackingActionCache = (
        {} if stacking_cache is None else stacking_cache
    )
    active_fast_stacking_cache: FastStackingCache = (
        {} if fast_stacking_cache is None else fast_stacking_cache
    )
    raw_validate_stop_actions = (
        _RAW_VALIDATE_STOP_ACTIONS
        if getattr(stacking.validate_stop_actions, "_is_variant_cache_wrapper", False) is True
        else stacking.validate_stop_actions
    )
    raw_fast_validate_stacked = (
        _RAW_FAST_VALIDATE_STACKED_ROUTE
        if getattr(stacking.fast_validate_stacked_route, "_is_variant_cache_wrapper", False) is True
        else stacking.fast_validate_stacked_route
    )

    def _current_validation_deadline() -> Optional[float]:
        return validation_deadline() if callable(validation_deadline) else validation_deadline

    def _cached_validate_stop_actions(
        policy: Any,
        vehicle: Any,
        actions: list[StopAction],
        *,
        max_search_nodes: Optional[int] = None,
        max_time_seconds: Optional[float] = None,
    ) -> SpatialValidationResult:
        max_time_seconds = _remaining_validation_budget(
            max_time_seconds, _current_validation_deadline()
        )
        if policy is not None:
            return _cached_stacking_validate(
                raw_validate_stop_actions,
                active_stacking_cache,
                policy,
                vehicle,
                actions,
                max_search_nodes=max_search_nodes,
                max_time_seconds=max_time_seconds,
            )
        floor = (
            vehicle
            if isinstance(vehicle, VehicleFloor)
            else VehicleFloor(
                id=vehicle.id,
                plate_number=vehicle.plate_number,
                length_cm=vehicle.length_cm,
                width_cm=vehicle.width_cm,
                height_cm=vehicle.height_cm,
                payload_limit_kg=vehicle.payload_limit_kg,
                door_position=getattr(vehicle, "door_position", "REAR"),
                door_width_cm=getattr(vehicle, "door_width_cm", None),
            )
        )
        geometry = (
            floor.length_cm,
            floor.width_cm,
            floor.height_cm,
            floor.payload_limit_kg,
            floor.door_position,
            floor.door_width_cm,
        )
        validator = validator_cache.get(geometry)
        if validator is None:
            validator = CycleCachingSpatialValidator(floor, use_uniform_layout=True)
            validator_cache[geometry] = validator
        validator.max_search_nodes = (
            _DEFAULT_MAX_SEARCH_NODES if max_search_nodes is None else max_search_nodes
        )
        validator.max_time_seconds = (
            6.0 if max_time_seconds is None else max_time_seconds
        )
        return validator.validate_plan(actions)

    setattr(_cached_validate_stop_actions, "_is_variant_cache_wrapper", True)

    def _cached_fast_validate_stacked_route(
        vehicle: Any,
        stops: Sequence[Any],
        cargo_by_id: Dict[str, Any],
        policy: Any,
        *,
        allow_layout_search: bool = True,
    ) -> Tuple[bool, str]:
        key = (
            _vehicle_geometry_key(vehicle),
            _stacking_policy_key(policy),
            bool(allow_layout_search),
            tuple(
                (
                    stop.stop_type,
                    tuple(
                        (iid, _cargo_item_physical_key(cargo_by_id[iid]))
                        for iid in (getattr(stop, "items_loaded", None) or ())
                        if iid in cargo_by_id
                    ),
                    tuple(getattr(stop, "items_unloaded", None) or ()),
                )
                for stop in stops
            ),
        )
        cached = active_fast_stacking_cache.get(key)
        if cached is not None:
            return cached
        res = raw_fast_validate_stacked(
            vehicle,
            stops,
            cargo_by_id,
            policy,
            allow_layout_search=allow_layout_search,
        )
        # Never cache negative allow_layout_search=True checks that can depend on a 20ms timeout fallback.
        if res[0] or not allow_layout_search:
            if len(active_fast_stacking_cache) >= 4096 and key not in active_fast_stacking_cache:
                del active_fast_stacking_cache[next(iter(active_fast_stacking_cache))]
            active_fast_stacking_cache[key] = res
        return res

    setattr(_cached_fast_validate_stacked_route, "_is_variant_cache_wrapper", True)

    orig_solve_sp = hybrid_solver_mod.HybridALNSSolver._solve_set_partitioning

    def _bounded_solve_set_partitioning(
        self_solver: Any,
        elite_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]],
        time_limit_sec: float = 0.5,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        current_deadline = _current_validation_deadline()
        if (
            "ortools.sat.python.cp_model" not in sys.modules
            and current_deadline is not None
            and (current_deadline - time.perf_counter())
            < max(3.0, time_limit_sec * 2.5 + 1.5)
        ):
            return None
        return orig_solve_sp(
            self_solver, elite_candidates, time_limit_sec=time_limit_sec
        )

    raw_repair_and_audit = (
        _RAW_REPAIR_AND_AUDIT
        if getattr(solution_validator.repair_and_audit_solution, "_is_variant_cache_wrapper", False) is True
        else solution_validator.repair_and_audit_solution
    )

    def _bounded_repair_and_audit(
        *args: Any,
        spatial_time_limit_sec: float = 1.5,
        repair_time_limit_sec: float = 5.0,
        **kwargs: Any,
    ) -> Any:
        current_deadline = _current_validation_deadline()
        if current_deadline is not None:
            rem = current_deadline - time.perf_counter()
            if rem <= 0.15:
                spatial_time_limit_sec = min(spatial_time_limit_sec, 0.04)
                repair_time_limit_sec = min(repair_time_limit_sec, 0.04)
            else:
                spatial_time_limit_sec = min(spatial_time_limit_sec, max(0.05, rem * 0.45))
                repair_time_limit_sec = min(repair_time_limit_sec, max(0.05, rem * 0.55))
        return raw_repair_and_audit(
            *args,
            spatial_time_limit_sec=spatial_time_limit_sec,
            repair_time_limit_sec=repair_time_limit_sec,
            **kwargs,
        )

    setattr(_bounded_repair_and_audit, "_is_variant_cache_wrapper", True)

    def _fast_place_box(
        self_checker: Any,
        item: Any,
        placed_boxes: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        total_used_area = sum(b["l"] * b["w"] for b in placed_boxes)
        box_area = item.length_cm * item.width_cm
        if total_used_area + box_area > self_checker.bed_area + 0.01:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if alns_engine_mod.resolve_can_rotate(item) and abs(item.length_cm - item.width_cm) > 0.1:
            orientations.append((item.width_cm, item.length_cm))

        edges = [(b["x"], b["y"], b["x"] + b["l"], b["y"] + b["w"]) for b in placed_boxes]
        candidate_positions = {(0.0, 0.0)}
        for bx, by, bright, btop in edges:
            candidate_positions.add((bright, by))
            candidate_positions.add((bx, btop))

        sorted_positions = sorted(candidate_positions)
        bed_l = self_checker.bed_l
        bed_w = self_checker.bed_w
        limit_l = bed_l + 0.01
        limit_w = bed_w + 0.01

        for l_dim, w_dim in orientations:
            if l_dim > bed_l or w_dim > bed_w:
                continue
            max_x = limit_l - l_dim
            for x_cand, y_cand in sorted_positions:
                if x_cand > max_x + 1e-9:
                    break
                end_x = x_cand + l_dim
                end_y = y_cand + w_dim
                if end_x <= limit_l and end_y <= limit_w:
                    overlap = False
                    for ox, oy, o_end_x, o_end_y in edges:
                        if not (
                            end_x <= ox + 0.01
                            or x_cand >= o_end_x - 0.01
                            or end_y <= oy + 0.01
                            or y_cand >= o_end_y - 0.01
                        ):
                            overlap = True
                            break
                    if not overlap:
                        return {
                            "id": item.id,
                            "order_id": item.order_id,
                            "x": x_cand,
                            "y": y_cand,
                            "l": l_dim,
                            "w": w_dim,
                            "weight": item.weight_kg,
                        }
        return None

    with (
        patch.object(greedy_insertion, "FastPackingChecker", FastDynamicPackingChecker),
        patch.object(route_evaluator, "FastPackingChecker", FastDynamicPackingChecker),
        patch.object(alns_engine_mod.FastLIFOPackingChecker, "_place_box", _fast_place_box),
        patch.object(solution_validator, "validate_stop_actions", _cached_validate_stop_actions),
        patch.object(packing_checker, "validate_stop_actions", _cached_validate_stop_actions),
        patch.object(packing_checker, "fast_validate_stacked_route", _cached_fast_validate_stacked_route),
        patch.object(alns_engine_mod, "validate_stop_actions", _cached_validate_stop_actions),
        patch.object(stacking, "validate_stop_actions", _cached_validate_stop_actions),
        patch.object(stacking, "fast_validate_stacked_route", _cached_fast_validate_stacked_route),
        patch.object(
            hybrid_solver_mod.HybridALNSSolver,
            "_solve_set_partitioning",
            _bounded_solve_set_partitioning,
        ),
        patch.object(solution_validator, "repair_and_audit_solution", _bounded_repair_and_audit),
        patch.object(hybrid_solver_mod, "repair_and_audit_solution", _bounded_repair_and_audit),
        patch.object(advanced_meta_mod, "repair_and_audit_solution", _bounded_repair_and_audit),
    ):
        yield


def _remaining_validation_budget(limit: Optional[float], deadline: Optional[float]) -> Optional[float]:
    if deadline is None:
        return limit
    return min(6.0 if limit is None else limit, max(0.0, deadline - time.perf_counter()))

_PORTFOLIO_EXECUTOR: Optional[concurrent.futures.ProcessPoolExecutor] = None


def _shutdown_portfolio_executor() -> None:
    global _PORTFOLIO_EXECUTOR
    if _PORTFOLIO_EXECUTOR is not None:
        _PORTFOLIO_EXECUTOR.shutdown(wait=True, cancel_futures=True)
        _PORTFOLIO_EXECUTOR = None


atexit.register(_shutdown_portfolio_executor)


def _get_portfolio_executor() -> concurrent.futures.ProcessPoolExecutor:
    global _PORTFOLIO_EXECUTOR
    if _PORTFOLIO_EXECUTOR is None:
        _PORTFOLIO_EXECUTOR = concurrent.futures.ProcessPoolExecutor(
            max_workers=_PORTFOLIO_WORKERS
        )
    return _PORTFOLIO_EXECUTOR


def _reset_portfolio_executor() -> None:
    global _PORTFOLIO_EXECUTOR
    if _PORTFOLIO_EXECUTOR is not None:
        _PORTFOLIO_EXECUTOR.shutdown(wait=False, cancel_futures=True)
        _PORTFOLIO_EXECUTOR = None


def _route_pool_signature(
    routes: Sequence[Sequence[ScheduledStop]],
) -> Tuple[Tuple[Tuple[str, str], ...], ...]:
    return tuple(
        tuple((stop.allocation_id or stop.order_id or "", stop.stop_type) for stop in route)
        for route in routes
    )


def _extract_diverse_ortools_seeds(
    request: FleetOptimizationRequest,
    *,
    remaining_seconds: float,
) -> Tuple[List[List[List[ScheduledStop]]], Dict[str, Any]]:
    """Collect OR-Tools raw seeds using a single routing model build."""
    started = time.perf_counter()
    problem_cap = min(8.0, 0.70 + 0.048 * len(request.orders))
    routing_seconds = min(problem_cap, max(0.45, remaining_seconds * 0.22))
    stagnation_seconds = min(routing_seconds * 0.45, max(0.40, routing_seconds * 0.45))
    raw_pool, best_meta = extract_ortools_seed_pool(
        request,
        strategy_keys=(_ORTOOLS_SEED_STRATEGIES[0],),
        routing_seconds=routing_seconds,
        stagnation_seconds=stagnation_seconds,
    )
    served = int(best_meta.get("seed_served_orders", 0) or 0)
    if request.orders and served < len(request.orders) and len(_ORTOOLS_SEED_STRATEGIES) > 1:
        rem_after = remaining_seconds - (time.perf_counter() - started)
        if rem_after >= max(2.5, remaining_seconds * 0.35):
            fb_budget = min(problem_cap * 0.50, rem_after * 0.14)
            fb_pool, fb_meta = extract_ortools_seed_pool(
                request,
                strategy_keys=_ORTOOLS_SEED_STRATEGIES[1:],
                routing_seconds=fb_budget,
                stagnation_seconds=fb_budget * 0.5,
            )
            raw_pool = [*raw_pool, *fb_pool]
            if int(fb_meta.get("seed_served_orders", 0) or 0) > served:
                best_meta = fb_meta
                served = int(best_meta.get("seed_served_orders", 0) or 0)
            best_meta["seed_seconds"] = round(time.perf_counter() - started, 4)
    min_required = max(1, int(len(request.orders) * 0.8)) if request.orders else 0
    if request.orders and served < min_required:
        return [], dict(best_meta)
    seed_pool: List[List[List[ScheduledStop]]] = []
    seen_signatures = set()
    for raw_routes in raw_pool:
        sig = _route_pool_signature(raw_routes)
        if any(sig) and sig not in seen_signatures:
            seen_signatures.add(sig)
            seed_pool.append(raw_routes)
    return seed_pool, dict(best_meta)


def _evaluate_stream_result(
    stream: str,
    request: FleetOptimizationRequest,
    plan: FleetOptimizationResponse,
    *,
    random_seed: int,
    budget: float,
    solve_wall_seconds: float,
    cpu_seconds: float,
    seed_meta: Dict[str, Any],
    cycle_metrics: Optional[dict[str, int | float]] = None,
) -> Dict[str, Any]:
    audit_started = time.perf_counter()
    audit = audit_solution(request, plan, is_raw_hybrid=False)
    qual = audited_quality({
        "case": request.job_id,
        "algorithm": stream,
        "seed": random_seed,
        "budget": budget,
        **audit,
    })
    audited_wall_seconds = solve_wall_seconds + (time.perf_counter() - audit_started)
    return {
        "stream": stream,
        "response": plan,
        "quality": qual,
        "metric": {
            "quality": list(qual),
            "solve_wall_seconds": round(solve_wall_seconds, 4),
            "audited_wall_seconds": round(audited_wall_seconds, 4),
            "cpu_seconds": round(cpu_seconds, 4),
            "audit": audit,
            "seed": seed_meta,
            "load_cycle_cache": cycle_metrics,
        },
        "seed_meta": seed_meta,
    }


def _adaptive_polish_reserve(
    remaining: float,
    request: FleetOptimizationRequest,
    packing_intensity: float,
    *,
    has_ortools_seed: bool = False,
) -> float:
    """Scale reserve between initial search and post-audit polish by problem and budget."""
    if has_ortools_seed:
        # Warm OR-Tools seeds still benefit from ~78-80% search time to escape route counts,
        # while keeping enough reserve for post-audit multi-step consolidation and cross-route exchange.
        polish_share = max(0.18, 0.22 - 0.03 * packing_intensity)
        return min(remaining * 0.25, max(1.6, min(4.5, remaining * polish_share)))
    polish_share = max(0.29, 0.34 - 0.05 * packing_intensity)
    size_cap = max(
        3.5,
        1.2 + 0.14 * len(request.orders) + 0.03 * len(request.vehicles),
    )
    scaled_cap = max(size_cap, remaining * polish_share)
    min_floor = min(remaining * 0.30, max(1.2, 1.0 + 0.8 * (1.0 - packing_intensity)))
    return min(
        remaining * 0.40,
        max(min_floor, min(scaled_cap, remaining * polish_share)),
    )


def _measured_polish_deadlines(
    publish_deadline: float,
    eval_seconds: float,
) -> tuple[float, float, float]:
    """Derive polish/exit deadlines from measured audit+serialize runtime."""
    rem = max(0.0, publish_deadline - time.perf_counter())
    eval_margin = max(0.45, min(rem * 0.35, eval_seconds * 2.2 + 0.28))
    polish_deadline = publish_deadline - eval_margin
    validation_deadline = polish_deadline + min(0.15, eval_margin * 0.30)
    refine_eval_guard = max(0.08, min(rem * 0.20, eval_seconds * 1.15))
    return polish_deadline, validation_deadline, refine_eval_guard


def _run_portfolio_worker(task: Dict[str, Any]) -> Dict[str, Any]:
    """Execute one independent optimization trajectory in a warm worker process."""
    worker_started = time.perf_counter()
    cpu_started = time.process_time()
    request = FleetOptimizationRequest.model_validate(task["request_dict"])
    audit_request_dict = task.get("audit_request_dict")
    audit_request = (
        FleetOptimizationRequest.model_validate(audit_request_dict)
        if audit_request_dict is not None else request
    )
    deadline = float(task["deadline"])
    use_ortools_seed = bool(task["use_ortools_seed"])
    seed_pool: List[List[List[ScheduledStop]]] = []
    seed_meta: Dict[str, Any] = {
        "seed_seconds": 0.0,
        "seed_strategy": None,
        "seed_routes": 0,
        "seed_served_orders": 0,
    }

    remaining = deadline - time.perf_counter()
    packing_intensity = request_packing_intensity(request)
    if use_ortools_seed and remaining >= 2.5 and packing_intensity < 0.75:
        seed_pool, seed_meta = _extract_diverse_ortools_seeds(
            request,
            remaining_seconds=remaining,
        )
        remaining = deadline - time.perf_counter()

    if remaining <= 0.0:
        raise TimeoutError("Worker budget elapsed before Hybrid ALNS could start.")
    worker_random_seed = int(task["random_seed"])
    warm_sa_fraction = float(task["warm_sa_fraction"])
    sa_construction_fraction = float(task["sa_construction_fraction"])
    if use_ortools_seed and not seed_pool:
        worker_random_seed += 4
        warm_sa_fraction = max(warm_sa_fraction, 0.18)
        sa_construction_fraction = 0.55
    optimizer = VariantHybridALNSOptimizer(
        request,
        ortools_seed_pool=seed_pool,
        max_iterations=int(task["max_iterations"]),
        time_budget_seconds=remaining,
        random_seed=worker_random_seed,
        include_benchmarks=bool(task["include_benchmarks"]),
        cache_load_cycles=bool(task.get("cache_load_cycles", True)),
        audit_request=audit_request,
        warm_sa_fraction=warm_sa_fraction,
        sa_construction_fraction=sa_construction_fraction,
        enable_portfolio=False,
    )
    def evaluate(plan: FleetOptimizationResponse) -> dict[str, Any]:
        evaluated = _evaluate_stream_result(
            str(task["stream"]), audit_request, plan,
            random_seed=worker_random_seed,
            budget=remaining,
            solve_wall_seconds=time.perf_counter() - worker_started,
            cpu_seconds=time.process_time() - cpu_started,
            seed_meta=seed_meta,
            cycle_metrics=optimizer._load_cycle_metrics(),
        )
        evaluated["response_dict"] = evaluated.pop("response").model_dump(mode="json")
        if task.get("cache_load_cycles", False):
            evaluated["metric"]["native_dynamic_placements"] = FastDynamicPackingChecker.placements_tried
        return evaluated

    checkpoint_path = task.get("checkpoint_path")
    if checkpoint_path is not None:
        publish_deadline = float(task["publish_deadline"])
        rem_initial = max(0.0, publish_deadline - time.perf_counter())
        initial_margin = max(0.25, min(0.90, rem_initial * 0.05))
        optimizer._variant_publish_deadline = publish_deadline - initial_margin
        optimizer._validation_deadline = publish_deadline - initial_margin
        optimizer._defer_vehicle_search = bool(task.get("defer_vehicle_search", False))
        has_partial_checkpoint = False
        best_checkpoint_quality = None

        def publish_if_better(evaluated: dict[str, Any]) -> None:
            nonlocal has_partial_checkpoint, best_checkpoint_quality
            quality = evaluated["quality"]
            if (
                time.perf_counter() >= publish_deadline or quality[0] != 0
                or (best_checkpoint_quality is not None and quality >= best_checkpoint_quality)
            ):
                return
            publish_checkpoint(checkpoint_path, {
                **evaluated, "metric": {**evaluated["metric"], "checkpoint": True},
            })
            has_partial_checkpoint = True
            best_checkpoint_quality = quality

        def save_incumbent(plan: FleetOptimizationResponse) -> None:
            if not plan.routes or time.perf_counter() >= publish_deadline:
                return
            if plan.unassigned_orders and has_partial_checkpoint:
                return
            publish_if_better(evaluate(plan))

        optimizer._checkpoint_callback = save_incumbent
    with _fast_packing_context(
        bool(task.get("cache_load_cycles", True)),
        optimizer._cycle_validators,
        validation_deadline=lambda: optimizer._validation_deadline,
        stacking_cache=optimizer._stacking_action_cache,
        fast_stacking_cache=optimizer._fast_stacking_cache,
    ):
        solve_deadline = deadline
        if checkpoint_path is not None:
            publish_deadline = float(task["publish_deadline"])
            rem_total = max(0.0, publish_deadline - time.perf_counter())
            if rem_total >= 3.2:
                polish_reserve = _adaptive_polish_reserve(
                    rem_total,
                    request,
                    packing_intensity,
                    has_ortools_seed=bool(seed_pool),
                )
                solve_deadline = min(deadline, publish_deadline - polish_reserve)
                optimizer._validation_deadline = max(
                    time.perf_counter() + 0.5, publish_deadline - 0.35
                )
        plan = optimizer.solve(hard_deadline=solve_deadline)
        eval_started = time.perf_counter()
        result = evaluate(plan)
        eval_sec = max(0.02, time.perf_counter() - eval_started)
        if checkpoint_path is not None:
            publish_if_better(result)
            optimizer._defer_vehicle_search = False
            rem_after_solve = max(0.0, publish_deadline - time.perf_counter())
            polish_deadline, val_deadline, refine_eval_guard = _measured_polish_deadlines(
                publish_deadline, eval_sec
            )
            optimizer._validation_deadline = val_deadline
            min_polish_slice = min(0.20, max(0.08, rem_after_solve * 0.25))
            if _can_polish_audited_result(
                result, plan, polish_deadline, min_polish_slice
            ):
                optimizer._polish_improve_callback = (
                    lambda improved: (
                        publish_if_better(evaluate(improved))
                        if time.perf_counter() + min(0.15, refine_eval_guard) < publish_deadline
                        else None
                    )
                )
                try:
                    refined = optimizer._polish_audited_response(plan, polish_deadline)
                finally:
                    optimizer._polish_improve_callback = None
                if (
                    refined is not plan
                    and time.perf_counter() + min(0.06, eval_sec + 0.02) < publish_deadline
                ):
                    refined_result = evaluate(refined)
                    if refined_result["quality"] < result["quality"]:
                        publish_if_better(refined_result)
                        return refined_result
        return result


def _can_polish_audited_result(
    result: Dict[str, Any],
    plan: FleetOptimizationResponse,
    polish_deadline: float,
    min_polish_slice: float,
) -> bool:
    """Return True when a valid routed plan (full or partial) has polish budget left."""
    audit = (result.get("metric") or {}).get("audit") or {}
    has_routed_work = bool(plan.routes) or bool(audit.get("complete_manifest"))
    return (
        has_routed_work
        and result["quality"][0] == 0
        and time.perf_counter() + min_polish_slice < polish_deadline
    )


class VariantHybridALNSOptimizer(PackingAwareHybridALNSOptimizer):
    """Packing-aware Hybrid ALNS backed by a general 3-trajectory portfolio."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        *,
        ortools_seed_pool: Sequence[List[List[ScheduledStop]]] = (),
        max_iterations: int = 800,
        time_budget_seconds: Optional[float] = None,
        random_seed: int = 0,
        include_benchmarks: bool = False,
        warm_sa_fraction: float = 0.0,
        sa_construction_fraction: float = 0.45,
        enable_portfolio: bool = True,
        cache_load_cycles: bool = True,
        audit_request: Optional[FleetOptimizationRequest] = None,
        stop_at_budget: bool = False,
    ) -> None:
        super().__init__(
            request,
            max_iterations=max_iterations,
            time_budget_seconds=time_budget_seconds,
            random_seed=random_seed,
            initial_plan=None,
            include_benchmarks=include_benchmarks,
            ortools_seed_pool=ortools_seed_pool,
        )
        self._requested_time_budget_seconds = (
            float(time_budget_seconds) if time_budget_seconds is not None else None
        )
        self.warm_sa_fraction = max(0.0, min(0.75, float(warm_sa_fraction)))
        self.sa_construction_fraction = max(
            0.05,
            min(0.95, float(sa_construction_fraction)),
        )
        self.enable_portfolio = bool(enable_portfolio)
        self._cache_load_cycles = cache_load_cycles
        if audit_request is not None:
            self.objective_request = audit_request
        self._raw_policy = self.policy
        op_late_daily = operational_late_daily_weight_vnd(self.objective_request)
        if self.policy.late_delivery_penalty_mode == "NONE" and op_late_daily > 0:
            self._search_policy = self.policy.model_copy(
                update={
                    "late_delivery_penalty_mode": "FIXED_PER_DAY",
                    "late_delivery_penalty_value": float(op_late_daily),
                }
            )
        else:
            self._search_policy = self.policy
        self._stop_at_budget = stop_at_budget
        self._allow_layout_search = True
        self._checkpoint_callback: Optional[Callable[[FleetOptimizationResponse], None]] = None
        self._polish_improve_callback: Optional[Callable[[FleetOptimizationResponse], None]] = None
        self._validation_deadline: Optional[float] = None
        self._variant_publish_deadline: Optional[float] = None
        self._defer_vehicle_search = False
        self._candidate_rank_cache: dict[tuple, tuple[int, ...]] = {}
        self._route_schedule_cache: dict[tuple, Optional[list[ScheduledStop]]] = {}
        self._route_eval_cache: dict[tuple, tuple[int, float]] = {}
        self._eval_nodes: list[dict[str, str]] = (
            [{"id": v.depot.id} for v in self.vehicles]
            + [
                loc
                for o in self.orders
                for loc in ({"id": o.pickup_location.id}, {"id": o.delivery_location.id})
            ]
        )
        self._cycle_validators: dict[
            tuple[float, float, float, float, str, Optional[float]],
            CycleCachingSpatialValidator,
        ] = {}
        self._stacking_action_cache: StackingActionCache = {}
        self._fast_stacking_cache: FastStackingCache = {}
        self._variant_audit_deadline: Optional[float] = None
        self._seed_meta: Dict[str, Any] = {
            "seed_seconds": 0.0,
            "seed_strategy": None,
            "seed_routes": 0,
            "seed_served_orders": 0,
            "portfolio_streams": [],
            "winner_stream": None,
            "stream_metrics": {},
            "worker_errors": [],
        }

    @contextlib.contextmanager
    def _raw_policy_context(self):
        prev = self.policy
        self.policy = self._raw_policy
        try:
            yield
        finally:
            self.policy = prev

    def _build_final_response(
        self,
        routes_stops: list[list[ScheduledStop]],
        unassigned_ids: list[str],
        *,
        include_benchmarks: bool = True,
        spatial_time_budget_seconds: Optional[float] = None,
    ) -> FleetOptimizationResponse:
        if self._validation_deadline is not None:
            rem_val = max(0.15, self._validation_deadline - time.perf_counter())
            spatial_time_budget_seconds = (
                rem_val
                if spatial_time_budget_seconds is None
                else min(spatial_time_budget_seconds, rem_val)
            )
        with self._raw_policy_context():
            response = super()._build_final_response(
                routes_stops, unassigned_ids, include_benchmarks=include_benchmarks,
                spatial_time_budget_seconds=spatial_time_budget_seconds,
            )
        if self._checkpoint_callback is not None:
            self._checkpoint_callback(response)
        return response

    def _validate_spatial_actions(
        self,
        vehicle_index: int,
        actions: list[StopAction],
        max_time_seconds: Optional[float] = None,
    ) -> SpatialValidationResult:
        max_time_seconds = _remaining_validation_budget(max_time_seconds, self._validation_deadline)
        if not self._cache_load_cycles:
            return super()._validate_spatial_actions(vehicle_index, actions, max_time_seconds)
        vehicle = self.vehicles[vehicle_index]
        if self.request.demo_stacking is not None:
            raw_fn = (
                _RAW_VALIDATE_STOP_ACTIONS
                if getattr(stacking.validate_stop_actions, "_is_variant_cache_wrapper", False) is True
                else stacking.validate_stop_actions
            )
            return _cached_stacking_validate(
                raw_fn,
                self._stacking_action_cache,
                self.request.demo_stacking,
                vehicle,
                actions,
                max_search_nodes=_DEFAULT_MAX_SEARCH_NODES,
                max_time_seconds=6.0 if max_time_seconds is None else max_time_seconds,
            )
        geometry = (
            vehicle.length_cm, vehicle.width_cm, vehicle.height_cm,
            vehicle.payload_limit_kg, vehicle.door_position, vehicle.door_width_cm,
        )
        validator = self._cycle_validators.get(geometry)
        if validator is None:
            floor = VehicleFloor.model_validate(
                vehicle.model_dump(include=set(VehicleFloor.model_fields))
            )
            validator = CycleCachingSpatialValidator(floor, use_uniform_layout=True)
            self._cycle_validators[geometry] = validator
        validator.max_search_nodes = _DEFAULT_MAX_SEARCH_NODES
        validator.max_time_seconds = 6.0 if max_time_seconds is None else max_time_seconds
        return validator.validate_plan(actions)

    def _default_budget_seconds(self) -> float:
        return max(
            1.0,
            float(
                self._requested_time_budget_seconds
                if self._requested_time_budget_seconds is not None
                else (
                    self.request.search_time_seconds
                    or self.request.max_time_seconds
                    or 15.0
                )
            ),
        )

    def _load_cycle_metrics(self) -> Optional[dict[str, int | float]]:
        if not self._cache_load_cycles:
            return None
        validators = self._cycle_validators.values()
        return {
            "hits": sum(validator.cache_hits for validator in validators),
            "uniform_certificates": sum(validator.uniform_certificates for validator in validators),
            "exact_searches": sum(validator.exact_searches for validator in validators),
            "exact_search_seconds": round(sum(
                validator.exact_search_seconds for validator in validators
            ), 4),
        }

    def _rank_candidate_for_audit(
        self, routes: list[list[ScheduledStop]], unassigned: list[str],
    ) -> tuple[int, ...]:
        if not self._cache_load_cycles:
            with self._raw_policy_context():
                return super()._rank_candidate_for_audit(routes, unassigned)
        key = (self._state_signature(routes), tuple(sorted(set(unassigned))))
        rank = self._candidate_rank_cache.get(key)
        if rank is None:
            with self._raw_policy_context():
                rank = super()._rank_candidate_for_audit(routes, unassigned)
            if len(self._candidate_rank_cache) >= 4096:
                del self._candidate_rank_cache[next(iter(self._candidate_rank_cache))]
            self._candidate_rank_cache[key] = rank
        return rank

    def _scheduled_route_economic_entry(
        self, v_idx: int, stops: List[ScheduledStop],
    ) -> Optional[Tuple[int, float]]:
        """Return cached (route_economic_vnd, dist_km) using exact edge-weighted route metrics."""
        sig = route_stop_signature(stops)
        key = (v_idx, sig)
        cached = self._route_eval_cache.get(key)
        if cached is not None:
            return cached

        scheduled_stops = self._route_schedule_cache.get(key)
        if key not in self._route_schedule_cache:
            scheduled = self._schedule_stops(v_idx, list(stops))
            scheduled_stops = scheduled[0] if scheduled is not None else None
            if len(self._route_schedule_cache) >= 8192:
                self._route_schedule_cache.clear()
            self._route_schedule_cache[key] = scheduled_stops
        if scheduled_stops is None:
            return None

        v = self.vehicles[v_idx]
        weight = 0.0
        for st in scheduled_stops:
            oid = getattr(st, "allocation_id", None) or getattr(st, "order_id", None)
            ord_pair = self.order_by_id.get(oid) if oid else None
            if ord_pair is not None:
                if getattr(st, "stop_type", "") == "PICKUP":
                    weight += ord_pair.total_weight_kg
                elif getattr(st, "stop_type", "") == "DELIVERY":
                    weight = max(0.0, weight - ord_pair.total_weight_kg)
            st.current_weight_kg = max(0.0, weight)

        base, surcharge, holding, _, _ = calculate_route_economic_metrics(
            self.request, self._eval_nodes, self.order_by_id, v, scheduled_stops,
        )
        dist_km = self._calc_route_distance_km(v_idx, scheduled_stops)
        driver_est = 150_000 + round(1_200 * dist_km)
        entry = (
            base + surcharge + holding + v.fixed_operating_cost_vnd + driver_est,
            dist_km,
        )
        if len(self._route_eval_cache) >= 8192:
            self._route_eval_cache.clear()
        self._route_eval_cache[key] = entry
        return entry

    def _evaluate_plan_cost(
        self, routes_stops: List[List[ScheduledStop]], unassigned_ids: List[str],
    ) -> Tuple[int, int, float]:
        total_economic = 0
        total_km = 0.0
        active_routes = 0
        max_span_day = 0

        for v_idx, stops in enumerate(routes_stops):
            if not stops:
                continue
            active_routes += 1
            day_idx = self.vehicles[v_idx].service_day_index + 1
            if day_idx > max_span_day:
                max_span_day = day_idx
            cached = self._scheduled_route_economic_entry(v_idx, stops)
            if cached is not None:
                route_econ, dist_km = cached
            else:
                # Fallback for intermediate unschedulable stop lists during search.
                fallback_routes = [[] for _ in self.vehicles]
                fallback_routes[v_idx] = stops
                _, fallback_econ, dist_km = PackingAwareHybridALNSOptimizer._evaluate_plan_cost(
                    self, fallback_routes, []
                )
                route_econ = fallback_econ
                if day_idx > 1:
                    obj_req = getattr(self, "objective_request", getattr(self, "request", None))
                    if obj_req is not None:
                        route_econ -= max(
                            0,
                            calendar_salary_for_span(obj_req, day_idx)
                            - calendar_salary_for_span(obj_req, 1),
                        )
            total_economic += route_econ
            total_km += dist_km

        if max_span_day > 1:
            obj_req = getattr(self, "objective_request", getattr(self, "request", None))
            if obj_req is not None:
                total_economic += max(
                    0,
                    calendar_salary_for_span(obj_req, max_span_day)
                    - calendar_salary_for_span(obj_req, 1),
                )

        op_late = plan_operational_lateness_vnd(self, routes_stops)
        economic = total_economic + op_late
        penalized = (
            economic
            + len(unassigned_ids) * self.policy.unassigned_order_penalty_vnd
            + active_routes * 1_000_000
        )
        return penalized, economic, total_km

    def _calc_route_load_surcharge_vnd(
        self, v_idx: int, stops: Sequence[ScheduledStop]
    ) -> float:
        vehicle = self.vehicles[v_idx]
        surcharge_pct = float(
            getattr(vehicle, "load_fuel_surcharge_percent_at_full_payload", 0.0) or 0.0
        )
        if not stops or surcharge_pct <= 0.0 or vehicle.payload_limit_kg <= 0.0:
            return 0.0
        dist_mat = self.request.distance_matrix_meters
        node_idx_map = self.order_node_indices
        weights = self._order_weight_by_id
        factor = (
            float(vehicle.fuel_consumption_liters_per_100_km)
            / 100_000.0
            * surcharge_pct
            / 100.0
            * float(self.policy.fuel_price_per_liter_vnd)
        )
        payload_lim = float(vehicle.payload_limit_kg)
        prev = v_idx
        onboard_w = 0.0
        total = 0.0
        for st in stops:
            oid = st.allocation_id or st.order_id or ""
            indices = node_idx_map.get(oid) if node_idx_map is not None else None
            cur = (
                (indices[0] if st.stop_type == "PICKUP" else indices[1])
                if indices is not None
                else self._stop_node_index(st)
            )
            if cur is None:
                continue
            if onboard_w > 0.0:
                total += dist_mat[prev][cur] * factor * min(1.0, onboard_w / payload_lim)
            w = weights.get(oid, 0.0)
            onboard_w = onboard_w + w if st.stop_type == "PICKUP" else max(0.0, onboard_w - w)
            prev = cur
        return total

    def _candidate_insertions(
        self,
        routes: List[List[ScheduledStop]],
        order,
        deadline: float,
        excluded_vehicle_indices=None,
        eligible_vehicle_indices=None,
        limit: int = 3,
    ):
        use_late = self._search_policy.late_delivery_penalty_mode != "NONE"
        quick_candidates = []
        excluded = excluded_vehicle_indices or set()
        checked_empty_profiles = set()
        existing_span = max(
            (self.vehicles[index].service_day_index + 1 for index, route in enumerate(routes) if route),
            default=0,
        )
        calendar_by_span = {
            existing_span: calendar_salary_for_span(self.objective_request, existing_span)
        }
        vehicle_indices = (
            list(eligible_vehicle_indices)
            if eligible_vehicle_indices is not None
            else list(range(len(routes)))
        )
        for vehicle_index in vehicle_indices:
            current_stops = routes[vehicle_index]
            if time.perf_counter() >= deadline:
                break
            if vehicle_index in excluded:
                continue
            vehicle = self.vehicles[vehicle_index]
            if not self._order_allows_vehicle(order, vehicle):
                continue
            span = max(existing_span, vehicle.service_day_index + 1)
            if span not in calendar_by_span:
                calendar_by_span[span] = calendar_salary_for_span(self.objective_request, span)
            calendar_extension = calendar_by_span[span] - calendar_by_span[existing_span]
            if not current_stops:
                max_routes = getattr(self.request.policy, "max_routes_per_day", None)
                if (
                    max_routes is not None
                    and sum(
                        1
                        for idx, route in enumerate(routes)
                        if route and self.vehicles[idx].service_day_index == vehicle.service_day_index
                    )
                    >= max_routes
                ):
                    continue
                profile = (
                    vehicle.source_vehicle_id or vehicle.id,
                    vehicle.service_day_index,
                    vehicle.payload_limit_kg,
                    vehicle.length_cm,
                    vehicle.width_cm,
                    vehicle.height_cm,
                    vehicle.depot.id,
                )
                if profile in checked_empty_profiles:
                    continue
                checked_empty_profiles.add(profile)

            base_distance = self._calc_route_distance_km(vehicle_index, current_stops)
            base_surcharge = self._calc_route_load_surcharge_vnd(vehicle_index, current_stops)
            base_late = (
                route_operational_lateness_vnd(
                    self.order_by_id, self._search_policy, current_stops
                )
                if use_late
                else 0
            )
            source_order_id = order.source_order_id or order.id
            shares_source_order = any(
                (
                    self.order_by_id[stop.allocation_id or stop.order_id].source_order_id
                    or self.order_by_id[stop.allocation_id or stop.order_id].id
                ) == source_order_id
                for stop in current_stops
                if (stop.allocation_id or stop.order_id) in self.order_by_id
            )
            for pickup_position, delivery_position in self._insertion_positions(len(current_stops)):
                if time.perf_counter() >= deadline:
                    break
                feasible, candidate_stops = self._can_insert_order(
                    vehicle_index,
                    current_stops,
                    order,
                    pickup_position,
                    delivery_position,
                    check_packing=False,
                )
                if not feasible:
                    continue
                candidate_distance = self._calc_route_distance_km(vehicle_index, candidate_stops)
                incremental_distance = candidate_distance - base_distance
                cand_surcharge = self._calc_route_load_surcharge_vnd(vehicle_index, candidate_stops)
                candidate_late = (
                    route_operational_lateness_vnd(
                        self.order_by_id, self._search_policy, candidate_stops
                    )
                    if use_late
                    else 0
                )
                incremental_cost = (
                    vehicle.fuel_consumption_liters_per_100_km
                    / 100.0
                    * incremental_distance
                    * self.policy.fuel_price_per_liter_vnd
                    + (cand_surcharge - base_surcharge)
                    + (vehicle.fixed_operating_cost_vnd if not current_stops else 0)
                    + (150_000 if not current_stops else 0)
                    + round(1_200 * incremental_distance)
                    - (50_000 if shares_source_order else 0)
                    + calendar_extension
                    + (candidate_late - base_late)
                )
                quick_candidates.append((incremental_cost, vehicle_index, candidate_stops))

        quick_candidates.sort(key=lambda candidate: candidate[0])
        candidates = []
        for candidate in quick_candidates:
            _, vehicle_index, candidate_stops = candidate
            if time.perf_counter() >= deadline:
                break
            if not self._validate_stops_cached(vehicle_index, candidate_stops):
                continue
            candidates.append(candidate)
            if len(candidates) >= limit:
                break
        return candidates

    def _try_vehicle_reassignment(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
    ):
        if self._defer_vehicle_search:
            return None
        deadline = (
            self._variant_audit_deadline
            if self._variant_audit_deadline is not None
            else time.perf_counter() + 1.5
        )
        if time.perf_counter() >= deadline:
            return None
        return bounded_vehicle_reassignment(self, routes, unassigned, deadline)

    def _optimize_production_vehicles(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
    ):
        if self._defer_vehicle_search:
            return None
        deadline = (
            self._variant_audit_deadline
            if self._variant_audit_deadline is not None
            else time.perf_counter() + 2.0
        )
        if time.perf_counter() >= deadline:
            return None
        return bounded_optimize_production_vehicles(self, routes, unassigned, deadline)

    def _base_polish_audited_response(
        self, response: FleetOptimizationResponse, deadline: float,
    ) -> FleetOptimizationResponse:
        return super()._polish_audited_response(response, deadline)

    def _polish_audited_response(
        self, response: FleetOptimizationResponse, deadline: float,
    ) -> FleetOptimizationResponse:
        prev_policy = self.policy
        prev_audit_deadline = self._variant_audit_deadline
        prev_layout_search = getattr(self, "_allow_layout_search", True)
        self.policy = self._search_policy
        self._variant_audit_deadline = deadline
        self._allow_layout_search = True
        try:
            now = time.perf_counter()
            if now >= deadline:
                return response
            if self._defer_vehicle_search:
                return response
            best = response
            rem_polish = max(0.0, deadline - now)
            min_slice = min(0.20, max(0.08, rem_polish * 0.12))

            def _toggle_layout(enabled: bool) -> None:
                self._allow_layout_search = enabled

            if time.perf_counter() + min_slice < deadline:
                best = spare_budget_lns_polish(
                    self,
                    best,
                    deadline,
                    allow_layout_toggle=_toggle_layout,
                    on_improve=self._polish_improve_callback,
                )
            return best
        finally:
            self.policy = prev_policy
            self._variant_audit_deadline = prev_audit_deadline
            self._allow_layout_search = prev_layout_search

    def _build_hybrid_initial_solution(
        self,
        vehicles,
        drivers,
        original_vehicle_indices,
        pickup_key_by_order,
        delivery_key_by_order,
        search_deadline: Optional[float] = None,
    ) -> OptimizationSolution:
        now = time.perf_counter()
        effective_deadline = (
            search_deadline
            if search_deadline is not None
            else now + self._default_budget_seconds()
        )
        total_remaining = max(0.0, effective_deadline - now)
        if self.warm_sa_fraction <= 0.0 or not hasattr(self, "_hybrid_model_context"):
            capped_deadline = effective_deadline
            if total_remaining >= 2.5 and not self._ortools_seed_pool:
                share = 0.22
                base_cap = 2.2
                min_cap = min(total_remaining * 0.35, 0.8)
                max_cap = max(base_cap, total_remaining * share)
                cap_sec = min(
                    total_remaining * 0.35,
                    min(max_cap, max(min_cap, total_remaining * share)),
                )
                capped_deadline = min(effective_deadline, now + cap_sec)
            chosen = super()._build_hybrid_initial_solution(
                vehicles,
                drivers,
                original_vehicle_indices,
                pickup_key_by_order,
                delivery_key_by_order,
                search_deadline=capped_deadline,
            )
            if (effective_deadline - time.perf_counter()) >= 0.4:
                self._native_search_budget_available = True
            return chosen
        base_budget = min(4.0, max(1.2, total_remaining * 0.18))
        base_deadline = min(effective_deadline, now + base_budget)
        base_initial = super()._build_hybrid_initial_solution(
            vehicles,
            drivers,
            original_vehicle_indices,
            pickup_key_by_order,
            delivery_key_by_order,
            search_deadline=base_deadline,
        )

        remaining_after_base = max(0.0, effective_deadline - time.perf_counter())
        # Reserve substantial search time for native Hybrid ALNS refinement after SA.
        min_alns_reserve = max(1.5, remaining_after_base * (1.0 - self.warm_sa_fraction))
        sa_slice = max(
            0.0,
            min(
                remaining_after_base * self.warm_sa_fraction,
                remaining_after_base - min_alns_reserve,
            ),
        )
        if remaining_after_base < 2.2 or sa_slice < 1.2:
            self._native_search_budget_available = (
                effective_deadline - time.perf_counter()
            ) >= 0.4
            return base_initial

        orders, policy, node_id_to_index = self._hybrid_model_context
        sa_loop_sec = max(0.4, sa_slice * 0.68)
        sa_spatial_sec = max(0.20, sa_slice * 0.14)
        sa_repair_sec = max(0.25, sa_slice * 0.18)
        sa_solution = solve_simulated_annealing(
            vehicles,
            drivers,
            orders,
            policy,
            self.request.distance_matrix_meters,
            self.request.duration_matrix_seconds,
            node_id_to_index,
            time_limit_sec=sa_loop_sec,
            random_seed=self.random_seed,
            final_spatial_time_limit_sec=sa_spatial_sec,
            final_repair_time_limit_sec=sa_repair_sec,
            initial_solution=base_initial,
            construction_fraction=self.sa_construction_fraction,
        )
        chosen = base_initial
        if (
            sa_solution.solution_audited
            and sa_solution.is_contract_valid
            and sa_solution.is_temporally_valid
            and sa_solution.is_spatial_valid
            and (
                base_initial is None
                or not base_initial.is_spatial_valid
                or solution_key(sa_solution, orders) <= solution_key(base_initial, orders)
            )
        ):
            chosen = sa_solution
        if chosen is not None and not chosen.unassigned_orders:
            self._construction_audit_fallback = None
        # Partial base construction under a short warm-start slice must not lock out
        # subsequent Hybrid ALNS iterations when portfolio search time still remains.
        self._native_search_budget_available = (
            effective_deadline - time.perf_counter()
        ) >= 0.4
        return chosen

    def _effective_budget(self, hard_deadline: Optional[float]) -> float:
        if hard_deadline is not None:
            return max(0.0, hard_deadline - time.perf_counter())
        return self._default_budget_seconds()

    def _should_use_portfolio(self, budget: float) -> bool:
        return (
            self.enable_portfolio
            and not self._ortools_seed_pool
            and multiprocessing.current_process().name == "MainProcess"
            and budget >= _MIN_PORTFOLIO_BUDGET_SECONDS
            and len(self.request.orders) >= _MIN_PORTFOLIO_ORDERS
        )

    def _worker_tasks(self, worker_deadline: float) -> List[Dict[str, Any]]:
        request_dict = self.request.model_dump()
        common = {
            "request_dict": request_dict,
            "deadline": worker_deadline,
            "max_iterations": self.max_iterations,
            "include_benchmarks": False,
            "cache_load_cycles": self._cache_load_cycles,
        }
        if self.objective_request is not self.request:
            common["audit_request_dict"] = self.objective_request.model_dump()
        return [
            {
                **common,
                "stream": "ortools-alns",
                "defer_vehicle_search": True,
                "random_seed": self.random_seed,
                "use_ortools_seed": True,
                "warm_sa_fraction": 0.0,
                "sa_construction_fraction": 0.45,
            },
            {
                **common,
                "stream": "adaptive-sa-alns",
                "defer_vehicle_search": True,
                "random_seed": self.random_seed + 2,
                "use_ortools_seed": False,
                "warm_sa_fraction": 0.32,
                "sa_construction_fraction": 0.45,
            },
            {
                **common,
                "stream": "diversified-sa-alns",
                "defer_vehicle_search": True,
                "random_seed": self.random_seed + 3,
                "use_ortools_seed": False,
                "warm_sa_fraction": 0.42,
                "sa_construction_fraction": 0.80,
            },
        ]

    def solve(self, hard_deadline: Optional[float] = None) -> FleetOptimizationResponse:
        self._candidate_rank_cache.clear()
        total_budget = self._effective_budget(hard_deadline)
        solve_started = time.perf_counter()
        self._post_audit_budget_sec = max(
            self._post_audit_budget_sec, min(1.25, total_budget * 0.10)
        )
        packing_intensity = request_packing_intensity(self.request)
        relax_dense_deadline = (
            self.enable_portfolio
            and not self._stop_at_budget
            and packing_intensity >= 0.65
            and total_budget >= 3.0
        )
        parent_hard_deadline = (
            None
            if (hard_deadline is None or relax_dense_deadline)
            else hard_deadline
        )
        base_audit_deadline = (
            None
            if parent_hard_deadline is None
            else solve_started + total_budget + min(2.5, max(0.5, total_budget * 0.15))
        )
        if self._variant_publish_deadline is not None:
            base_audit_deadline = (
                self._variant_publish_deadline
                if base_audit_deadline is None
                else min(base_audit_deadline, self._variant_publish_deadline)
            )
        self._variant_audit_deadline = base_audit_deadline
        effective_portfolio_deadline = (
            hard_deadline
            if hard_deadline is not None
            else solve_started + total_budget
        )
        if (
            self._stop_at_budget and self.enable_portfolio
            and multiprocessing.current_process().name == "MainProcess"
        ):
            if (
                len(self.request.orders) >= _MIN_PORTFOLIO_ORDERS
                and total_budget >= _MIN_TIMED_SPAWN_BUDGET_SECONDS
            ):
                return self._solve_timed_portfolio(effective_portfolio_deadline)
            return self._solve_in_process_timed(effective_portfolio_deadline)

        if not self._should_use_portfolio(total_budget):
            self._seed_meta = {
                "seed_seconds": 0.0,
                "seed_strategy": None,
                "seed_routes": 0,
                "seed_served_orders": 0,
                "portfolio_streams": ["direct-single"],
                "winner_stream": "direct-single",
                "stream_metrics": {},
                "worker_errors": [],
            }
            with _fast_packing_context(
                self._cache_load_cycles,
                self._cycle_validators,
                stacking_cache=self._stacking_action_cache,
                fast_stacking_cache=self._fast_stacking_cache,
            ):
                self.policy = self._search_policy
                try:
                    return super().solve(hard_deadline=parent_hard_deadline)
                finally:
                    self.policy = self._raw_policy

        tasks = self._worker_tasks(effective_portfolio_deadline - 0.15)
        futures: List[concurrent.futures.Future] = []
        pool_failed = False
        worker_errors: List[str] = []

        try:
            executor = _get_portfolio_executor()
            futures = [executor.submit(_run_portfolio_worker, task) for task in tasks]
        except (OSError, PermissionError, NotImplementedError, BrokenProcessPool) as exc:
            worker_errors.append(f"pool_submit: {exc}")
            _reset_portfolio_executor()
            pool_failed = True

        parent_started = time.perf_counter()
        parent_cpu_started = time.process_time()
        with _fast_packing_context(
            self._cache_load_cycles,
            self._cycle_validators,
            stacking_cache=self._stacking_action_cache,
            fast_stacking_cache=self._fast_stacking_cache,
        ):
            self.policy = self._search_policy
            try:
                parent_response = super().solve(hard_deadline=parent_hard_deadline)
            finally:
                self.policy = self._raw_policy
        apply_planning_objective(self.objective_request, parent_response)
        parent_eval = _evaluate_stream_result(
            "direct-alns",
            self.objective_request,
            parent_response,
            random_seed=self.random_seed,
            budget=total_budget,
            solve_wall_seconds=time.perf_counter() - parent_started,
            cpu_seconds=time.process_time() - parent_cpu_started,
            seed_meta={
                "seed_seconds": 0.0,
                "seed_strategy": None,
                "seed_routes": 0,
                "seed_served_orders": 0,
            },
            cycle_metrics=self._load_cycle_metrics(),
        )
        evaluations: List[Dict[str, Any]] = [parent_eval]

        if not pool_failed and futures:
            for future in concurrent.futures.as_completed(futures):
                try:
                    payload = future.result()
                except BrokenProcessPool as exc:
                    worker_errors.append(f"pool_broken: {exc}")
                    _reset_portfolio_executor()
                    continue
                except Exception as exc:
                    worker_errors.append(f"worker_error: {exc}")
                    continue
                payload["response"] = FleetOptimizationResponse.model_validate(
                    payload.pop("response_dict")
                )
                apply_planning_objective(self.objective_request, payload["response"])
                evaluations.append(payload)
                if payload["stream"] == "ortools-alns":
                    self._seed_meta.update(dict(payload["seed_meta"]))

        return self._select_evaluation(evaluations, worker_errors)

    def _status_fallback_response(
        self,
        status: str,
        diagnostics: list[str],
    ) -> FleetOptimizationResponse:
        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status=status,
            unassigned_orders=[
                UnassignedOrder(
                    order_id=order.id,
                    order_number=order.order_number or order.id,
                    reason_code=status,
                    reason_message="Chưa có phương án được kiểm chứng.",
                )
                for order in self.request.orders
            ],
            diagnostics=diagnostics,
        )

    def _solve_in_process_timed(self, deadline: float) -> FleetOptimizationResponse:
        """Execute timed optimization in-process when spawning workers would starve budget or for small instances."""
        started = time.perf_counter()
        cpu_started = time.process_time()
        remaining = max(0.0, deadline - started)
        if remaining <= 0.0:
            self._seed_meta["worker_errors"] = ["budget_elapsed"]
            return self._status_fallback_response("TIMEOUT", ["budget_elapsed"])

        seed_meta: Dict[str, Any] = {
            "seed_seconds": 0.0,
            "seed_strategy": None,
            "seed_routes": 0,
            "seed_served_orders": 0,
        }
        prev_policy = self.policy
        prev_seed_pool = self._ortools_seed_pool
        prev_warm_sa = self.warm_sa_fraction
        prev_sa_const = self.sa_construction_fraction
        prev_val_deadline = self._validation_deadline
        prev_pub_deadline = self._variant_publish_deadline
        prev_audit_deadline = self._variant_audit_deadline
        prev_defer_vehicle = self._defer_vehicle_search
        try:
            publish_guard = max(0.15, min(0.50, remaining * 0.06))
            publish_deadline = deadline - publish_guard
            self._variant_publish_deadline = publish_deadline
            self._validation_deadline = publish_deadline
            self._variant_audit_deadline = publish_deadline
            self.policy = self._search_policy

            packing_intensity = request_packing_intensity(self.request)
            rem_now = max(0.0, publish_deadline - time.perf_counter())
            if (
                len(self.request.orders) >= _MIN_PORTFOLIO_ORDERS
                and rem_now >= 3.2
                and packing_intensity < 0.70
            ):
                seed_pool, seed_meta = _extract_diverse_ortools_seeds(
                    self.request,
                    remaining_seconds=rem_now,
                )
                if seed_pool:
                    self._ortools_seed_pool = seed_pool
                elif (publish_deadline - time.perf_counter()) >= 2.2:
                    self.warm_sa_fraction = max(prev_warm_sa, 0.25)
                    self.sa_construction_fraction = 0.55

            def evaluate_inprocess(resp: FleetOptimizationResponse) -> dict[str, Any]:
                evaluated = _evaluate_stream_result(
                    "direct-inprocess",
                    self.objective_request,
                    resp,
                    random_seed=self.random_seed,
                    budget=remaining,
                    solve_wall_seconds=time.perf_counter() - started,
                    cpu_seconds=time.process_time() - cpu_started,
                    seed_meta=seed_meta,
                    cycle_metrics=self._load_cycle_metrics(),
                )
                if self._cache_load_cycles:
                    evaluated["metric"]["native_dynamic_placements"] = (
                        FastDynamicPackingChecker.placements_tried
                    )
                return evaluated

            with _fast_packing_context(
                self._cache_load_cycles,
                self._cycle_validators,
                validation_deadline=lambda: self._validation_deadline,
                stacking_cache=self._stacking_action_cache,
                fast_stacking_cache=self._fast_stacking_cache,
            ):
                rem_for_solve = max(0.0, publish_deadline - time.perf_counter())
                defer_and_polish = (
                    rem_for_solve >= 3.0
                    and len(self.request.orders) >= _MIN_PORTFOLIO_ORDERS
                )
                self._defer_vehicle_search = defer_and_polish
                solve_deadline = publish_deadline
                if defer_and_polish:
                    polish_reserve = _adaptive_polish_reserve(
                        rem_for_solve,
                        self.request,
                        packing_intensity,
                        has_ortools_seed=bool(self._ortools_seed_pool),
                    )
                    solve_deadline = min(publish_deadline, publish_deadline - polish_reserve)
                    self._validation_deadline = max(
                        time.perf_counter() + 0.5, publish_deadline - 0.35
                    )
                plan = super().solve(hard_deadline=solve_deadline)
                eval_started = time.perf_counter()
                result = evaluate_inprocess(plan)
                eval_sec = max(0.02, time.perf_counter() - eval_started)

                if defer_and_polish:
                    self._defer_vehicle_search = False
                    rem_after_solve = max(0.0, publish_deadline - time.perf_counter())
                    polish_deadline, val_deadline, refine_eval_guard = _measured_polish_deadlines(
                        publish_deadline, eval_sec
                    )
                    self._validation_deadline = val_deadline
                    min_polish_slice = min(0.20, max(0.08, rem_after_solve * 0.25))
                    if _can_polish_audited_result(
                        result, plan, polish_deadline, min_polish_slice
                    ):
                        refined = self._polish_audited_response(plan, polish_deadline)
                        if (
                            refined is not plan
                            and time.perf_counter() + refine_eval_guard < publish_deadline
                        ):
                            refined_result = evaluate_inprocess(refined)
                            if refined_result["quality"] < result["quality"]:
                                result = refined_result

            chosen_plan = result["response"]
            apply_planning_objective(self.objective_request, chosen_plan)
            self._seed_meta.update(seed_meta)
            return self._select_evaluation([result], [])
        finally:
            self.policy = prev_policy
            self._ortools_seed_pool = prev_seed_pool
            self.warm_sa_fraction = prev_warm_sa
            self.sa_construction_fraction = prev_sa_const
            self._validation_deadline = prev_val_deadline
            self._variant_publish_deadline = prev_pub_deadline
            self._variant_audit_deadline = prev_audit_deadline
            self._defer_vehicle_search = prev_defer_vehicle

    def _solve_timed_portfolio(self, deadline: float) -> FleetOptimizationResponse:
        num_orders = len(self.request.orders)
        worker_soft_gap = min(1.0, max(0.35, 0.25 + 0.015 * num_orders))
        decode_guard = min(0.50, max(0.15, 0.08 + 0.004 * num_orders))
        tasks = self._worker_tasks(deadline - worker_soft_gap)
        direct = {
            **tasks[0],
            "stream": "direct-alns",
            "random_seed": self.random_seed,
            "use_ortools_seed": False,
            "warm_sa_fraction": 0.0,
            "sa_construction_fraction": 0.45,
            "defer_vehicle_search": True,
        }
        results, errors, timed_out = run_timed_workers(
            _run_portfolio_worker, [direct, *tasks], deadline - decode_guard,
        )
        evaluations = []
        for result in results:
            if result["quality"][0] != 0:
                errors.append(f"{result['stream']}: no valid audited plan")
                continue
            evaluations.append(result)
            if result["stream"] == "ortools-alns":
                self._seed_meta.update(result["seed_meta"])
        if evaluations:
            winner = min(evaluations, key=lambda item: item["quality"])
            response = FleetOptimizationResponse.model_validate(winner["response_dict"])
            apply_planning_objective(self.objective_request, response)
            winner["response"] = response
            return self._select_evaluation(evaluations, errors)

        status = "TIMEOUT" if timed_out else "ERROR"
        self._seed_meta["worker_errors"] = errors
        return self._status_fallback_response(status, errors)

    def _select_evaluation(
        self,
        evaluations: list[dict[str, Any]],
        worker_errors: list[str],
    ) -> FleetOptimizationResponse:
        winner = min(evaluations, key=lambda item: item["quality"])
        self._seed_meta["portfolio_streams"] = [item["stream"] for item in evaluations]
        self._seed_meta["winner_stream"] = winner["stream"]
        self._seed_meta["stream_metrics"] = {
            item["stream"]: item["metric"] for item in evaluations
        }
        self._seed_meta["worker_errors"] = worker_errors
        return winner["response"]
