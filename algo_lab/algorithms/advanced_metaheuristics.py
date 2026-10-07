"""Additional packing-aware metaheuristics for the diverse-dataset benchmark.

All solvers reuse the same route scheduler, cost model and fast conservative
packing filter as Hybrid ALNS. A returned solution is always audited by the
production ``SpatialValidator`` before it can be reported as valid.
"""

import copy
import math
import time
from typing import Dict, List, Optional, Sequence, Tuple

from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.algorithms.hybrid_alns import HybridALNSSolver
from algo_lab.common.models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from algo_lab.common.solution_validator import (
    audit_solution,
    repair_and_audit_solution,
)


PlanCandidate = Tuple[int, List[List[ScheduledStop]], List[str]]


class _AdvancedSearchBase(HybridALNSSolver):
    """Shared construction and final independent audit for VNS and Tabu."""

    def __init__(
        self,
        *args,
        final_spatial_time_limit_sec: float = 1.5,
        final_repair_time_limit_sec: Optional[float] = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if final_repair_time_limit_sec is not None and final_repair_time_limit_sec <= 0:
            raise ValueError("final_repair_time_limit_sec must be greater than zero")
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.final_repair_time_limit_sec = final_repair_time_limit_sec

    def _initial_state(self) -> Tuple[List[List[ScheduledStop]], List[str]]:
        greedy = self.initial_solution or solve_greedy(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
        )
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        vehicle_index = {vehicle.id: index for index, vehicle in enumerate(self.vehicles)}
        for route in greedy.routes:
            routes[vehicle_index[route.vehicle.id]] = copy.deepcopy(route.stops)
        assigned = set(self._assigned_order_ids(routes))
        unassigned = [order.id for order in self.orders if order.id not in assigned]
        return routes, unassigned

    def _randomized_construction(
        self,
        deadline: float,
        *,
        alpha: float,
        order_sequence: Optional[Sequence[str]] = None,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Build a feasible plan with a restricted candidate list.

        ``alpha=0`` is deterministic best insertion for the supplied order
        sequence. Higher values admit more near-best insertions and create the
        diversity required by GRASP and the memetic population.
        """
        if not 0.0 <= alpha <= 1.0:
            raise ValueError("alpha must be between zero and one")
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        pending = list(order_sequence or (order.id for order in self.orders))
        if order_sequence is None:
            self.rng.shuffle(pending)
        unassigned: List[str] = []

        for order_index, order_id in enumerate(pending):
            if time.perf_counter() >= deadline:
                unassigned.extend(
                    remaining_id
                    for remaining_id in pending[order_index:]
                    if remaining_id not in unassigned
                )
                break
            options = self._insertions_for_order(
                order_id,
                routes,
                deadline,
                limit=max(4, min(12, len(self.vehicles) * 2)),
            )
            if not options:
                unassigned.append(order_id)
                continue
            best_delta = options[0].delta_cost
            worst_delta = options[-1].delta_cost
            threshold = best_delta + alpha * (worst_delta - best_delta)
            restricted = [
                option for option in options if option.delta_cost <= threshold
            ]
            selected = self.rng.choice(restricted or [options[0]])
            routes[selected.vehicle_index] = selected.stops

        return routes, list(dict.fromkeys(unassigned))

    def _best_relocation_candidate(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
        *,
        sample_limit: int = 12,
        option_limit: int = 6,
    ) -> Optional[PlanCandidate]:
        incumbent_cost = self._plan_cost(routes, unassigned)
        best_neighbor: Optional[PlanCandidate] = None
        assigned = list(dict.fromkeys(self._assigned_order_ids(routes)))
        self.rng.shuffle(assigned)

        for order_id in assigned[: min(sample_limit, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_orders(routes, {order_id})
            options = self._insertions_for_order(
                order_id, reduced, deadline, limit=option_limit
            )
            for option in options:
                candidate_routes = copy.deepcopy(reduced)
                candidate_routes[option.vehicle_index] = option.stops
                candidate_cost = self._plan_cost(candidate_routes, unassigned)
                if candidate_cost >= incumbent_cost:
                    continue
                if best_neighbor is None or candidate_cost < best_neighbor[0]:
                    best_neighbor = (
                        candidate_cost,
                        candidate_routes,
                        list(unassigned),
                    )
        return best_neighbor

    def _finalize(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        started_at: float,
        solver_name: str,
        *,
        spatial_time_limit_sec: float = 1.5,
        repair_time_limit_sec: Optional[float] = None,
    ) -> OptimizationSolution:
        optimized_routes: List[OptimizedRoute] = []
        total_cost = 0
        total_distance = 0.0
        unassigned_ids = list(dict.fromkeys(unassigned))

        for vehicle_index, stops in enumerate(routes):
            if not stops:
                continue
            evaluation = self._evaluate_route(vehicle_index, stops)
            if not evaluation.feasible or evaluation.cost is None:
                unassigned_ids.extend(
                    stop.order_id
                    for stop in stops
                    if stop.stop_type == "PICKUP" and stop.order_id
                )
                continue
            optimized_routes.append(
                OptimizedRoute(
                    vehicle=self.vehicles[vehicle_index],
                    driver=self.drivers[vehicle_index],
                    stops=evaluation.stops,
                    total_distance_km=evaluation.distance_km,
                    total_duration_minutes=evaluation.duration_minutes,
                    cost_breakdown=evaluation.cost,
                )
            )
            total_cost += evaluation.cost.total_cost_vnd
            total_distance += evaluation.distance_km

        unassigned_ids = list(dict.fromkeys(unassigned_ids))
        solution = OptimizationSolution(
            solver_name=solver_name,
            execution_time_sec=0.0,
            routes=optimized_routes,
            unassigned_orders=[
                self.order_by_id[order_id].order_number for order_id in unassigned_ids
            ],
            real_economic_cost_vnd=total_cost,
            penalized_objective_vnd=(
                total_cost
                + len(unassigned_ids) * self.policy.unassigned_order_penalty_vnd
            ),
            total_distance_km=round(total_distance, 2),
            fulfillment_rate=round(
                (len(self.orders) - len(unassigned_ids))
                / max(1, len(self.orders))
                * 100.0,
                1,
            ),
            is_spatial_valid=False,
            spatial_notes="Chưa chạy validator độc lập",
            random_seed=self.random_seed,
        )
        if repair_time_limit_sec is None:
            audit_solution(
                solution,
                self.vehicles,
                self.drivers,
                self.orders,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
                spatial_time_limit_sec=spatial_time_limit_sec,
            )
        else:
            repair_and_audit_solution(
                solution,
                self.vehicles,
                self.drivers,
                self.orders,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
                spatial_time_limit_sec=spatial_time_limit_sec,
                repair_time_limit_sec=repair_time_limit_sec,
            )
        solution.execution_time_sec = round(time.perf_counter() - started_at, 3)
        return solution

    @staticmethod
    def _plan_signature(
        routes: List[List[ScheduledStop]], unassigned: List[str]
    ) -> Tuple[Tuple[Tuple[Tuple[str, str], ...], ...], Tuple[str, ...]]:
        return (
            tuple(
                tuple((stop.stop_type, stop.order_id or "") for stop in route)
                for route in routes
            ),
            tuple(sorted(set(unassigned))),
        )

    def _finalize_best_valid(
        self,
        candidates: List[PlanCandidate],
        fallback: PlanCandidate,
        started_at: float,
        solver_name: str,
        *,
        spatial_time_limit_sec: float,
        repair_time_limit_sec: float,
        max_audit_candidates: int = 16,
    ) -> OptimizationSolution:
        """Return the cheapest independently verified elite plan.

        The neighborhood search uses a conservative fast packing heuristic, but
        its cheapest plan can still be inconclusive for the bounded production
        validator.  Keep several improving incumbents and audit them in cost
        order instead of discarding the last known-good starting plan.
        """
        unique_candidates: List[PlanCandidate] = []
        seen = set()
        for candidate in sorted(candidates, key=lambda row: row[0]):
            signature = self._plan_signature(candidate[1], candidate[2])
            if signature in seen:
                continue
            seen.add(signature)
            unique_candidates.append(candidate)

        for rank, (_, routes, unassigned) in enumerate(
            unique_candidates[:max_audit_candidates], start=1
        ):
            solution = self._finalize(
                copy.deepcopy(routes),
                list(unassigned),
                started_at,
                f"{solver_name}, verified elite #{rank}",
                spatial_time_limit_sec=spatial_time_limit_sec,
                repair_time_limit_sec=repair_time_limit_sec,
            )
            if (
                solution.is_contract_valid
                and solution.is_temporally_valid
                and solution.is_spatial_valid
            ):
                # Candidates are already ordered by the same penalized cost
                # recomputed by the audit, so the first valid plan is the
                # cheapest valid elite. Continuing would only repeat costly
                # production geometry checks without changing the winner.
                solution.execution_time_sec = round(
                    time.perf_counter() - started_at, 3
                )
                return solution

        if unique_candidates:
            # Preserve the elapsed search/audit time on the fallback path too.
            fallback_solution = self._finalize(
                copy.deepcopy(fallback[1]),
                list(fallback[2]),
                started_at,
                f"{solver_name}, verified fallback",
                spatial_time_limit_sec=spatial_time_limit_sec,
                repair_time_limit_sec=repair_time_limit_sec,
            )
            fallback_solution.execution_time_sec = round(
                time.perf_counter() - started_at, 3
            )
            return fallback_solution

        raise RuntimeError("Không có candidate hoặc fallback để hoàn tất nghiệm")


class PackingAwareVNSSolver(_AdvancedSearchBase):
    """Variable Neighborhood Search with ruin/recreate neighborhoods.

    Neighborhoods deliberately alternate the removed-order structure and the
    regret criterion. After a full non-improving cycle, a stronger shake starts
    another basin while the globally best feasible plan remains protected.
    """

    def __init__(
        self,
        *args,
        final_spatial_time_limit_sec: float = 5.0,
        final_repair_time_limit_sec: float = 8.0,
        max_elite_audit_candidates: int = 16,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if final_repair_time_limit_sec <= 0:
            raise ValueError("final_repair_time_limit_sec must be greater than zero")
        if max_elite_audit_candidates <= 0:
            raise ValueError("max_elite_audit_candidates must be greater than zero")
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.final_repair_time_limit_sec = final_repair_time_limit_sec
        self.max_elite_audit_candidates = max_elite_audit_candidates

    @staticmethod
    def _restart_seeds(time_limit_sec: float, base_seed: int) -> Tuple[int, ...]:
        """Use a complementary random stream only when both starts get >= 10s."""
        if time_limit_sec < 20.0:
            return (base_seed,)
        return (base_seed, base_seed + 5)

    @staticmethod
    def _restart_budgets(time_limit_sec: float) -> Tuple[float, ...]:
        """Split long budgets evenly so neither complementary start starves."""
        if time_limit_sec < 20.0:
            return (time_limit_sec,)
        strict_budget = time_limit_sec / 2.0
        return (strict_budget, time_limit_sec - strict_budget)

    def _best_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[PlanCandidate]:
        """Find the best improving single-order relocation around an incumbent."""
        incumbent_cost = self._plan_cost(routes, unassigned)
        best_neighbor: Optional[PlanCandidate] = None
        assigned = list(dict.fromkeys(self._assigned_order_ids(routes)))
        self.rng.shuffle(assigned)

        for order_id in assigned[: min(12, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_orders(routes, {order_id})
            options = self._insertions_for_order(order_id, reduced, deadline, limit=6)
            for option in options:
                candidate_routes = copy.deepcopy(reduced)
                candidate_routes[option.vehicle_index] = option.stops
                candidate_cost = self._plan_cost(candidate_routes, unassigned)
                if candidate_cost >= incumbent_cost:
                    continue
                if best_neighbor is None or candidate_cost < best_neighbor[0]:
                    best_neighbor = (
                        candidate_cost,
                        candidate_routes,
                        list(unassigned),
                    )
        return best_neighbor

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        restart_seeds = self._restart_seeds(self.time_limit_sec, self.random_seed)
        restart_budgets = self._restart_budgets(self.time_limit_sec)
        routes, unassigned = self._initial_state()
        fallback: PlanCandidate = (
            self._plan_cost(routes, unassigned),
            copy.deepcopy(routes),
            list(unassigned),
        )
        current_routes = copy.deepcopy(routes)
        current_unassigned = list(unassigned)
        current_cost = self._plan_cost(current_routes, current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        elite_candidates: List[PlanCandidate] = [fallback]
        restart_best_routes = copy.deepcopy(current_routes)
        restart_best_unassigned = list(current_unassigned)
        restart_best_cost = current_cost

        neighborhoods = (
            ("random", "greedy"),
            ("related", "regret2"),
            ("string", "regret3"),
            ("worst", "regret3"),
        )
        restart_index = 0
        restart_iteration = 0
        shake_cycle = 0
        neighborhood_index = 0
        iteration = 0
        temperature = max(1.0, current_cost * 0.02)
        self.rng.seed(restart_seeds[restart_index])

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            restart_deadline = min(
                deadline,
                started_at + sum(restart_budgets[: restart_index + 1]),
            )
            if (
                time.perf_counter() >= restart_deadline
                and restart_index + 1 < len(restart_seeds)
            ):
                restart_index += 1
                self.rng.seed(restart_seeds[restart_index])
                current_routes = copy.deepcopy(routes)
                current_unassigned = list(unassigned)
                current_cost = self._plan_cost(current_routes, current_unassigned)
                restart_best_routes = copy.deepcopy(current_routes)
                restart_best_unassigned = list(current_unassigned)
                restart_best_cost = current_cost
                restart_iteration = 0
                shake_cycle = 0
                neighborhood_index = 0
                temperature = max(1.0, current_cost * 0.02)
                continue

            iteration += 1
            restart_iteration += 1
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break
            destroy_name, repair_name = neighborhoods[neighborhood_index]
            remove_count = min(
                assigned_count,
                1 + neighborhood_index + (1 if assigned_count >= 12 else 0),
            )
            destroyed, removed = self.destroy_operators[destroy_name](
                copy.deepcopy(current_routes), remove_count
            )
            candidate_routes, candidate_unassigned = self._repair(
                destroyed,
                list(dict.fromkeys(current_unassigned + removed)),
                repair_name,
                restart_deadline,
            )
            candidate_cost = self._plan_cost(candidate_routes, candidate_unassigned)
            delta = candidate_cost - current_cost
            accepted = delta < 0
            if restart_index > 0 and not accepted:
                accepted = self.rng.random() < math.exp(
                    -delta / max(1.0, temperature)
                )
                temperature *= 0.995

            if accepted:
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost
                if delta < 0:
                    neighborhood_index = (
                        (neighborhood_index + 1) % len(neighborhoods)
                        if restart_iteration <= len(neighborhoods)
                        else 0
                    )
                else:
                    neighborhood_index = (neighborhood_index + 1) % len(
                        neighborhoods
                    )
                if candidate_cost < restart_best_cost:
                    restart_best_routes = copy.deepcopy(candidate_routes)
                    restart_best_unassigned = list(candidate_unassigned)
                    restart_best_cost = candidate_cost
                    elite_candidates.append(
                        (
                            candidate_cost,
                            copy.deepcopy(candidate_routes),
                            list(candidate_unassigned),
                        )
                    )
                if candidate_cost < best_cost:
                    best_routes = copy.deepcopy(candidate_routes)
                    best_unassigned = list(candidate_unassigned)
                    best_cost = candidate_cost
                continue

            neighborhood_index += 1
            if neighborhood_index < len(neighborhoods):
                continue

            neighborhood_index = 0
            relocated = self._best_relocation(
                restart_best_routes,
                restart_best_unassigned,
                restart_deadline,
            )
            if relocated is not None:
                current_cost, current_routes, current_unassigned = relocated
                restart_best_cost = current_cost
                restart_best_routes = copy.deepcopy(current_routes)
                restart_best_unassigned = list(current_unassigned)
                elite_candidates.append(
                    (
                        current_cost,
                        copy.deepcopy(current_routes),
                        list(current_unassigned),
                    )
                )
                if current_cost < best_cost:
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                shake_cycle = 0
                continue

            shake_cycle += 1
            shake_count = min(
                assigned_count,
                max(
                    2,
                    round(
                        assigned_count
                        * min(0.4, 0.15 + 0.05 * shake_cycle)
                    ),
                ),
            )
            shake_source_routes = (
                current_routes if restart_index > 0 else restart_best_routes
            )
            shake_source_unassigned = (
                current_unassigned if restart_index > 0 else restart_best_unassigned
            )
            shake_operator = "related" if shake_cycle % 2 else "random"
            shaken, removed = self.destroy_operators[shake_operator](
                copy.deepcopy(shake_source_routes), shake_count
            )
            current_routes, current_unassigned = self._repair(
                shaken,
                list(dict.fromkeys(shake_source_unassigned + removed)),
                "regret3",
                restart_deadline,
            )
            current_cost = self._plan_cost(current_routes, current_unassigned)
            if current_cost < restart_best_cost:
                restart_best_cost = current_cost
                restart_best_routes = copy.deepcopy(current_routes)
                restart_best_unassigned = list(current_unassigned)
                shake_cycle = 0
                elite_candidates.append(
                    (
                        current_cost,
                        copy.deepcopy(current_routes),
                        list(current_unassigned),
                    )
                )
            if current_cost < best_cost:
                best_cost = current_cost
                best_routes = copy.deepcopy(current_routes)
                best_unassigned = list(current_unassigned)

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            (
                f"Packing-aware VNS ({iteration} iterations, "
                f"{len(restart_seeds)} starts)"
            ),
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
        )


class PackingAwareTabuSolver(_AdvancedSearchBase):
    """Order-relocation Tabu Search with aspiration for global improvements."""

    def __init__(self, *args, tabu_tenure: int = 7, **kwargs):
        super().__init__(*args, **kwargs)
        if tabu_tenure <= 0:
            raise ValueError("tabu_tenure must be greater than zero")
        self.tabu_tenure = tabu_tenure

    @staticmethod
    def _source_vehicle(
        routes: List[List[ScheduledStop]], order_id: str
    ) -> Optional[int]:
        for vehicle_index, route in enumerate(routes):
            if any(
                stop.stop_type == "PICKUP" and stop.order_id == order_id
                for stop in route
            ):
                return vehicle_index
        return None

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        current_routes, current_unassigned = self._initial_state()
        current_cost = self._plan_cost(current_routes, current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        tabu_until: Dict[Tuple[str, int], int] = {}
        iteration = 0

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            iteration += 1
            assigned = list(dict.fromkeys(self._assigned_order_ids(current_routes)))
            self.rng.shuffle(assigned)
            sampled_orders = assigned[: min(8, len(assigned))]
            best_neighbor = None

            for order_id in sampled_orders:
                if time.perf_counter() >= deadline:
                    break
                source_vehicle = self._source_vehicle(current_routes, order_id)
                if source_vehicle is None:
                    continue
                reduced = self._remove_orders(current_routes, {order_id})
                options = self._insertions_for_order(
                    order_id, reduced, deadline, limit=5
                )
                for option in options:
                    candidate_routes = copy.deepcopy(reduced)
                    candidate_routes[option.vehicle_index] = option.stops
                    candidate_cost = self._plan_cost(
                        candidate_routes, current_unassigned
                    )
                    is_tabu = (
                        tabu_until.get((order_id, option.vehicle_index), 0)
                        > iteration
                    )
                    if is_tabu and candidate_cost >= best_cost:
                        continue
                    candidate = (
                        candidate_cost,
                        order_id,
                        source_vehicle,
                        option.vehicle_index,
                        candidate_routes,
                    )
                    if best_neighbor is None or candidate_cost < best_neighbor[0]:
                        best_neighbor = candidate

            if best_neighbor is None:
                break

            (
                current_cost,
                moved_order_id,
                source_vehicle,
                _destination_vehicle,
                current_routes,
            ) = best_neighbor
            tabu_until[(moved_order_id, source_vehicle)] = (
                iteration + self.tabu_tenure + self.rng.randint(0, 3)
            )
            if current_cost < best_cost:
                best_cost = current_cost
                best_routes = copy.deepcopy(current_routes)
                best_unassigned = list(current_unassigned)

        return self._finalize(
            best_routes,
            best_unassigned,
            started_at,
            f"Packing-aware Tabu Search ({iteration} iterations)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
        )


class PackingAwareILSSolver(_AdvancedSearchBase):
    """Iterated Local Search using best-improvement relocate and perturbation.

    The local phase only accepts a strict cost improvement. When it reaches a
    local optimum, a ruin/recreate perturbation deliberately moves away from
    the incumbent while the best plan remains protected.
    """

    def _best_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        current_cost = self._plan_cost(routes, unassigned)
        best_neighbor: Optional[Tuple[int, List[List[ScheduledStop]], List[str]]] = None
        assigned = list(dict.fromkeys(self._assigned_order_ids(routes)))
        self.rng.shuffle(assigned)

        for order_id in assigned[: min(12, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_orders(routes, {order_id})
            options = self._insertions_for_order(order_id, reduced, deadline, limit=6)
            for option in options:
                candidate_routes = copy.deepcopy(reduced)
                candidate_routes[option.vehicle_index] = option.stops
                candidate_cost = self._plan_cost(candidate_routes, unassigned)
                if candidate_cost >= current_cost:
                    continue
                if best_neighbor is None or candidate_cost < best_neighbor[0]:
                    best_neighbor = (
                        candidate_cost,
                        candidate_routes,
                        list(unassigned),
                    )
        return best_neighbor

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        current_routes, current_unassigned = self._initial_state()
        current_cost = self._plan_cost(current_routes, current_unassigned)
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
                deadline,
            )
            if neighbor is not None:
                current_cost, current_routes, current_unassigned = neighbor
                if current_cost < best_cost:
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                continue

            assigned_count = len(self._assigned_order_ids(best_routes))
            if assigned_count == 0 or time.perf_counter() >= deadline:
                break
            perturbation += 1
            remove_count = min(
                assigned_count,
                max(2, round(assigned_count * min(0.4, 0.15 + 0.05 * perturbation))),
            )
            destroy_name = "related" if perturbation % 2 else "random"
            destroyed, removed = self.destroy_operators[destroy_name](
                copy.deepcopy(best_routes), remove_count
            )
            current_routes, current_unassigned = self._repair(
                destroyed,
                list(dict.fromkeys(best_unassigned + removed)),
                "regret3",
                deadline,
            )
            current_cost = self._plan_cost(current_routes, current_unassigned)
            if current_cost < best_cost:
                best_cost = current_cost
                best_routes = copy.deepcopy(current_routes)
                best_unassigned = list(current_unassigned)
                perturbation = 0

        return self._finalize(
            best_routes,
            best_unassigned,
            started_at,
            f"Packing-aware ILS ({iteration} iterations)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
        )


class PackingAwareLateAcceptanceSolver(_AdvancedSearchBase):
    """Late Acceptance Hill Climbing over packing-aware ruin/recreate moves."""

    def __init__(self, *args, history_length: int = 25, **kwargs):
        super().__init__(*args, **kwargs)
        if history_length <= 0:
            raise ValueError("history_length must be greater than zero")
        self.history_length = history_length

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        current_routes, current_unassigned = self._initial_state()
        current_cost = self._plan_cost(current_routes, current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        history = [current_cost] * self.history_length
        destroy_names = tuple(self.destroy_operators)
        iteration = 0

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            history_index = iteration % self.history_length
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break
            remove_cap = max(1, min(6, assigned_count // 3 or 1))
            remove_count = self.rng.randint(1, remove_cap)
            destroy_name = destroy_names[iteration % len(destroy_names)]
            repair_name = self.repair_operators[iteration % len(self.repair_operators)]
            iteration += 1

            destroyed, removed = self.destroy_operators[destroy_name](
                copy.deepcopy(current_routes), remove_count
            )
            candidate_routes, candidate_unassigned = self._repair(
                destroyed,
                list(dict.fromkeys(current_unassigned + removed)),
                repair_name,
                deadline,
            )
            candidate_cost = self._plan_cost(candidate_routes, candidate_unassigned)
            if candidate_cost <= current_cost or candidate_cost <= history[history_index]:
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost
                if candidate_cost < best_cost:
                    best_cost = candidate_cost
                    best_routes = copy.deepcopy(candidate_routes)
                    best_unassigned = list(candidate_unassigned)

            history[history_index] = current_cost

        return self._finalize(
            best_routes,
            best_unassigned,
            started_at,
            f"Packing-aware Late Acceptance ({iteration} iterations)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
        )


class PackingAwareSimulatedAnnealingSolver(_AdvancedSearchBase):
    """Ruin/recreate simulated annealing with bounded reheating.

    This is deliberately separate from Hybrid ALNS: operator probabilities do
    not adapt. It tests whether a simple temperature schedule is more robust
    than adaptive operator scoring on the same feasible neighborhood.
    """

    def __init__(
        self,
        *args,
        cooling_rate: float = 0.995,
        reheat_after: int = 40,
        final_spatial_time_limit_sec: float = 3.0,
        final_repair_time_limit_sec: float = 5.0,
        max_elite_audit_candidates: int = 8,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if not 0.0 < cooling_rate < 1.0:
            raise ValueError("cooling_rate must be between zero and one")
        if reheat_after <= 0:
            raise ValueError("reheat_after must be greater than zero")
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if final_repair_time_limit_sec <= 0:
            raise ValueError("final_repair_time_limit_sec must be greater than zero")
        if max_elite_audit_candidates <= 0:
            raise ValueError("max_elite_audit_candidates must be greater than zero")
        self.cooling_rate = cooling_rate
        self.reheat_after = reheat_after
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.final_repair_time_limit_sec = final_repair_time_limit_sec
        self.max_elite_audit_candidates = max_elite_audit_candidates

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        routes, unassigned = self._initial_state()
        current_routes = copy.deepcopy(routes)
        current_unassigned = list(unassigned)
        current_cost = self._plan_cost(current_routes, current_unassigned)
        fallback: PlanCandidate = (
            current_cost,
            copy.deepcopy(current_routes),
            list(current_unassigned),
        )
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        elite_candidates: List[PlanCandidate] = [fallback]
        initial_temperature = max(1.0, current_cost * 0.03)
        temperature = initial_temperature
        stagnant = 0
        iteration = 0
        destroy_names = tuple(self.destroy_operators)

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break
            iteration += 1
            remove_count = self.rng.randint(
                1, max(1, min(6, assigned_count // 3 or 1))
            )
            destroy_name = self.rng.choice(destroy_names)
            repair_name = self.rng.choice(self.repair_operators)
            destroyed, removed = self.destroy_operators[destroy_name](
                copy.deepcopy(current_routes), remove_count
            )
            candidate_routes, candidate_unassigned = self._repair(
                destroyed,
                list(dict.fromkeys(current_unassigned + removed)),
                repair_name,
                deadline,
            )
            candidate_cost = self._plan_cost(
                candidate_routes, candidate_unassigned
            )
            delta = candidate_cost - current_cost
            if delta <= 0 or self.rng.random() < math.exp(
                -delta / max(1.0, temperature)
            ):
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost

            if candidate_cost < best_cost:
                best_cost = candidate_cost
                best_routes = copy.deepcopy(candidate_routes)
                best_unassigned = list(candidate_unassigned)
                elite_candidates.append(
                    (
                        best_cost,
                        copy.deepcopy(best_routes),
                        list(best_unassigned),
                    )
                )
                stagnant = 0
            else:
                stagnant += 1

            temperature *= self.cooling_rate
            if stagnant >= self.reheat_after:
                temperature = max(temperature, initial_temperature * 0.35)
                stagnant = 0

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            f"Packing-aware Simulated Annealing ({iteration} iterations)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
        )


class PackingAwareGRASPSolver(_AdvancedSearchBase):
    """Multi-start GRASP with randomized insertion and relocation descent."""

    def __init__(
        self,
        *args,
        final_spatial_time_limit_sec: float = 3.0,
        final_repair_time_limit_sec: float = 5.0,
        max_elite_audit_candidates: int = 8,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if final_repair_time_limit_sec <= 0:
            raise ValueError("final_repair_time_limit_sec must be greater than zero")
        if max_elite_audit_candidates <= 0:
            raise ValueError("max_elite_audit_candidates must be greater than zero")
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.final_repair_time_limit_sec = final_repair_time_limit_sec
        self.max_elite_audit_candidates = max_elite_audit_candidates

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        fallback_routes, fallback_unassigned = self._initial_state()
        fallback: PlanCandidate = (
            self._plan_cost(fallback_routes, fallback_unassigned),
            copy.deepcopy(fallback_routes),
            list(fallback_unassigned),
        )
        elite_candidates: List[PlanCandidate] = [fallback]
        iteration = 0

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            iteration += 1
            alpha = self.rng.uniform(0.10, 0.45)
            order_sequence = [order.id for order in self.orders]
            self.rng.shuffle(order_sequence)
            routes, unassigned = self._randomized_construction(
                deadline,
                alpha=alpha,
                order_sequence=order_sequence,
            )
            cost = self._plan_cost(routes, unassigned)

            while time.perf_counter() < deadline:
                improved = self._best_relocation_candidate(
                    routes,
                    unassigned,
                    deadline,
                    sample_limit=10,
                    option_limit=5,
                )
                if improved is None:
                    break
                cost, routes, unassigned = improved

            elite_candidates.append(
                (cost, copy.deepcopy(routes), list(unassigned))
            )

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            f"Packing-aware GRASP ({iteration} starts)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
        )


class PackingAwareMemeticSolver(_AdvancedSearchBase):
    """Permutation genetic search with packing-aware decode and local search."""

    def __init__(
        self,
        *args,
        population_size: int = 10,
        mutation_rate: float = 0.30,
        final_spatial_time_limit_sec: float = 3.0,
        final_repair_time_limit_sec: float = 5.0,
        max_elite_audit_candidates: int = 8,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        if population_size < 4:
            raise ValueError("population_size must be at least four")
        if not 0.0 <= mutation_rate <= 1.0:
            raise ValueError("mutation_rate must be between zero and one")
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if final_repair_time_limit_sec <= 0:
            raise ValueError("final_repair_time_limit_sec must be greater than zero")
        if max_elite_audit_candidates <= 0:
            raise ValueError("max_elite_audit_candidates must be greater than zero")
        self.population_size = population_size
        self.mutation_rate = mutation_rate
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.final_repair_time_limit_sec = final_repair_time_limit_sec
        self.max_elite_audit_candidates = max_elite_audit_candidates

    def _crossover(
        self, first: Sequence[str], second: Sequence[str]
    ) -> List[str]:
        if len(first) < 2:
            return list(first)
        left, right = sorted(self.rng.sample(range(len(first)), 2))
        child: List[Optional[str]] = [None] * len(first)
        child[left : right + 1] = first[left : right + 1]
        remaining = [order_id for order_id in second if order_id not in child]
        remaining_index = 0
        for index, order_id in enumerate(child):
            if order_id is None:
                child[index] = remaining[remaining_index]
                remaining_index += 1
        return [order_id for order_id in child if order_id is not None]

    def _mutate(self, chromosome: Sequence[str]) -> List[str]:
        mutated = list(chromosome)
        if len(mutated) < 2:
            return mutated
        first, second = sorted(self.rng.sample(range(len(mutated)), 2))
        if self.rng.random() < 0.5:
            mutated[first], mutated[second] = mutated[second], mutated[first]
        else:
            mutated[first : second + 1] = reversed(mutated[first : second + 1])
        return mutated

    def _evaluate_chromosome(
        self, chromosome: Sequence[str], deadline: float
    ) -> PlanCandidate:
        routes, unassigned = self._randomized_construction(
            deadline,
            alpha=0.0,
            order_sequence=chromosome,
        )
        improved = self._best_relocation_candidate(
            routes,
            unassigned,
            deadline,
            sample_limit=6,
            option_limit=4,
        )
        if improved is not None:
            return improved
        return self._plan_cost(routes, unassigned), routes, unassigned

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        fallback_routes, fallback_unassigned = self._initial_state()
        fallback: PlanCandidate = (
            self._plan_cost(fallback_routes, fallback_unassigned),
            copy.deepcopy(fallback_routes),
            list(fallback_unassigned),
        )
        order_ids = [order.id for order in self.orders]
        population: List[List[str]] = [list(order_ids)]
        by_deadline = sorted(
            order_ids,
            key=lambda order_id: self.order_by_id[order_id].delivery_window_end_sec,
        )
        population.append(by_deadline)
        while len(population) < self.population_size:
            chromosome = list(order_ids)
            self.rng.shuffle(chromosome)
            population.append(chromosome)

        elite_candidates: List[PlanCandidate] = [fallback]
        generation = 0
        while generation < self.max_iterations and time.perf_counter() < deadline:
            generation += 1
            scored = []
            for chromosome in population:
                if time.perf_counter() >= deadline:
                    break
                candidate = self._evaluate_chromosome(chromosome, deadline)
                scored.append((candidate[0], chromosome, candidate))
                elite_candidates.append(
                    (
                        candidate[0],
                        copy.deepcopy(candidate[1]),
                        list(candidate[2]),
                    )
                )
            if len(scored) < 2:
                break
            scored.sort(key=lambda row: row[0])
            next_population = [list(scored[0][1]), list(scored[1][1])]
            tournament_size = min(3, len(scored))
            while len(next_population) < self.population_size:
                first = min(
                    self.rng.sample(scored, tournament_size), key=lambda row: row[0]
                )[1]
                second = min(
                    self.rng.sample(scored, tournament_size), key=lambda row: row[0]
                )[1]
                child = self._crossover(first, second)
                if self.rng.random() < self.mutation_rate:
                    child = self._mutate(child)
                next_population.append(child)
            population = next_population

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            f"Packing-aware Memetic Search ({generation} generations)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
        )


def solve_vns(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 5.0,
    final_repair_time_limit_sec: float = 8.0,
    max_elite_audit_candidates: int = 16,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareVNSSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        max_elite_audit_candidates=max_elite_audit_candidates,
        initial_solution=initial_solution,
    ).solve()


def solve_tabu(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 1.5,
    final_repair_time_limit_sec: Optional[float] = None,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareTabuSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()


def solve_ils(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 1.5,
    final_repair_time_limit_sec: Optional[float] = None,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareILSSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()


def solve_late_acceptance(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 1.5,
    final_repair_time_limit_sec: Optional[float] = None,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareLateAcceptanceSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()


def solve_simulated_annealing(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 3.0,
    final_repair_time_limit_sec: float = 5.0,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareSimulatedAnnealingSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()


def solve_grasp(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 3.0,
    final_repair_time_limit_sec: float = 5.0,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareGRASPSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()


def solve_memetic(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 3.0,
    final_repair_time_limit_sec: float = 5.0,
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return PackingAwareMemeticSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()
