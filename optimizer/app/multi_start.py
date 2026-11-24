"""Hybrid-first fleet optimization with a bounded OR-Tools fallback.

Tiny problems use exhaustive search. Larger problems spend their selected
budget on independent packing-aware Hybrid ALNS seeds, validate every result,
and invoke one OR-Tools search only when Hybrid cannot produce any route.
"""

import concurrent.futures
import math
import os
import time
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from .models import (
    BenchmarkMetric,
    FleetOptimizationBatchResponse,
    FleetOptimizationCandidate,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    OptimizedRoute,
    PlanningObjectiveBreakdown,
    ScheduledStop,
)
from .routing_solver import FleetRoutingSolver
from .request_preprocessor import (
    prune_unserviceable_virtual_resources,
    request_with_vehicle_slots,
    split_orders_within_deadline,
)
from .search_policy import AdaptiveSearchPolicy, derive_search_policy
from .search_strategies import (
    DEFAULT_SEARCH_STRATEGY,
    SEARCH_STRATEGIES,
    SearchStrategy,
    find_search_strategy,
)
from .hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from .ils_engine import PackingAwareILSOptimizer
from .cross_seed_partitioning import (
    route_pool_signature,
    solve_cross_seed_set_partitioning,
)
from .ortools_seed import extract_ortools_seed_pool
from .planning_objective import (
    apply_planning_objective,
    plan_lexicographic_key,
    plan_objective_first_key,
)
from .baseline_calculator import BaselineCostCalculator
from .spatial_cache import scoped_spatial_cache

_REAL_HYBRID_OPTIMIZER = PackingAwareHybridALNSOptimizer
_REAL_ILS_OPTIMIZER = PackingAwareILSOptimizer
# Order splitting is a reduction, not the search itself; cap its share so
# package-heavy batches still leave the solver most of the budget.
ORDER_SPLIT_BUDGET_SHARE = 0.2
DIRECT_BENCHMARK_BUDGET_SECONDS = 20.0
MAX_PARALLEL_HYBRID_SEEDS = 3


def _estimate_hybrid_lower_bound_days(request: FleetOptimizationRequest) -> int:
    """Ước lượng cận dưới số ngày tối thiểu hoàn toàn dựa trên năng lực ca và thời gian đơn hàng."""
    days = sorted({v.service_day_index for v in request.vehicles})
    if len(days) <= 1 or not request.orders:
        return len(days)
    vehicles_by_day: Dict[int, List] = {}
    for v in request.vehicles:
        vehicles_by_day.setdefault(v.service_day_index, []).append(v)
    route_limit = request.policy.max_routes_per_day
    first_day = days[0]
    first_day_vehicles = vehicles_by_day[first_day]
    if route_limit is not None:
        first_day_vehicles = sorted(
            first_day_vehicles,
            key=lambda v: v.available_end_sec - v.available_start_sec,
            reverse=True,
        )[:route_limit]
    daily_capacity_sec = max(
        1,
        sum(max(0, v.available_end_sec - v.available_start_sec) for v in first_day_vehicles),
    )
    nv = len(request.vehicles)
    dur = request.duration_matrix_seconds
    min_work_sec = 0.0
    earliest_span_needed = 1
    for i, order in enumerate(request.orders):
        p_idx = nv + 2 * i
        d_idx = p_idx + 1
        p_srv = order.pickup_service_time_sec if order.pickup_service_time_sec is not None else order.service_time_sec
        d_srv = order.delivery_service_time_sec if order.delivery_service_time_sec is not None else order.service_time_sec
        leg_sec = dur[p_idx][d_idx] if p_idx < len(dur) and d_idx < len(dur[p_idx]) else 0.0
        min_work_sec += max(0.0, p_srv + d_srv + leg_sec)
        for day in days:
            d_vs = vehicles_by_day[day]
            if any(
                (t_p := max(v.available_start_sec, order.pickup_window_start_sec))
                <= min(v.available_end_sec, order.pickup_window_end_sec)
                and (t_d := max(t_p + p_srv + leg_sec, order.delivery_window_start_sec))
                <= order.delivery_window_end_sec
                and t_d + d_srv <= v.available_end_sec
                for v in d_vs
            ):
                earliest_span_needed = max(earliest_span_needed, days.index(day) + 1)
                break
    work_lb = math.ceil(min_work_sec / daily_capacity_sec)
    return max(1, min(len(days), max(work_lb, earliest_span_needed)))


def _extract_safe_ortools_seed_pool(
    request: FleetOptimizationRequest,
    *,
    seed: int,
    available_budget: float,
    min_budget: float = 3.0,
) -> Optional[List[List[List[ScheduledStop]]]]:
    """Extract a compact OR-Tools PDPTW warm-start pool when problem shape fits fast routing."""
    max_items_per_order = max((len(o.items) for o in request.orders), default=0)
    if (
        seed % 2 != 0
        or not (2 <= len(request.orders) <= 60)
        or len(request.vehicles) > 32
        or max_items_per_order >= 20
        or available_budget < min_budget
    ):
        return None
    ortools_budget = min(1.5, available_budget * 0.15)
    extracted_pool, seed_meta = extract_ortools_seed_pool(
        request,
        routing_seconds=ortools_budget,
        stagnation_seconds=0.22,
        should_split_orders=False,
    )
    if extracted_pool and int(seed_meta.get("seed_served_orders") or 0) >= max(
        2, len(request.orders) // 2
    ):
        return extracted_pool
    return None


def _alt_route_dedup_key(route: OptimizedRoute) -> Tuple:
    cost_vnd = route.cost.total_cost_vnd if route.cost is not None else None
    return (
        route_pool_signature(route),
        cost_vnd,
        int(route.start_time_sec),
        int(route.end_time_sec),
    )


def _extract_distinct_alternative_route_dicts(
    chosen_plan: FleetOptimizationResponse,
    extra_complete_plans: Sequence[FleetOptimizationResponse],
) -> List[dict]:
    """Return deduplicated valid alternative route dicts not already on chosen_plan."""
    if not extra_complete_plans:
        return []
    seen_keys: Set[Tuple] = {
        _alt_route_dedup_key(route) for route in getattr(chosen_plan, "routes", ())
    }
    alt_route_dicts: List[dict] = []
    for alt_plan in extra_complete_plans:
        for route in getattr(alt_plan, "routes", ()):
            if not getattr(route, "stops", None):
                continue
            if route.cost is None or not (route.spatial_validation and route.spatial_validation.is_valid):
                continue
            r_key = _alt_route_dedup_key(route)
            if r_key in seen_keys:
                continue
            seen_keys.add(r_key)
            alt_route_dicts.append(route.model_dump())
    return alt_route_dicts


def _collect_worker_audited_plans(
    primary_plan: FleetOptimizationResponse,
    objective_request: FleetOptimizationRequest,
    expected_items: Dict[str, Set[str]],
    max_routes_per_day: Optional[int],
    compare_horizons: bool,
) -> Tuple[FleetOptimizationResponse, PlanningObjectiveBreakdown, List[FleetOptimizationResponse]]:
    """Select the best already-audited candidate and keep other complete audited plans."""
    alternatives = getattr(primary_plan, "_audited_alternatives", ())
    if not alternatives:
        obj = apply_planning_objective(objective_request, primary_plan)
        return primary_plan, obj, []

    pool: List[FleetOptimizationResponse] = []
    seen_ids: Set[int] = set()
    for candidate in (primary_plan, *alternatives):
        if not getattr(candidate, "routes", None) or id(candidate) in seen_ids:
            continue
        seen_ids.add(id(candidate))
        pool.append(candidate)
    if not pool:
        obj = apply_planning_objective(objective_request, primary_plan)
        return primary_plan, obj, []

    complete_pool = [
        plan
        for plan in pool
        if is_fully_served(
            plan,
            set(expected_items),
            max_routes_per_day=max_routes_per_day,
            expected_items=expected_items,
        )
    ]
    ranked_pool = complete_pool or pool
    objs = {id(plan): apply_planning_objective(objective_request, plan) for plan in ranked_pool}
    key_fn = plan_objective_first_key if compare_horizons else plan_lexicographic_key
    winner = min(ranked_pool, key=key_fn)
    extra_complete_plans = [plan for plan in complete_pool if plan is not winner]
    return winner, objs[id(winner)], extra_complete_plans


