"""Hybrid-first fleet optimization with a bounded OR-Tools fallback.

Tiny problems use exhaustive search. Larger problems spend their selected
budget on independent packing-aware Hybrid ALNS seeds, validate every result,
and invoke one OR-Tools search only when Hybrid cannot produce any route.
"""

import time
from typing import Dict, List, Optional, Set, Tuple

from .models import (
    FleetOptimizationBatchResponse,
    FleetOptimizationCandidate,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    PlanningObjectiveBreakdown,
)
from .routing_solver import FleetRoutingSolver
from .request_preprocessor import prune_unserviceable_virtual_resources
from .search_policy import AdaptiveSearchPolicy, derive_search_policy
from .search_strategies import (
    DEFAULT_SEARCH_STRATEGY,
    SEARCH_STRATEGIES,
    SearchStrategy,
    find_search_strategy,
)
from .hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from .planning_objective import apply_planning_objective

_REAL_HYBRID_OPTIMIZER = PackingAwareHybridALNSOptimizer


def _run_hybrid_seed_worker(
    request_dict: dict,
    objective_request_dict: dict,
    seed: int,
    time_budget: float,
) -> Tuple[int, Optional[dict], Optional[dict], Optional[str]]:
    """Worker function for concurrent Hybrid ALNS seeds compatible with Windows spawn."""
    try:
        request = FleetOptimizationRequest(**request_dict)
        objective_request = FleetOptimizationRequest(**objective_request_dict)
        hybrid = PackingAwareHybridALNSOptimizer(
            request,
            time_budget_seconds=time_budget,
            random_seed=seed,
            initial_plan=None,
        )
        plan = hybrid.solve()
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
                route.route_id or route.vehicle_id,
                tuple(
                    (stop.stop_type, stop.allocation_id or stop.order_id)
                    for stop in route.stops
                ),
            )
            for route in plan.routes
        )
    )


