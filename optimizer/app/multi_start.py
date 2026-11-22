"""Hybrid-first fleet optimization with a bounded OR-Tools fallback.

Tiny problems use exhaustive search. Larger problems spend their selected
budget on independent packing-aware Hybrid ALNS seeds, validate every result,
and invoke one OR-Tools search only when Hybrid cannot produce any route.
"""

import concurrent.futures
import math
import os
import time
from typing import Dict, List, Optional, Set, Tuple

from .models import (
    BenchmarkMetric,
    FleetOptimizationBatchResponse,
    FleetOptimizationCandidate,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    PlanningObjectiveBreakdown,
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
from .ortools_seed import extract_ortools_seed_pool
from .planning_objective import apply_planning_objective, plan_lexicographic_key
from .baseline_calculator import BaselineCostCalculator

_REAL_HYBRID_OPTIMIZER = PackingAwareHybridALNSOptimizer
# Order splitting is a reduction, not the search itself; cap its share so
# package-heavy batches still leave the solver most of the budget.
ORDER_SPLIT_BUDGET_SHARE = 0.2
DIRECT_BENCHMARK_BUDGET_SECONDS = 20.0
MAX_PARALLEL_HYBRID_SEEDS = 3


def _run_hybrid_seed_worker(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
    warm_plan: Optional[dict] = None,
) -> Tuple[int, Optional[dict], Optional[dict], Optional[str]]:
    """Worker function for concurrent Hybrid ALNS seeds compatible with Windows spawn."""
    try:
        request = FleetOptimizationRequest(**request_dict)
        objective_request = FleetOptimizationRequest(**objective_request_dict)
        worker_deadline = time.perf_counter() + max(0.5, float(time_budget))
        initial_plan = FleetOptimizationResponse.model_validate(warm_plan) if warm_plan is not None else None
        expected_items = {order.id: {item.id for item in order.items} for order in request.orders}
        hybrid = PackingAwareHybridALNSOptimizer(
            request,
            time_budget_seconds=time_budget,
            random_seed=seed,
            initial_plan=initial_plan,
            initial_plan_is_verified=initial_plan is not None and is_fully_served(
                initial_plan, set(expected_items), request.policy.max_routes_per_day, expected_items,
            ),
            should_split_orders=False,
            include_benchmarks=False,
        )
        plan = hybrid.solve(hard_deadline=worker_deadline)
        if not plan.routes:
            return seed, None, None, f"Packing-aware Hybrid ALNS (seed {seed}) không trả về tuyến."
        obj = apply_planning_objective(objective_request, plan)
        return seed, plan.model_dump(), obj.model_dump(), None
    except Exception as exc:
        return seed, None, None, str(exc)


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
    ):
        self._created_at = time.perf_counter()
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

    def _direct_benchmark(self) -> Tuple[BaselineCostCalculator, BenchmarkMetric]:
        nodes = FleetRoutingSolver(self.objective_request, should_split_orders=False).nodes
        budget = min(60.0, max(DIRECT_BENCHMARK_BUDGET_SECONDS, len(self.objective_request.orders) * 0.4))
        calculator = BaselineCostCalculator(self.objective_request, nodes, deadline=time.perf_counter() + budget)
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
            if improved is not verified and is_fully_served(
                improved, order_ids, max_routes_per_day, expected_items,
            ):
                return improved
            return verified
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
        search_errors: List[str] = []
        is_mocked = PackingAwareHybridALNSOptimizer is not _REAL_HYBRID_OPTIMIZER
        calculator = None
        direct_metric = None
        short_plan = None
        target_days = 0
        if not is_mocked:
            started = time.perf_counter()
            calculator, direct_metric = self._direct_benchmark()
            job_deadline += time.perf_counter() - started  # Direct has its own budget.
            if direct_metric.is_feasible and direct_metric.planning_span_days:
                target_days = direct_metric.planning_span_days
                slots = [i for i, v in enumerate(self.request.vehicles) if v.service_day_index < target_days]
                remaining = job_deadline - time.perf_counter()
                if remaining * 0.30 >= 0.5:
                    try:
                        challenger = self._search_direct_span(
                            slots, direct_metric, time.perf_counter() + remaining * 0.30,
                        )
                        if challenger is not None and challenger.routes:
                            objective = apply_planning_objective(self.objective_request, challenger)
                            strategy = SearchStrategy(
                                "hybrid-direct-span", f"Hybrid ALNS trong {target_days} ngày",
                                DEFAULT_SEARCH_STRATEGY.first_solution_strategy,
                                DEFAULT_SEARCH_STRATEGY.local_search_metaheuristic,
                            )
                            evaluated_runs.append((strategy, challenger, objective.selection_score_vnd))
                            if is_fully_served(challenger, all_order_ids, self.request.policy.max_routes_per_day,
                                               {o.id: {i.id for i in o.items} for o in self.request.orders}):
                                short_plan = challenger
                    except Exception as error:
                        search_errors.append(f"Hybrid ALNS trong {target_days} ngày: {error}")
        total_items = sum(len(o.items) for o in self.request.orders)
        cpu_count = os.cpu_count() or 1
        use_single_seed_for_scale = (
            not is_mocked
            and (cpu_count <= 2 or len(self.request.orders) >= 80 or total_items >= 500)
        )
        if self.request.hybrid_seed_count:
            hybrid_seeds = tuple(range(self.request.hybrid_seed_count))
        elif not use_single_seed_for_scale and search_budget_seconds >= 48.0 and len(self.request.orders) >= 8:
            hybrid_seeds = (0, 1)
        else:
            hybrid_seeds = (0,)
        hybrid_run_budget = search_budget_seconds / len(hybrid_seeds)
        seed_budget_detail = f"{hybrid_run_budget:g} giây/seed"

        compare_horizons = len({v.service_day_index for v in self.request.vehicles}) > 1
        timed_out_seed_plan: Optional[FleetOptimizationResponse] = None
        if (adaptive_search or len(hybrid_seeds) > 1) and not is_mocked:
            objective_request_dict = self.objective_request.model_dump()
            remaining_parallel = max(1.0, job_deadline - time.perf_counter())
            effective_run_budget = min(
                remaining_parallel,
                remaining_parallel * 0.9 if adaptive_search
                else max(hybrid_run_budget, search_budget_seconds * 0.85),
            )
            parallel_workers = min(len(hybrid_seeds), MAX_PARALLEL_HYBRID_SEEDS)
            secondary_seed_budget = effective_run_budget
            seed_budget_detail = f"{effective_run_budget:g} giây/seed"
            if len(hybrid_seeds) > parallel_workers:
                # Keep one deeper search while the other workers test more seeds.
                secondary_waves = math.ceil((len(hybrid_seeds) - 1) / (parallel_workers - 1))
                secondary_seed_budget = effective_run_budget / secondary_waves
                seed_budget_detail = (
                    f"seed 0: {effective_run_budget:g} giây, "
                    f"các seed còn lại: {secondary_seed_budget:g} giây/seed, "
                    f"tối đa {parallel_workers} seed đồng thời"
                )
            executor = concurrent.futures.ProcessPoolExecutor(max_workers=parallel_workers)
            best_by_seed = {}
            expected_items = {order.id: {item.id for item in order.items} for order in self.request.orders}
            try:
                futures = {}
                for seed in hybrid_seeds:
                    initial = short_plan.model_dump() if seed == 0 and short_plan is not None else None
                    budget = effective_run_budget if seed == 0 else secondary_seed_budget
                    bootstrap_budget = search_budget_seconds * 0.85
                    if seed != 0 and len(hybrid_seeds) > parallel_workers:
                        bootstrap_budget /= secondary_waves
                    bootstrap_budget = min(budget, bootstrap_budget)
                    refine_budget = budget - bootstrap_budget if adaptive_search else 0
                    # Return an audited checkpoint before a longer refinement can
                    # exhaust its time. The parent keeps it across worker timeouts.
                    if refine_budget >= 2:
                        future = executor.submit(
                            _run_hybrid_seed_worker,
                            {**request_dict, "early_stop_patience": 0},
                            objective_request_dict, seed, bootstrap_budget, initial,
                        )
                    else:
                        refine_budget = 0
                        future = executor.submit(
                            _run_hybrid_seed_worker, request_dict, objective_request_dict, seed, budget, initial,
                        )
                    futures[future] = (seed, refine_budget)

                pool_deadline = job_deadline + (0 if adaptive_search else 2.0)
                while futures:
                    done, _ = concurrent.futures.wait(
                        futures, timeout=max(0.0, pool_deadline - time.perf_counter()),
                        return_when=concurrent.futures.FIRST_COMPLETED,
                    )
                    if not done:
                        break
                    for future in sorted(done, key=lambda item: futures[item][0]):
                        seed, refine_budget = futures.pop(future)
                        warm_plan = None
                        try:
                            _, plan_dict, obj_dict, error = future.result()
                            if error or plan_dict is None or obj_dict is None:
                                raise RuntimeError(error or "Không có phương án đã kiểm chứng")
                            hybrid_plan = FleetOptimizationResponse.model_validate(plan_dict)
                            planning_obj = PlanningObjectiveBreakdown.model_validate(obj_dict)
                            hybrid_plan.planning_objective = planning_obj
                            hybrid_strategy = SearchStrategy(
                                f"packing-aware-hybrid-alns-seed-{seed}",
                                f"Packing-aware Hybrid ALNS (seed {seed})",
                                DEFAULT_SEARCH_STRATEGY.first_solution_strategy,
                                DEFAULT_SEARCH_STRATEGY.local_search_metaheuristic,
                            )
                            candidate = (hybrid_strategy, hybrid_plan, planning_obj.selection_score_vnd)
                            complete = is_fully_served(
                                hybrid_plan, all_order_ids, self.request.policy.max_routes_per_day, expected_items,
                            )
                            rank = (
                                not complete,
                                len(hybrid_plan.unassigned_orders),
                                *_candidate_selection_key(candidate, compare_horizons),
                            )
                            bucket = (seed, _plan_days(hybrid_plan))
                            previous = best_by_seed.get(bucket)
                            if previous is None or rank <= previous[0]:
                                best_by_seed[bucket] = (rank, candidate)
                            else:
                                previous[1][1].diagnostics.extend(
                                    note for note in hybrid_plan.diagnostics if note.startswith(f"Seed {seed} dừng sớm")
                                )
                            if complete:
                                warm_plan = plan_dict
                        except Exception as error:
                            search_errors.append(f"Packing-aware Hybrid ALNS (seed {seed}): {error}")

                        remaining_refine_budget = min(refine_budget, job_deadline - time.perf_counter())
                        if remaining_refine_budget >= 2:
                            refinement = executor.submit(
                                _run_hybrid_seed_worker, request_dict, objective_request_dict,
                                seed, remaining_refine_budget, warm_plan,
                            )
                            futures[refinement] = (seed, 0)

                for future, (seed, _) in futures.items():
                    future.cancel()
                    search_errors.append(f"Packing-aware Hybrid ALNS (seed {seed}): vượt quá giới hạn thời gian.")
                evaluated_runs.extend(best_by_seed[seed][1] for seed in sorted(best_by_seed))
            finally:
                processes = getattr(executor, "_processes", None)
                if processes:
                    for proc in list(processes.values()):
                        if proc.is_alive():
                            proc.terminate()
                executor.shutdown(wait=False, cancel_futures=True)
        else:
            for seed in hybrid_seeds:
                remaining_for_seed = job_deadline - time.perf_counter()
                if remaining_for_seed <= 0.5 and not is_mocked:
                    search_errors.append(
                        f"Hết ngân sách trước khi chạy Packing-aware Hybrid ALNS (seed {seed})."
                    )
                    break
                seed_budget = (
                    hybrid_run_budget
                    if is_mocked
                    else min(hybrid_run_budget, max(0.5, remaining_for_seed))
                )
                seed_deadline = time.perf_counter() + seed_budget
                try:
                    ortools_seed_pool = None
                    max_items_per_order = max((len(o.items) for o in self.request.orders), default=0)
                    if not is_mocked and len(self.request.orders) >= 2 and seed_budget >= 3.0 and max_items_per_order < 20:
                        ortools_seed_pool, _ = extract_ortools_seed_pool(
                            self.request,
                            routing_seconds=min(0.95, seed_budget * 0.19),
                            stagnation_seconds=0.20,
                            should_split_orders=False,
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
                    planning_objective = apply_planning_objective(
                        self.objective_request, hybrid_plan
                    )
                    hybrid_strategy = SearchStrategy(
                        f"packing-aware-hybrid-alns-seed-{seed}",
                        f"Packing-aware Hybrid ALNS (seed {seed})",
                        DEFAULT_SEARCH_STRATEGY.first_solution_strategy,
                        DEFAULT_SEARCH_STRATEGY.local_search_metaheuristic,
                    )
                    evaluated_runs.append(
                        (
                            hybrid_strategy,
                            hybrid_plan,
                            planning_objective.selection_score_vnd,
                        )
                    )
                except Exception as exc:
                    search_errors.append(
                        f"Packing-aware Hybrid ALNS (seed {seed}): {exc}"
                    )

        hybrid_success_count = len({strategy.key for strategy, _, _ in evaluated_runs if strategy.key != "hybrid-direct-span"})
        ortools_fallback_used = False
        expected_items = {o.id: {i.id for i in o.items} for o in self.request.orders}
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
        if target_days and not any(is_fully_served(plan, all_order_ids, self.request.policy.max_routes_per_day,
                                                  {o.id: {i.id for i in o.items} for o in self.request.orders})
                                   and _plan_days(plan) <= target_days for _, plan, _ in evaluated_runs):
            batch_diagnostics.append(
                f"Direct giao đủ trong {target_days} ngày. Trong ngân sách lần chạy này, "
                "Hybrid chưa tìm được lịch ghép giao đủ trong cùng số ngày."
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