def _select_worker_best_plan(
    primary_plan: FleetOptimizationResponse,
    objective_request: FleetOptimizationRequest,
    expected_items: Dict[str, Set[str]],
    max_routes_per_day: Optional[int],
    compare_horizons: bool,
) -> Tuple[FleetOptimizationResponse, PlanningObjectiveBreakdown]:
    """Select the best already-audited candidate produced by a worker."""
    winner, obj, _ = _collect_worker_audited_plans(
        primary_plan,
        objective_request,
        expected_items,
        max_routes_per_day,
        compare_horizons,
    )
    return winner, obj


def _solve_hybrid_worker_bundle(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
    warm_plan: Optional[dict] = None,
) -> Tuple[int, Optional[dict], Optional[dict], List[dict], Optional[str]]:
    """Run Hybrid ALNS worker and return winner plus distinct audited alternative routes."""
    try:
        request = FleetOptimizationRequest(**request_dict)
        objective_request = FleetOptimizationRequest(**objective_request_dict)
        worker_deadline = time.perf_counter() + max(0.5, float(time_budget))
        expected_items = {order.id: {item.id for item in order.items} for order in request.orders}
        initial_plan = FleetOptimizationResponse.model_validate(warm_plan) if warm_plan is not None else None
        distinct_days = sorted({v.service_day_index for v in request.vehicles})
        compare_horizons = len(distinct_days) > 1
        compact_days_hint = (
            _estimate_hybrid_lower_bound_days(request)
            if seed == 0 and compare_horizons and 12 <= len(request.orders) < 80
            else None
        )

        # Với seed 0 trên bài toán đa ngày khi chưa có warm_plan: tự dò từ cận dưới
        # số ngày tối thiểu bằng chính Hybrid ALNS (tăng +1 nếu chưa đủ 100% đơn)
        # thay vì cắt cứng theo Direct OR-Tools.
        solver_request = request
        compact_fallback_plan: Optional[FleetOptimizationResponse] = None
        if compact_days_hint is not None and initial_plan is None and compact_days_hint < len(distinct_days):
            probe_days = compact_days_hint
            while probe_days < len(distinct_days):
                rem = worker_deadline - time.perf_counter()
                if rem < 2.0:
                    break
                allowed_day_set = set(distinct_days[:probe_days])
                slots = [i for i, v in enumerate(request.vehicles) if v.service_day_index in allowed_day_set]
                compact_req = request_with_vehicle_slots(request, slots)
                if compact_req is None:
                    probe_days += 1
                    continue
                probe_share = (
                    0.35
                    if probe_days == 1 and len(distinct_days) >= 3
                    else (0.50 if probe_days < len(distinct_days) - 1 else 0.72)
                )
                probe_budget = min(rem, max(3.0, rem * probe_share))
                probe_hybrid = PackingAwareHybridALNSOptimizer(
                    compact_req,
                    time_budget_seconds=probe_budget,
                    random_seed=seed,
                    should_split_orders=False,
                    include_benchmarks=False,
                )
                probe_plan = probe_hybrid.solve(
                    hard_deadline=min(worker_deadline, time.perf_counter() + probe_budget)
                )
                if is_fully_served(
                    probe_plan,
                    set(expected_items),
                    request.policy.max_routes_per_day,
                    expected_items,
                ):
                    chosen_probe, obj, extra_probe = _collect_worker_audited_plans(
                        probe_plan,
                        objective_request,
                        expected_items,
                        request.policy.max_routes_per_day,
                        compare_horizons,
                    )
                    alt_dicts = _extract_distinct_alternative_route_dicts(chosen_probe, extra_probe)
                    return seed, chosen_probe.model_dump(), obj.model_dump(), alt_dicts, None
                if probe_plan.routes and compact_fallback_plan is None:
                    compact_fallback_plan = probe_plan
                probe_days += 1

        # Nếu bất kỳ seed nào nhận được warm_plan đã hoàn tất trong K ngày (< tổng số ngày mở),
        # giữ bước tinh chỉnh tập trung trên đúng K ngày đó để mọi seed tối ưu công bằng.
        if (
            initial_plan is not None
            and initial_plan.routes
            and len(distinct_days) > 1
            and is_fully_served(initial_plan, set(expected_items), request.policy.max_routes_per_day, expected_items)
        ):
            warm_days = max(r.service_day_index + 1 for r in initial_plan.routes)
            if 1 <= warm_days < len(distinct_days):
                allowed_day_set = set(distinct_days[:warm_days])
                slots = [i for i, v in enumerate(request.vehicles) if v.service_day_index in allowed_day_set]
                narrowed = request_with_vehicle_slots(request, slots)
                if narrowed is not None:
                    solver_request = narrowed

        rem_budget = max(0.5, worker_deadline - time.perf_counter())
        ortools_seed_pool = (
            _extract_safe_ortools_seed_pool(
                solver_request,
                seed=seed,
                available_budget=rem_budget,
                min_budget=5.0,
            )
            if initial_plan is None and len(solver_request.orders) >= 4
            else None
        )
        if ortools_seed_pool is not None:
            rem_budget = max(0.5, worker_deadline - time.perf_counter())

        hybrid = PackingAwareHybridALNSOptimizer(
            solver_request,
            time_budget_seconds=rem_budget,
            random_seed=seed,
            initial_plan=initial_plan,
            initial_plan_is_verified=initial_plan is not None and is_fully_served(
                initial_plan, set(expected_items), solver_request.policy.max_routes_per_day, expected_items,
            ),
            ortools_seed_pool=ortools_seed_pool,
            should_split_orders=False,
            include_benchmarks=False,
        )
        headroom = max(0.0, float(request.max_time_seconds) - float(time_budget))
        max_ceiling = time.perf_counter() + max(0.5, float(request.max_time_seconds)) - 1.0
        audit_grace = (
            min(10.0 if len(request.orders) >= 50 else 6.0, headroom * 0.5)
            if warm_plan is None and not request.early_stop_patience and time_budget >= 40.0 and headroom >= 12.0
            else 0.0
        )
        hybrid_hard_deadline = min(max_ceiling, worker_deadline + audit_grace)
        plan = hybrid.solve(hard_deadline=hybrid_hard_deadline)
        if not plan.routes and compact_fallback_plan is not None:
            plan = compact_fallback_plan
        if not plan.routes:
            return seed, None, None, [], f"Packing-aware Hybrid ALNS (seed {seed}) không trả về tuyến."
        chosen_plan, obj, extra_plans = _collect_worker_audited_plans(
            plan,
            objective_request,
            expected_items,
            request.policy.max_routes_per_day,
            compare_horizons,
        )
        alt_dicts = _extract_distinct_alternative_route_dicts(chosen_plan, extra_plans)
        return seed, chosen_plan.model_dump(), obj.model_dump(), alt_dicts, None
    except Exception as exc:
        return seed, None, None, [], str(exc)


