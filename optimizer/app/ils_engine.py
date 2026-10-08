"""Packing-aware Iterated Local Search for the production fleet contract.

The algorithm keeps the production validator as the source of truth.  Its
neighborhood only contains pickup/delivery relocations that pass payload,
time-window, vehicle-availability and fast packing checks; the returned plan
is then audited again by ``SpatialValidator``.
"""

import copy
import time
from typing import List, Optional, Tuple

from .alns_engine import ALNSFleetOptimizer
from .models import FleetOptimizationRequest, FleetOptimizationResponse, ScheduledStop


class PackingAwareILSOptimizer(ALNSFleetOptimizer):
    """Best-improvement relocation with ruin/recreate perturbations."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        max_iterations: int = 150,
        time_budget_seconds: Optional[float] = None,
        random_seed: int = 0,
    ) -> None:
        super().__init__(
            request,
            max_iterations=max_iterations,
            time_budget_seconds=time_budget_seconds,
            random_seed=random_seed,
        )

    @staticmethod
    def _assigned_order_ids(routes: List[List[ScheduledStop]]) -> List[str]:
        return list(
            dict.fromkeys(
                stop.allocation_id or stop.order_id
                for route in routes
                for stop in route
                if stop.stop_type == "PICKUP"
                and (stop.allocation_id or stop.order_id)
            )
        )

    @staticmethod
    def _remove_order(
        routes: List[List[ScheduledStop]], order_id: str
    ) -> List[List[ScheduledStop]]:
        return [
            [
                stop
                for stop in route
                if (stop.allocation_id or stop.order_id) != order_id
            ]
            for route in routes
        ]

    def _best_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        started_at: float,
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        current_cost, _, _ = self._evaluate_plan_cost(routes, unassigned)
        best_neighbor: Optional[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = None
        assigned = self._assigned_order_ids(routes)
        self.rng.shuffle(assigned)

        for order_id in assigned[: min(12, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_order(routes, order_id)
            candidate_routes, failed = self._repair_greedy_insert(
                copy.deepcopy(reduced), [order_id], start_time=started_at
            )
            candidate_unassigned = list(dict.fromkeys(unassigned + failed))
            candidate_cost, _, _ = self._evaluate_plan_cost(
                candidate_routes, candidate_unassigned
            )
            if candidate_cost >= current_cost:
                continue
            if best_neighbor is None or candidate_cost < best_neighbor[0]:
                best_neighbor = (
                    candidate_cost,
                    candidate_routes,
                    candidate_unassigned,
                )
        return best_neighbor

    def solve(self) -> FleetOptimizationResponse:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        current_routes: List[List[ScheduledStop]] = [
            [] for _ in self.vehicles
        ]
        current_routes, current_unassigned = self._repair_greedy_insert(
            current_routes,
            [order.id for order in self.orders],
            start_time=started_at,
            randomize=False,
        )
        current_cost, _, _ = self._evaluate_plan_cost(
            current_routes, current_unassigned
        )
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        iteration = 0
        perturbation = 0

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            iteration += 1
            neighbor = self._best_relocation(
                current_routes,
                current_unassigned,
                started_at,
                deadline,
            )
            if neighbor is not None:
                current_cost, current_routes, current_unassigned = neighbor
                if current_cost < best_cost:
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                    perturbation = 0
                continue

            assigned_count = len(self._assigned_order_ids(best_routes))
            if assigned_count == 0 or time.perf_counter() >= deadline:
                break

            perturbation += 1
            removal_ratio = min(0.4, 0.15 + 0.05 * perturbation)
            remove_count = min(
                assigned_count,
                max(2, round(assigned_count * removal_ratio)),
            )
            perturbed, removed = self._destroy_random(
                copy.deepcopy(best_routes), remove_count
            )
            current_routes, failed = self._repair_greedy_insert(
                perturbed,
                list(dict.fromkeys(best_unassigned + removed)),
                start_time=started_at,
            )
            current_unassigned = failed
            current_cost, _, _ = self._evaluate_plan_cost(
                current_routes, current_unassigned
            )
            if current_cost < best_cost:
                best_cost = current_cost
                best_routes = copy.deepcopy(current_routes)
                best_unassigned = list(current_unassigned)
                perturbation = 0

        response = self._build_final_response(best_routes, best_unassigned)
        response.diagnostics = [
            diagnostic
            for diagnostic in response.diagnostics
            if not diagnostic.startswith("ALNS hoàn tất:")
        ] + [
            "Packing-aware ILS hoàn tất "
            f"{iteration} vòng với seed {self.random_seed}: "
            f"{len(response.routes)} tuyến hợp lệ, "
            f"{len(response.unassigned_orders)} đơn chưa phân công.",
            "Kết quả là best-found trong ngân sách thời gian, không chứng minh tối ưu toàn cục.",
        ]
        return response