def is_fully_served(
    plan: FleetOptimizationResponse,
    all_order_ids: Set[str],
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
    for route in plan.routes:
        previous_departure_sec = route.start_time_sec
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
            if allocation_id:
                served_order_ids.add(allocation_id)

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

    return True


def select_ranked_candidates(
    evaluated_runs: List[Tuple[SearchStrategy, FleetOptimizationResponse, int]],
    all_order_ids: Set[str],
    max_candidates: int = 3,
) -> Tuple[List[FleetOptimizationCandidate], int, List[str]]:
    """Pure selection and ranking function to allow isolated unit testing.

    Returns:
        (candidates, fully_served_count, diagnostics)
    """
    diagnostics: List[str] = []
    fully_served_runs = [
        (strategy, plan, objective)
        for strategy, plan, objective in evaluated_runs
        if is_fully_served(plan, all_order_ids)
    ]
    fully_served_count = len(fully_served_runs)

    if fully_served_runs:
        # Rank by the shared planning objective. Operating cost is only the
        # tie-breaker because it excludes paid idle salary and operational
        # lateness when the financial penalty policy is disabled.
        fully_served_runs.sort(
            key=lambda item: (item[2], item[1].total_cost_vnd)
        )

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

    # Fallback when no search managed to deliver 100% of orders:
    # Select exactly 1 best feasible/partial attempt with lowest unassigned orders
    diagnostics.append(
        "Cảnh báo: Không có lượt tìm kiếm nào giao đủ 100% đơn. "
        "Hiển thị 1 phương án khả thi có tỷ lệ phục vụ cao nhất để hỗ trợ điều phối."
    )
    evaluated_runs.sort(
        key=lambda item: (
            len(item[1].unassigned_orders),
            item[2],
            item[1].total_cost_vnd,
        )
    )
    fallback_strategy, fallback_plan, fallback_obj = evaluated_runs[0]
    return [
        FleetOptimizationCandidate(
            rank=1,
            search_strategy=fallback_strategy.label,
            solver_objective=fallback_obj,
            is_best_found=True,
            result=fallback_plan,
        )
    ], 0, diagnostics


class MultiStartFleetOptimizer:
    """Manages Hybrid seed runs, validation, ranking, and OR-Tools fallback."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        strategies: Optional[List[SearchStrategy]] = None,
    ):
        self.objective_request = request
        self.request, self.pruned_virtual_vehicle_count = (
            prune_unserviceable_virtual_resources(request)
        )
        self.policy: AdaptiveSearchPolicy = derive_search_policy(self.request)
        physical_vehicle_ids = {
            vehicle.source_vehicle_id or vehicle.id
            for vehicle in self.request.vehicles
        }
        self.use_exhaustive_search = (
            strategies is None
            and 1 <= len(self.request.orders) <= 3
            and len(physical_vehicle_ids) <= 2
        )
        self.strategies = (
            list(strategies)
            if strategies is not None
            else list(SEARCH_STRATEGIES[: self.policy.strategy_count])
        )

    def solve(self, max_candidates: int = 3) -> FleetOptimizationBatchResponse:
        search_budget_seconds = float(self.policy.time_budget_seconds)
        exhaustive_fallback_diagnostic: Optional[str] = None
        if self.use_exhaustive_search:
            exhaustive_started_at = time.monotonic()
            exhaustive = FleetRoutingSolver(
                self.request,
                time_budget_seconds=self.policy.time_budget_seconds,
            ).solve_exhaustive_tiny_candidates(max_candidates=max_candidates)
            if exhaustive.plans:
                for plan in exhaustive.plans:
                    apply_planning_objective(self.objective_request, plan)
                ranked_plans = sorted(
                    exhaustive.plans,
                    key=lambda plan: (
                        plan.planning_objective.selection_score_vnd,
                        plan.total_cost_vnd,
                    ),
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
        hybrid_seeds = (
            (0, 1)
            if search_budget_seconds >= 48.0 and len(self.request.orders) >= 8
            else (0,)
        )
        hybrid_run_budget = search_budget_seconds / len(hybrid_seeds)

        is_mocked = PackingAwareHybridALNSOptimizer is not _REAL_HYBRID_OPTIMIZER
        if len(hybrid_seeds) > 1 and not is_mocked:
            import concurrent.futures
            objective_request_dict = self.objective_request.model_dump()
            with concurrent.futures.ProcessPoolExecutor(max_workers=len(hybrid_seeds)) as executor:
                futures = {
                    executor.submit(
                        _run_hybrid_seed_worker,
                        request_dict,
                        objective_request_dict,
                        seed,
                        hybrid_run_budget,
                    ): seed
                    for seed in hybrid_seeds
                }
                for future in concurrent.futures.as_completed(futures):
                    seed = futures[future]
                    try:
                        seed_res, plan_dict, obj_dict, err = future.result(
                            timeout=hybrid_run_budget + 15.0
                        )
                        if err or plan_dict is None:
                            search_errors.append(
                                f"Packing-aware Hybrid ALNS (seed {seed}): {err}"
                            )
                            continue
                        hybrid_plan = FleetOptimizationResponse(**plan_dict)
                        planning_obj = PlanningObjectiveBreakdown(**obj_dict)
                        hybrid_plan.planning_objective = planning_obj
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
                                planning_obj.selection_score_vnd,
                            )
                        )
                    except Exception as exc:
                        search_errors.append(
                            f"Packing-aware Hybrid ALNS (seed {seed}): {exc}"
                        )
        else:
            for seed in hybrid_seeds:
                try:
                    hybrid = PackingAwareHybridALNSOptimizer(
                        self.request,
                        time_budget_seconds=hybrid_run_budget,
                        random_seed=seed,
                        initial_plan=None,
                    )
                    hybrid_plan = hybrid.solve()
                    if not hybrid_plan.routes:
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

        hybrid_success_count = len(evaluated_runs)
        ortools_fallback_used = False
        if not evaluated_runs:
            fallback_strategy = (
                self.strategies[0]
                if self.strategies
                else DEFAULT_SEARCH_STRATEGY
            )
            _, _, plan_dict, _, error = _run_search_worker(
                request_dict,
                fallback_strategy.key,
                search_budget_seconds,
                self.policy.stagnation_seconds,
                self.policy.routing_budget_share,
                self.policy.validation_budget_share,
                self.policy.consolidation_budget_share,
            )
            if error is not None or plan_dict is None:
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
        )

        batch_diagnostics = [
            (
                "Hybrid-first: "
                f"đã nhận {hybrid_success_count}/{len(hybrid_seeds)} "
                "nghiệm Hybrid có tuyến; "
                f"độ phức tạp {self.policy.complexity_score}, "
                f"ngân sách tổng {search_budget_seconds:g} giây, "
                f"{hybrid_run_budget:g} giây/seed."
            ),
        ]
        if ortools_fallback_used:
            batch_diagnostics.append(
                "Hybrid không trả được tuyến; "
                "đã chạy đúng 1 lượt OR-Tools fallback."
            )
        if exhaustive_fallback_diagnostic:
            batch_diagnostics.append(exhaustive_fallback_diagnostic)
        if self.pruned_virtual_vehicle_count:
            batch_diagnostics.append(
                f"Đã loại sớm {self.pruned_virtual_vehicle_count} khung xe-ngày "
                "không thể tự phục vụ bất kỳ đơn nào."
            )
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
            candidates=candidates,
            diagnostics=batch_diagnostics,
        )