def _run_hybrid_seed_worker(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
    warm_plan: Optional[dict] = None,
) -> Tuple[int, Optional[dict], Optional[dict], Optional[str]]:
    """Worker function for concurrent Hybrid ALNS seeds compatible with Windows spawn."""
    seed_id, plan_dict, obj_dict, _alts, error = _solve_hybrid_worker_bundle(
        request_dict,
        objective_request_dict,
        seed,
        time_budget,
        warm_plan,
    )
    return seed_id, plan_dict, obj_dict, error


def _run_hybrid_pool_worker(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
    warm_plan: Optional[dict] = None,
) -> Tuple[int, Optional[dict], Optional[dict], List[dict], Optional[str]]:
    """Pool worker wrapper carrying deduplicated audited alternative routes across IPC."""
    return _solve_hybrid_worker_bundle(
        request_dict,
        objective_request_dict,
        seed,
        time_budget,
        warm_plan,
    )


_REAL_HYBRID_WORKER = _run_hybrid_seed_worker


def _solve_ils_worker_bundle(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
) -> Tuple[int, Optional[dict], Optional[dict], List[dict], Optional[str]]:
    """Run ILS worker and return winner plus distinct audited alternative routes."""
    try:
        with scoped_spatial_cache():
            request = FleetOptimizationRequest(**request_dict)
            objective_request = FleetOptimizationRequest(**objective_request_dict)
            effective_budget = max(0.5, float(time_budget))
            worker_deadline = time.perf_counter() + effective_budget
            optimizer = PackingAwareILSOptimizer(
                request,
                max_iterations=400,
                time_budget_seconds=effective_budget,
                random_seed=seed,
                include_benchmarks=False,
                should_split_orders=False,
            )
            plan = optimizer.solve(hard_deadline=worker_deadline)
            if not plan.routes:
                return seed, None, None, [], f"Packing-aware ILS (seed {seed}) không trả về tuyến."
            expected_items = {order.id: {item.id for item in order.items} for order in request.orders}
            compare_horizons = len({v.service_day_index for v in request.vehicles}) > 1
            chosen_plan, obj, extra_plans = _collect_worker_audited_plans(
                plan,
                objective_request,
                expected_items,
                request.policy.max_routes_per_day,
                compare_horizons,
            )
            alt_dicts = _extract_distinct_alternative_route_dicts(chosen_plan, extra_plans)
            return seed, chosen_plan.model_dump(), obj.model_dump(), alt_dicts, None
    except Exception as exc:
        return seed, None, None, [], str(exc)


def _run_ils_seed_worker(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
) -> Tuple[int, Optional[dict], Optional[dict], Optional[str]]:
    """Worker function for concurrent Packing-aware ILS compatible with Windows spawn."""
    seed_id, plan_dict, obj_dict, _alts, error = _solve_ils_worker_bundle(
        request_dict,
        objective_request_dict,
        seed,
        time_budget,
    )
    return seed_id, plan_dict, obj_dict, error


def _run_ils_pool_worker(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
) -> Tuple[int, Optional[dict], Optional[dict], List[dict], Optional[str]]:
    """Pool ILS worker wrapper carrying deduplicated audited alternative routes across IPC."""
    return _solve_ils_worker_bundle(
        request_dict,
        objective_request_dict,
        seed,
        time_budget,
    )


_REAL_ILS_WORKER = _run_ils_seed_worker


def _run_direct_span_worker(
    request_dict: dict,
    objective_request_dict: dict,
    direct_dict: dict,
    target_days: int,
    time_budget: float,
) -> Tuple[int, Optional[dict], Optional[dict], Optional[str]]:
    """Refine a feasible direct-dedicated schedule within its target day span."""
    try:
        with scoped_spatial_cache():
            request = FleetOptimizationRequest(**request_dict)
            objective_request = FleetOptimizationRequest(**objective_request_dict)
            direct_metric = BenchmarkMetric.model_validate(direct_dict)
            slots = [
                idx
                for idx, vehicle in enumerate(request.vehicles)
                if vehicle.service_day_index < target_days
            ]
            optimizer = MultiStartFleetOptimizer(request)
            deadline = time.perf_counter() + max(0.5, float(time_budget))
            plan = optimizer._search_direct_span(slots, direct_metric, deadline)
            if plan is None or not plan.routes:
                return (
                    target_days,
                    None,
                    None,
                    "Packing-aware Hybrid ALNS (Direct warm-start) không trả về tuyến.",
                )
            obj = apply_planning_objective(objective_request, plan)
            return target_days, plan.model_dump(), obj.model_dump(), None
    except Exception as exc:
        return target_days, None, None, str(exc)


def _run_search_worker(
    payload_dict: dict,
    strategy_key: str,
    time_budget_seconds: float,
    stagnation_seconds: float,
    routing_budget_share: float,
    validation_budget_share: float,
    consolidation_budget_share: float,
) -> Tuple[str, str, Optional[dict], int, Optional[str]]:
    """Top-level worker function compatible with Windows multiprocessing spawn."""
    try:
        strategy = find_search_strategy(strategy_key)
        request = FleetOptimizationRequest(**payload_dict)
        solver = FleetRoutingSolver(
            request,
            search_strategy=strategy,
            time_budget_seconds=time_budget_seconds,
            stagnation_seconds=stagnation_seconds,
            routing_budget_share=routing_budget_share,
            validation_budget_share=validation_budget_share,
            consolidation_budget_share=consolidation_budget_share,
            # This worker is the final OR-Tools fallback. It must not recursively
            # invoke Hybrid again after the Hybrid-first phase has already failed.
            enable_hybrid_fallback=False,
            should_split_orders=False,
        )
        plan, objective = solver.solve_with_objective()
        return strategy.key, strategy.label, plan.model_dump(), objective, None
    except Exception as exc:
        return strategy_key, strategy_key, None, 0, str(exc)


def _plan_signature(plan: FleetOptimizationResponse) -> Tuple:
    """Distinct structural signature to deduplicate identical routes."""
    return tuple(
        sorted(
            (
                route.service_day_index,
                route.route_id or route.vehicle_id,
                tuple(
                    (
                        stop.stop_type,
                        stop.allocation_id or stop.order_id,
                        tuple(sorted(stop.items_loaded or stop.items_unloaded)),
                    )
                    for stop in route.stops
                ),
            )
            for route in plan.routes
        )
    )


def _candidate_lexicographic_key(
    item: Tuple[SearchStrategy, FleetOptimizationResponse, int],
) -> Tuple[int, int, int, int, int]:
    _, plan, objective = item
    breakdown = plan.planning_objective
    if breakdown is not None:
        extra_order_trips = breakdown.extra_order_trips
        active_route_count = (
            breakdown.active_route_count
            if breakdown.active_route_count > 0 or not plan.routes
            else len(plan.routes)
        )
        physical_vehicle_count = (
            breakdown.physical_vehicle_count
            if breakdown.physical_vehicle_count > 0 or not plan.routes
            else len({r.vehicle_id for r in plan.routes if r.vehicle_id})
        )
    else:
        trips_by_order: Dict[str, Set[str]] = {}
        for idx, route in enumerate(plan.routes):
            r_key = route.route_id or f"{route.vehicle_id}::{idx}"
            for stop in route.stops:
                oid = stop.order_id or (
                    stop.allocation_id.split("::split:")[0]
                    if stop.allocation_id
                    else ""
                )
                if oid:
                    trips_by_order.setdefault(oid, set()).add(r_key)
        extra_order_trips = sum(
            max(0, len(r_keys) - 1) for r_keys in trips_by_order.values()
        )
        active_route_count = len(plan.routes)
        physical_vehicle_count = len(
            {r.vehicle_id for r in plan.routes if r.vehicle_id}
        )
    return (
        extra_order_trips,
        active_route_count,
        objective,
        plan.total_cost_vnd,
        physical_vehicle_count,
    )


def _candidate_selection_key(
    item: Tuple[SearchStrategy, FleetOptimizationResponse, int], compare_horizons: bool,
) -> Tuple[int, ...]:
    return ((item[2],) if compare_horizons else ()) + _candidate_lexicographic_key(item)


def is_fully_served(
    plan: FleetOptimizationResponse,
    all_order_ids: Set[str],
    max_routes_per_day: Optional[int] = None,
    expected_items: Optional[Dict[str, Set[str]]] = None,
) -> bool:
    """Check whether a plan delivers 100% of requested orders without violations."""
    if plan.status != "SUCCESS":
        return False
    if plan.unassigned_orders:
        return False
    if not all(
        route.spatial_validation and route.spatial_validation.is_valid
        for route in plan.routes
    ):
        return False

    served_order_ids: Set[str] = set()
    global_loaded_items: Set[str] = set()
    for route in plan.routes:
        previous_departure_sec = route.start_time_sec
        route_loaded_items: Set[str] = set()
        route_unloaded_items: Set[str] = set()
        for stop in route.stops:
            time_breakdown = (
                stop.travel_time_sec,
                stop.waiting_time_sec,
                stop.service_time_sec,
            )
            if any(value is not None for value in time_breakdown):
                if any(value is None for value in time_breakdown):
                    return False
                if (
                    stop.arrival_time_sec - previous_departure_sec
                    != stop.travel_time_sec + stop.waiting_time_sec
                    or stop.departure_time_sec - stop.arrival_time_sec
                    != stop.service_time_sec
                ):
                    return False
            previous_departure_sec = stop.departure_time_sec
            allocation_id = stop.allocation_id or stop.order_id
            if allocation_id and stop.stop_type == "DELIVERY":
                served_order_ids.add(allocation_id)
            if expected_items is not None:
                permitted = expected_items.get(allocation_id, set())
                if not set(stop.items_loaded + stop.items_unloaded).issubset(permitted):
                    return False
            if stop.stop_type == "PICKUP":
                for item_id in stop.items_loaded:
                    if item_id in global_loaded_items or item_id in route_loaded_items:
                        return False
                    route_loaded_items.add(item_id)
                    global_loaded_items.add(item_id)
            elif stop.stop_type == "DELIVERY":
                for item_id in stop.items_unloaded:
                    if item_id not in route_loaded_items or item_id in route_unloaded_items:
                        return False
                    route_unloaded_items.add(item_id)
        if route_loaded_items != route_unloaded_items:
            return False

        return_breakdown = (
            route.return_travel_time_sec,
            route.return_waiting_time_sec,
        )
        if any(value is not None for value in return_breakdown):
            if any(value is None for value in return_breakdown):
                return False
            if (
                route.end_time_sec - previous_departure_sec
                != route.return_travel_time_sec + route.return_waiting_time_sec
            ):
                return False

    if expected_items is not None and global_loaded_items != set().union(*expected_items.values()):
        return False
    if served_order_ids != all_order_ids:
        return False

    # Bất biến TMS: Trong cùng 1 ngày, mỗi xe (biển số) và mỗi tài xế chỉ được chạy tối đa 1 tuyến
    day_plates: Set[Tuple[int, str]] = set()
    day_drivers: Set[Tuple[int, str]] = set()
    for route in plan.routes:
        if route.plate_number:
            plate_key = (route.service_day_index, route.plate_number)
            if plate_key in day_plates:
                return False
            day_plates.add(plate_key)
        if route.driver_id:
            driver_key = (route.service_day_index, route.driver_id)
            if driver_key in day_drivers:
                return False
            day_drivers.add(driver_key)

    if max_routes_per_day is not None:
        routes_per_day: Dict[int, int] = {}
        for route in plan.routes:
            day_idx = route.service_day_index
            routes_per_day[day_idx] = routes_per_day.get(day_idx, 0) + 1
            if routes_per_day[day_idx] > max_routes_per_day:
                return False

    return True


def _plan_days(plan: FleetOptimizationResponse) -> int:
    return max((route.service_day_index + 1 for route in plan.routes), default=0)


def select_ranked_candidates(
    evaluated_runs: List[Tuple[SearchStrategy, FleetOptimizationResponse, int]],
    all_order_ids: Set[str],
    max_candidates: int = 3,
    max_routes_per_day: Optional[int] = None,
    expected_items: Optional[Dict[str, Set[str]]] = None,
    compare_horizons: bool = False,
) -> Tuple[List[FleetOptimizationCandidate], int, List[str]]:
    """Pure selection and ranking function to allow isolated unit testing.

    Returns:
        (candidates, fully_served_count, diagnostics)
    """
    diagnostics: List[str] = []
    fully_served_runs = [
        (strategy, plan, objective)
        for strategy, plan, objective in evaluated_runs
        if is_fully_served(plan, all_order_ids, max_routes_per_day=max_routes_per_day, expected_items=expected_items)
    ]
    fully_served_count = len(fully_served_runs)

    if fully_served_runs:
        def rank(item):
            return _candidate_selection_key(item, compare_horizons)

        fully_served_runs.sort(key=rank)
        if compare_horizons:
            # Reserve a place for the best verified plan of each duration before
            # filling unused places with other route arrangements.
            representatives = {}
            for item in fully_served_runs:
                representatives.setdefault(_plan_days(item[1]), item)
            first = fully_served_runs[0]
            other_days = sorted((d for d in representatives if d != _plan_days(first[1])),
                                key=lambda d: (abs(d - _plan_days(first[1])), d))
            preferred = [first, *(representatives[d] for d in other_days[:max_candidates - 1])]
            fully_served_runs = sorted(preferred, key=rank) + fully_served_runs

        distinct_candidates: List[Tuple[SearchStrategy, FleetOptimizationResponse, int]] = []
        seen_signatures: Set[Tuple] = set()

        for strategy, plan, objective in fully_served_runs:
            sig = _plan_signature(plan)
            if sig in seen_signatures:
                continue
            seen_signatures.add(sig)
            distinct_candidates.append((strategy, plan, objective))
            if len(distinct_candidates) >= max_candidates:
                break

        distinct_candidates.sort(key=rank)
        if len(distinct_candidates) < max_candidates:
            diagnostics.append(
                f"Đã tìm thấy {fully_served_count} lượt giao đủ 100% đơn, trong đó có "
                f"{len(distinct_candidates)} phương án có lộ trình khác biệt."
            )

        candidates = [
            FleetOptimizationCandidate(
                rank=index + 1,
                search_strategy=strategy.label,
                solver_objective=objective,
                is_best_found=(index == 0),
                result=plan,
            )
            for index, (strategy, plan, objective) in enumerate(distinct_candidates)
        ]
        return candidates, fully_served_count, diagnostics

    return [], 0, ["Chưa tìm được lịch giao đủ toàn bộ đơn và kiện trong ngân sách tìm kiếm."]


class MultiStartFleetOptimizer:
    """Manages Hybrid seed runs, validation, ranking, and OR-Tools fallback."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        strategies: Optional[List[SearchStrategy]] = None,
        cancel_event: Optional[Any] = None,
    ):
        self._created_at = time.perf_counter()
        self.cancel_event = cancel_event
        pruned_request, self.pruned_virtual_vehicle_count = (
            prune_unserviceable_virtual_resources(request)
        )
        split_deadline = self._created_at + (
            derive_search_policy(pruned_request).time_budget_seconds
            * ORDER_SPLIT_BUDGET_SHARE
        )
        split_outcome = split_orders_within_deadline(
            pruned_request, deadline=split_deadline
        )
        self.request = split_outcome.request
        self.split_order_count = split_outcome.split_order_count
        self.unchecked_split_order_count = split_outcome.unchecked_order_count
        self.objective_request = (
            self.request if self.split_order_count else request
        )
        self.policy: AdaptiveSearchPolicy = derive_search_policy(self.request)
        physical_vehicle_ids = {
            vehicle.source_vehicle_id or vehicle.id
            for vehicle in self.request.vehicles
        }
        self.use_exhaustive_search = (
            strategies is None
            and request.hybrid_seed_count == 0
            and 1 <= len(self.request.orders) <= 3
            and len(physical_vehicle_ids) <= 2
        )
        self.strategies = (
            list(strategies)
            if strategies is not None
            else list(SEARCH_STRATEGIES[: self.policy.strategy_count])
        )

    def _is_cancelled(self) -> bool:
        return bool(self.cancel_event is not None and self.cancel_event.is_set())

    def _cancelled_response(self, run_count: int = 1) -> FleetOptimizationBatchResponse:
        return FleetOptimizationBatchResponse(
            job_id=self.request.job_id,
            solver_run_count=max(1, run_count),
            fully_served_candidate_count=0,
            candidates=[],
            no_plan_status="NO_COMPLETE_PLAN",
            diagnostics=["Job tối ưu đã bị hủy."],
        )

    def _direct_benchmark(self) -> Tuple[BaselineCostCalculator, BenchmarkMetric]:
        nodes = FleetRoutingSolver(self.objective_request, should_split_orders=False).nodes
        budget = min(60.0, max(DIRECT_BENCHMARK_BUDGET_SECONDS, len(self.objective_request.orders) * 0.4))
        calculator = BaselineCostCalculator(
            self.objective_request,
            nodes,
            deadline=time.perf_counter() + budget,
            cancel_event=self.cancel_event,
        )
        return calculator, calculator.compute_direct_dedicated()

    def _search_direct_span(
        self, slots: List[int], direct: BenchmarkMetric, deadline: float,
    ) -> Optional[FleetOptimizationResponse]:
        limited = request_with_vehicle_slots(self.request, slots)
        if limited is None:
            return None
        # Each Direct trip carries one order. Its chronological pickup/delivery
        # sequence seeds a single Hybrid route for the same physical truck/day.
        trips_by_shift = {}
        for trip in direct.routes:
            trips_by_shift.setdefault((trip.vehicle_id, trip.service_day_index), []).append(trip)
        seed_routes = []
        audited_trips = {}
        routes_by_slot = []
        for vehicle in limited.vehicles:
            trips = trips_by_shift.get((vehicle.source_vehicle_id or vehicle.id, vehicle.service_day_index))
            if trips:
                audited_trips[vehicle.id] = sorted(trips, key=lambda r: r.start_time_sec)
                stops = [stop for trip in audited_trips[vehicle.id] for stop in trip.stops]
                seed_routes.append(trips[0].model_copy(update={
                    "route_id": vehicle.id,
                    "stops": [stop.model_copy(update={"sequence": i}) for i, stop in enumerate(stops, 1)],
                }))
            routes_by_slot.append(seed_routes[-1].stops if trips else [])
        remaining = deadline - time.perf_counter()
        if remaining < 0.5:
            return None
        initial = FleetOptimizationResponse(job_id=limited.job_id, status="PARTIAL", routes=seed_routes)
        engine = PackingAwareHybridALNSOptimizer(
            limited, time_budget_seconds=remaining, initial_plan=initial,
            should_split_orders=False, include_benchmarks=False,
        )
        verified = engine._build_final_response(
            routes_by_slot, [], include_benchmarks=False, audited_direct_trips=audited_trips,
            spatial_time_budget_seconds=max(0.25, deadline - time.perf_counter()),
            absolute_spatial_deadline=deadline,
        )
        expected_items = {o.id: {i.id for i in o.items} for o in limited.orders}
        order_ids = set(expected_items)
        max_routes_per_day = limited.policy.max_routes_per_day
        if is_fully_served(verified, order_ids, max_routes_per_day, expected_items):
            improved = engine.refine_direct_span(verified, audited_trips, deadline)
            best_plan = (
                improved
                if improved is not verified
                and is_fully_served(improved, order_ids, max_routes_per_day, expected_items)
                else verified
            )
            if len(limited.orders) >= 10 and (deadline - time.perf_counter()) >= 1.2:
                polished = engine._polish_audited_response(best_plan, deadline)
                if (
                    polished is not best_plan
                    and is_fully_served(polished, order_ids, max_routes_per_day, expected_items)
                ):
                    return polished
            return best_plan
        return engine.solve(hard_deadline=deadline)

    def _preprocessing_timeout_notes(self) -> List[str]:
        if not self.unchecked_split_order_count:
            return []
        return [
            f"Bỏ qua kiểm tra tách đơn cho {self.unchecked_split_order_count} đơn "
            "nhiều kiện vì vượt giới hạn thời gian tiền xử lý; các đơn này "
            "giữ nguyên và vẫn được kiểm chứng xếp hàng khi tìm tuyến."
        ]

    def solve(self, max_candidates: int = 3) -> FleetOptimizationBatchResponse:
        with scoped_spatial_cache():
            return self._solve_with_cache(max_candidates=max_candidates)

    def _solve_with_cache(self, max_candidates: int = 3) -> FleetOptimizationBatchResponse:
        job_started_at = getattr(self, "_created_at", time.perf_counter())
        search_budget_seconds = float(self.policy.time_budget_seconds)
        adaptive_search = self.request.early_stop_patience > 0
        job_budget = self.request.max_time_seconds if adaptive_search else search_budget_seconds
        job_deadline = job_started_at + job_budget
        exhaustive_fallback_diagnostic: Optional[str] = None
        if self.use_exhaustive_search:
            exhaustive_started_at = time.monotonic()
            exhaustive = FleetRoutingSolver(
                self.request,
                time_budget_seconds=self.policy.time_budget_seconds,
                should_split_orders=False,
            ).solve_exhaustive_tiny_candidates(max_candidates=max_candidates)
            expected_items = {o.id: {i.id for i in o.items} for o in self.request.orders}
            exhaustive.plans[:] = [
                plan for plan in exhaustive.plans
                if is_fully_served(
                    plan,
                    set(expected_items),
                    max_routes_per_day=self.request.policy.max_routes_per_day,
                    expected_items=expected_items,
                )
            ]
            if exhaustive.plans:
                for plan in exhaustive.plans:
                    apply_planning_objective(self.objective_request, plan)
                ranked_plans = sorted(
                    exhaustive.plans,
                    key=plan_lexicographic_key,
                )
                candidates = [
                    FleetOptimizationCandidate(
                        rank=index + 1,
                        search_strategy="Vét cạn tuyến nhỏ",
                        solver_objective=plan.planning_objective.selection_score_vnd,
                        is_best_found=(index == 0),
                        result=plan,
                    )
                    for index, plan in enumerate(ranked_plans)
                ]
                diagnostics = [
                    (
                        "Vét cạn đã thay thế multi-start OR-Tools cho bài toán "
                        f"{len(self.request.orders)} đơn, "
                        f"ngân sách chung {self.policy.time_budget_seconds} giây."
                    ),
                    (
                        f"Đã loại sớm {self.pruned_virtual_vehicle_count} khung xe-ngày "
                        "không thể tự phục vụ bất kỳ đơn nào."
                    ),
                ]
                diagnostics.extend(exhaustive.plans[0].diagnostics)
                return FleetOptimizationBatchResponse(
                    job_id=self.request.job_id,
                    solver_run_count=1,
                    fully_served_candidate_count=len(candidates),
                    candidates=candidates,
                    diagnostics=diagnostics,
                )
            search_budget_seconds = max(
                0.1,
                self.policy.time_budget_seconds
                - (time.monotonic() - exhaustive_started_at),
            )
            exhaustive_fallback_diagnostic = (
                "Vét cạn chưa tìm được phương án giao đủ đơn; "
                "chuyển sang Hybrid-first trong phần ngân sách còn lại."
            )

        request_dict = self.request.model_dump()
        all_order_ids = {order.id for order in self.request.orders}
        evaluated_runs: List[Tuple[SearchStrategy, FleetOptimizationResponse, int]] = []
        pooled_alt_route_dicts: List[dict] = []
        search_errors: List[str] = []
        is_mocked = PackingAwareHybridALNSOptimizer is not _REAL_HYBRID_OPTIMIZER
        calculator = None
        direct_metric = None
        short_plan = None
        target_days = 0
        if self._is_cancelled():
            return self._cancelled_response()
        cpu_count = os.cpu_count() or 1
        if self.request.hybrid_seed_count:
            hybrid_seeds = tuple(range(self.request.hybrid_seed_count))
        elif not is_mocked and cpu_count >= 4 and search_budget_seconds >= 40.0 and len(self.request.orders) >= 8:
            hybrid_seeds = (0, 1, 2)
        elif (
            cpu_count > 2
            and len(self.request.orders) < 80
            and sum(len(o.items) for o in self.request.orders) < 500
            and search_budget_seconds >= 48.0
            and len(self.request.orders) >= 8
        ):
            hybrid_seeds = (0, 1)
        else:
            hybrid_seeds = (0,)
        hybrid_run_budget = search_budget_seconds / len(hybrid_seeds)
        seed_budget_detail = f"{hybrid_run_budget:g} giây/seed"

        compare_horizons = len({v.service_day_index for v in self.request.vehicles}) > 1
        timed_out_seed_plan: Optional[FleetOptimizationResponse] = None
        budget_headroom = float(self.request.max_time_seconds) - search_budget_seconds
        has_parallel_headroom = (
            budget_headroom >= 6.0
            or (
                float(self.request.max_time_seconds) >= 28.0
                and (job_deadline - time.perf_counter()) >= 24.0
                and (cpu_count >= 4 or len(hybrid_seeds) == 1)
            )
        )
        run_concurrent_ils = (
            not is_mocked
            and _run_hybrid_seed_worker is _REAL_HYBRID_WORKER
            and PackingAwareILSOptimizer is _REAL_ILS_OPTIMIZER
            and len(self.request.orders) >= 4
            and cpu_count >= 2
            and search_budget_seconds >= 8.0
            and has_parallel_headroom
        )
        # Direct warm-start is disabled as a competing solver candidate so all
        # returned plans are discovered purely by Hybrid ALNS / ILS seeds;
        # compute_direct_dedicated() now runs strictly for post-solve benchmark comparison.
        use_process_pool = (
            adaptive_search
            or len(hybrid_seeds) > 1
            or run_concurrent_ils
        ) and not is_mocked

        expected_items = {order.id: {item.id for item in order.items} for order in self.request.orders}
        if use_process_pool:
            objective_request_dict = self.objective_request.model_dump()
            remaining_parallel = max(1.0, job_deadline - time.perf_counter())
            effective_run_budget = min(
                remaining_parallel,
                remaining_parallel * 0.9 if adaptive_search
                else (
                    search_budget_seconds
                    if len(hybrid_seeds) == 1
                    else max(hybrid_run_budget, search_budget_seconds * 0.92)
                ),
            )
            worker_slots_needed = (
                len(hybrid_seeds)
                + (1 if run_concurrent_ils else 0)
            )
            worker_cap = (
                max(MAX_PARALLEL_HYBRID_SEEDS, min(8, max(4, cpu_count - 1)))
                if cpu_count >= 5
                else (
                    max(MAX_PARALLEL_HYBRID_SEEDS, min(4, cpu_count))
                    if run_concurrent_ils
                    else MAX_PARALLEL_HYBRID_SEEDS
                )
            )
            parallel_workers = min(worker_slots_needed, worker_cap)
            total_waves = (
                math.ceil(worker_slots_needed / max(1, parallel_workers))
                if len(hybrid_seeds) >= 2 and worker_slots_needed > parallel_workers
                else 1
            )
            equal_seed_budget = effective_run_budget / total_waves
            seed_budget_detail = f"{equal_seed_budget:g} giây/seed"
            if run_concurrent_ils:
                seed_budget_detail = f"{equal_seed_budget:g} giây/luồng (+ Packing-aware ILS song song)"
            if total_waves > 1:
                seed_budget_detail = (
                    f"{equal_seed_budget:g} giây/seed (ngang nhau cho cả {len(hybrid_seeds)} seed, "
                    f"tối đa {parallel_workers} tiến trình đồng thời)"
                )
            executor = concurrent.futures.ProcessPoolExecutor(max_workers=parallel_workers)
            best_by_seed = {}
            hybrid_pool_callable = (
                _run_hybrid_pool_worker
                if _run_hybrid_seed_worker is _REAL_HYBRID_WORKER
                else _run_hybrid_seed_worker
            )
            ils_pool_callable = (
                _run_ils_pool_worker
                if _run_ils_seed_worker is _REAL_ILS_WORKER
                else _run_ils_seed_worker
            )
            try:
                futures = {}
                for seed in hybrid_seeds:
                    initial = short_plan.model_dump() if seed == 0 and short_plan is not None else None
                    budget = equal_seed_budget
                    min_bootstrap = 12.0 if len(self.request.orders) >= 50 and budget >= 20.0 else 0.0
                    bootstrap_budget = min(
                        budget,
                        max(min_bootstrap, min(search_budget_seconds, equal_seed_budget) * 0.85),
                    )
                    refine_budget = budget - bootstrap_budget if adaptive_search else 0
                    # Return an audited checkpoint before a longer refinement can
                    # exhaust its time. The parent keeps it across worker timeouts.
                    if refine_budget >= 2:
                        future = executor.submit(
                            hybrid_pool_callable,
                            {**request_dict, "early_stop_patience": 0},
                            objective_request_dict, seed, bootstrap_budget, initial,
                        )
                    else:
                        refine_budget = 0
                        future = executor.submit(
                            hybrid_pool_callable, request_dict, objective_request_dict, seed, budget, initial,
                        )
                    futures[future] = ("hybrid", seed, refine_budget)

                if run_concurrent_ils:
                    spawn_audit_grace = 12.0 if len(self.request.orders) >= 50 else 8.0
                    max_ceiling = job_started_at + float(self.request.max_time_seconds)
                    ils_budget = min(
                        max(2.0, max_ceiling - time.perf_counter() - 1.0),
                        search_budget_seconds + min(4.0, spawn_audit_grace * 0.4),
                    )
                    if total_waves > 1:
                        ils_budget = min(ils_budget, equal_seed_budget)
                    ils_future = executor.submit(
                        ils_pool_callable, request_dict, objective_request_dict, 0, ils_budget,
                    )
                    futures[ils_future] = ("ils", 0, 0)

                if adaptive_search:
                    pool_deadline = job_deadline
                else:
                    spawn_audit_grace = 12.0 if len(self.request.orders) >= 50 else 8.0
                    max_ceiling = job_started_at + float(self.request.max_time_seconds)
                    pool_deadline = max(job_deadline, min(max_ceiling, job_deadline + spawn_audit_grace))
                cancelled_run = False
                while futures:
                    if self._is_cancelled():
                        cancelled_run = True
                        break
                    rem_wait = max(0.0, pool_deadline - time.perf_counter())
                    if rem_wait <= 0.0:
                        break
                    done, _ = concurrent.futures.wait(
                        futures, timeout=min(0.5, rem_wait),
                        return_when=concurrent.futures.FIRST_COMPLETED,
                    )
                    if not done:
                        if self._is_cancelled():
                            cancelled_run = True
                            break
                        if time.perf_counter() >= pool_deadline:
                            break
                        continue
                    for future in sorted(
                        done,
                        key=lambda item: (0 if futures[item][0] == "hybrid" else 1, futures[item][1]),
                    ):
                        family, seed, refine_budget = futures.pop(future)
                        warm_plan = None
                        if family == "hybrid":
                            label_prefix = f"Packing-aware Hybrid ALNS (seed {seed})"
                            key_prefix = f"packing-aware-hybrid-alns-seed-{seed}"
                        elif family == "direct_span":
                            label_prefix = "Packing-aware Hybrid ALNS (Direct warm-start)"
                            key_prefix = "hybrid-direct-span"
                        else:
                            label_prefix = f"Packing-aware ILS (seed {seed})"
                            key_prefix = f"packing-aware-ils-seed-{seed}"
                        try:
                            raw_result = future.result()
                            if len(raw_result) == 5:
                                _, plan_dict, obj_dict, alt_route_dicts, error = raw_result
                            else:
                                _, plan_dict, obj_dict, error = raw_result
                                alt_route_dicts = ()
                            if error or plan_dict is None or obj_dict is None:
                                raise RuntimeError(error or "Không có phương án đã kiểm chứng")
                            solver_plan = FleetOptimizationResponse.model_validate(plan_dict)
                            planning_obj = PlanningObjectiveBreakdown.model_validate(obj_dict)
                            solver_plan.planning_objective = planning_obj
                            if alt_route_dicts:
                                pooled_alt_route_dicts.extend(alt_route_dicts)
                            strategy = SearchStrategy(
                                key_prefix,
                                label_prefix,
                                DEFAULT_SEARCH_STRATEGY.first_solution_strategy,
                                DEFAULT_SEARCH_STRATEGY.local_search_metaheuristic,
                            )
                            candidate = (strategy, solver_plan, planning_obj.selection_score_vnd)
                            complete = is_fully_served(
                                solver_plan, all_order_ids, self.request.policy.max_routes_per_day, expected_items,
                            )
                            rank = (
                                not complete,
                                len(solver_plan.unassigned_orders),
                                *_candidate_selection_key(candidate, compare_horizons),
                            )
                            bucket = (family, seed, _plan_days(solver_plan))
                            previous = best_by_seed.get(bucket)
                            if previous is None or rank <= previous[0]:
                                best_by_seed[bucket] = (rank, candidate)
                            else:
                                previous[1][1].diagnostics.extend(
                                    note for note in solver_plan.diagnostics if note.startswith(f"Seed {seed} dừng sớm")
                                )
                            if complete and family == "hybrid":
                                warm_plan = plan_dict
                        except Exception as error:
                            if family == "hybrid" or not any(k[0] == "hybrid" for k in best_by_seed):
                                search_errors.append(f"{label_prefix}: {error}")

                        if family == "hybrid":
                            remaining_refine_budget = min(refine_budget, job_deadline - time.perf_counter())
                            if remaining_refine_budget >= 2:
                                refinement = executor.submit(
                                    hybrid_pool_callable, request_dict, objective_request_dict,
                                    seed, remaining_refine_budget, warm_plan,
                                )
                                futures[refinement] = ("hybrid", seed, 0)

                for future, (family, seed, _) in futures.items():
                    future.cancel()
                    if family == "hybrid":
                        search_errors.append(f"Packing-aware Hybrid ALNS (seed {seed}): vượt quá giới hạn thời gian.")
                evaluated_runs.extend(best_by_seed[key][1] for key in sorted(best_by_seed))
            finally:
                processes = getattr(executor, "_processes", None)
                if processes:
                    for proc in list(processes.values()):
                        if proc.is_alive():
                            proc.terminate()
                executor.shutdown(wait=False, cancel_futures=True)
        else:
            for seed_index, seed in enumerate(hybrid_seeds):
                if self._is_cancelled():
                    break
                remaining_for_seed = job_deadline - time.perf_counter()
                if remaining_for_seed <= 0.5 and not is_mocked:
                    search_errors.append(
                        f"Hết ngân sách trước khi chạy Packing-aware Hybrid ALNS (seed {seed})."
                    )
                    break
                remaining_seed_count = max(1, len(hybrid_seeds) - seed_index)
                seed_budget = (
                    hybrid_run_budget
                    if is_mocked
                    else min(hybrid_run_budget, max(0.5, remaining_for_seed / remaining_seed_count))
                )
                seed_deadline = time.perf_counter() + seed_budget
                try:
                    ortools_seed_pool = (
                        _extract_safe_ortools_seed_pool(
                            self.request,
                            seed=seed,
                            available_budget=seed_budget,
                            min_budget=3.0,
                        )
                        if not is_mocked
                        else None
                    )
                    effective_budget = (
                        seed_budget
                        if is_mocked
                        else max(0.5, min(seed_budget, seed_deadline - time.perf_counter()))
                    )
                    hybrid = PackingAwareHybridALNSOptimizer(
                        self.request,
                        time_budget_seconds=effective_budget,
                        random_seed=seed,
                        initial_plan=short_plan if seed == 0 else None,
                        ortools_seed_pool=ortools_seed_pool,
                        should_split_orders=False,
                        include_benchmarks=False,
                    )
                    if is_mocked:
                        hybrid_plan = hybrid.solve()
                    else:
                        effective_hard_deadline = min(job_deadline, seed_deadline)
                        hybrid_plan = hybrid.solve(hard_deadline=effective_hard_deadline)
                    if not hybrid_plan.routes:
                        if getattr(hybrid_plan, "status", None) == "TIMEOUT" and timed_out_seed_plan is None:
                            timed_out_seed_plan = hybrid_plan
                        search_errors.append(
                            f"Packing-aware Hybrid ALNS (seed {seed}) không trả về tuyến."
                        )
                        continue
                    chosen_hybrid, planning_objective, extra_complete_plans = _collect_worker_audited_plans(
                        hybrid_plan,
                        self.objective_request,
                        expected_items,
                        self.request.policy.max_routes_per_day,
                        compare_horizons,
                    )
                    if extra_complete_plans:
                        setattr(chosen_hybrid, "_audited_alternatives", extra_complete_plans)
                    hybrid_strategy = SearchStrategy(
                        f"packing-aware-hybrid-alns-seed-{seed}",
                        f"Packing-aware Hybrid ALNS (seed {seed})",
                        DEFAULT_SEARCH_STRATEGY.first_solution_strategy,
                        DEFAULT_SEARCH_STRATEGY.local_search_metaheuristic,
                    )
                    evaluated_runs.append(
                        (
                            hybrid_strategy,
                            chosen_hybrid,
                            planning_objective.selection_score_vnd,
                        )
                    )
                except Exception as exc:
                    search_errors.append(
                        f"Packing-aware Hybrid ALNS (seed {seed}): {exc}"
                    )

        hybrid_success_count = len({
            strategy.key
            for strategy, _, _ in evaluated_runs
            if strategy.key.startswith("packing-aware-hybrid-alns-seed-")
        })
        ils_success_count = len({
            strategy.key
            for strategy, _, _ in evaluated_runs
            if strategy.key.startswith("packing-aware-ils-seed-")
        })
        if self._is_cancelled():
            return self._cancelled_response(len(evaluated_runs))
        ortools_fallback_used = False
        if not any(is_fully_served(plan, all_order_ids, self.request.policy.max_routes_per_day, expected_items)
                   for _, plan, _ in evaluated_runs):
            remaining_fallback = job_deadline - time.perf_counter()
            fallback_strategy = (
                self.strategies[0]
                if self.strategies
                else DEFAULT_SEARCH_STRATEGY
            )
            plan_dict = None
            error: Optional[str] = None
            if remaining_fallback >= 1.5:
                _, _, plan_dict, _, error = _run_search_worker(
                    request_dict,
                    fallback_strategy.key,
                    min(search_budget_seconds, remaining_fallback),
                    self.policy.stagnation_seconds,
                    self.policy.routing_budget_share,
                    self.policy.validation_budget_share,
                    self.policy.consolidation_budget_share,
                )
            if error is not None or plan_dict is None:
                if timed_out_seed_plan is not None or remaining_fallback < 1.5:
                    return FleetOptimizationBatchResponse(
                        job_id=self.request.job_id,
                        solver_run_count=len(hybrid_seeds),
                        fully_served_candidate_count=0,
                        candidates=[],
                        no_plan_status="TIMEOUT",
                        diagnostics=[
                            f"Hết ngân sách tối ưu ({job_budget:g} giây): chưa kiểm chứng được phương án khả thi.",
                            *search_errors[:2],
                            *self._preprocessing_timeout_notes(),
                        ],
                    )
                details = "; ".join(search_errors + ([error] if error else []))
                raise RuntimeError(
                    "Hybrid-first và OR-Tools fallback đều không trả được nghiệm: "
                    + details
                )
            fallback_plan = FleetOptimizationResponse(**plan_dict)
            fallback_objective = apply_planning_objective(
                self.objective_request, fallback_plan
            )
            evaluated_runs.append(
                (
                    fallback_strategy,
                    fallback_plan,
                    fallback_objective.selection_score_vnd,
                )
            )
            ortools_fallback_used = True

        cross_seed_applied = False
        if not is_mocked and not self._is_cancelled() and len(self.request.orders) >= 8:
            complete_runs = [
                run for run in evaluated_runs
                if is_fully_served(
                    run[1],
                    all_order_ids,
                    max_routes_per_day=self.request.policy.max_routes_per_day,
                    expected_items=expected_items,
                )
            ]
            extra_routes: List[OptimizedRoute] = []
            seen_extra_keys: Set[Tuple] = set()
            for _, run_plan, _ in complete_runs:
                for alt_plan in getattr(run_plan, "_audited_alternatives", ()):
                    for route in getattr(alt_plan, "routes", ()):
                        r_key = _alt_route_dedup_key(route)
                        if r_key not in seen_extra_keys:
                            seen_extra_keys.add(r_key)
                            extra_routes.append(route)
            for route_dict in pooled_alt_route_dicts:
                route = OptimizedRoute.model_validate(route_dict)
                r_key = _alt_route_dedup_key(route)
                if r_key not in seen_extra_keys:
                    seen_extra_keys.add(r_key)
                    extra_routes.append(route)

            if complete_runs and (len(complete_runs) >= 2 or extra_routes):
                combined = solve_cross_seed_set_partitioning(
                    self.objective_request,
                    [run[1] for run in complete_runs],
                    expected_items,
                    compare_horizons=compare_horizons,
                    extra_routes=extra_routes,
                    time_limit_sec=1.5,
                )
                if combined is not None:
                    combined_plan, combined_obj = combined
                    if is_fully_served(
                        combined_plan,
                        all_order_ids,
                        max_routes_per_day=self.request.policy.max_routes_per_day,
                        expected_items=expected_items,
                    ):
                        cross_strategy = SearchStrategy(
                            "packing-aware-cross-seed-cpsat",
                            "Packing-aware Cross-Seed CP-SAT",
                            DEFAULT_SEARCH_STRATEGY.first_solution_strategy,
                            DEFAULT_SEARCH_STRATEGY.local_search_metaheuristic,
                        )
                        cross_candidate = (
                            cross_strategy,
                            combined_plan,
                            combined_obj.selection_score_vnd,
                        )
                        best_existing_key = min(
                            _candidate_selection_key(run, compare_horizons)
                            for run in complete_runs
                        )
                        if _candidate_selection_key(cross_candidate, compare_horizons) < best_existing_key:
                            evaluated_runs.append(cross_candidate)
                            cross_seed_applied = True

        candidates, fully_served_count, diagnostics = select_ranked_candidates(
            evaluated_runs,
            all_order_ids,
            max_candidates=max_candidates,
            max_routes_per_day=self.request.policy.max_routes_per_day,
            compare_horizons=compare_horizons,
            expected_items=expected_items,
        )

        if calculator is None and any(candidate.result.routes for candidate in candidates):
            calculator, direct_metric = self._direct_benchmark()
        if calculator is not None and direct_metric is not None:
            for candidate in candidates:
                plan = candidate.result
                plan.benchmarks = calculator.build_comparison(
                    plan.routes,
                    plan.total_cost_vnd,
                    plan.total_distance_km,
                    plan.total_duration_minutes,
                    ortools_is_feasible=plan.status == "SUCCESS",
                    direct_metric=direct_metric,
                )
        batch_diagnostics = [
            (
                "Hybrid-first: "
                f"đã nhận {hybrid_success_count}/{len(hybrid_seeds)} "
                "nghiệm Hybrid có tuyến; "
                f"độ phức tạp {self.policy.complexity_score}, "
                f"ngân sách tổng {job_budget:g} giây, "
                f"{seed_budget_detail}."
            ),
        ]
        if ils_success_count:
            batch_diagnostics.append(
                "Đa họ thuật toán: đã đánh giá thêm Packing-aware ILS song song "
                "và xếp hạng chung theo chuẩn tối ưu sản xuất."
            )
        if cross_seed_applied:
            batch_diagnostics.append(
                "Tổ hợp chéo đa seed: CP-SAT đã ghép các tuyến 3D hợp lệ từ nhiều seed để cải thiện nghiệm."
            )
        if adaptive_search:
            batch_diagnostics.append(
                f"Ngưỡng {self.request.early_stop_patience} phương án hợp lệ không cải thiện "
                "được áp dụng riêng cho từng seed."
            )
        if ortools_fallback_used:
            batch_diagnostics.append(
                "Hybrid chưa giao đủ toàn bộ đơn; "
                "đã chạy đúng 1 lượt OR-Tools fallback."
            )
        if exhaustive_fallback_diagnostic:
            batch_diagnostics.append(exhaustive_fallback_diagnostic)
        if self.pruned_virtual_vehicle_count:
            batch_diagnostics.append(
                f"Đã loại sớm {self.pruned_virtual_vehicle_count} khung xe-ngày "
                "không thể tự phục vụ bất kỳ đơn nào."
            )
        if self.unchecked_split_order_count:
            batch_diagnostics.extend(self._preprocessing_timeout_notes())
        if search_errors:
            batch_diagnostics.append(
                f"Có {len(search_errors)} lượt Hybrid gặp lỗi: "
                f"{'; '.join(search_errors[:2])}"
            )
        batch_diagnostics.extend(diagnostics)

        return FleetOptimizationBatchResponse(
            job_id=self.request.job_id,
            solver_run_count=len(evaluated_runs),
            fully_served_candidate_count=fully_served_count,
            rank_by_objective_first=compare_horizons,
            no_plan_status=None if candidates else "NO_COMPLETE_PLAN",
            candidates=candidates,
            diagnostics=batch_diagnostics,
        )


_REAL_DIRECT_SPAN_METHOD = MultiStartFleetOptimizer._search_direct_span
