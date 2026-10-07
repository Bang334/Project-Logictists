"""Packing-aware adaptive large-neighborhood search for the lab benchmark.

The solver combines four destroy operators (random, worst-cost, related and
string removal) with greedy/regret-2/regret-3 repair. Operator weights adapt to
accepted improvements. Cheap packing checks prune the search; the returned
solution is independently audited by the production spatial validator.
"""

import copy
import math
import os
import random
import sys
import time
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Set, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.common.models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from algo_lab.common.route_evaluator import RouteEvaluation, schedule_and_evaluate_route
from algo_lab.common.solution_validator import audit_solution
from algo_lab.algorithms.greedy_insertion import solve_greedy


@dataclass
class _Insertion:
    order_id: str
    vehicle_index: int
    stops: List[ScheduledStop]
    evaluation: RouteEvaluation
    delta_cost: int


class HybridALNSSolver:
    def __init__(
        self,
        vehicles: List[FleetVehicle],
        drivers: List[DriverOption],
        orders: List[OrderPair],
        policy: CostPolicy,
        distance_matrix: List[List[float]],
        duration_matrix: List[List[float]],
        node_id_to_index: Dict[str, int],
        *,
        time_limit_sec: float = 3.0,
        max_iterations: int = 300,
        random_seed: int = 0,
        final_spatial_time_limit_sec: float = 1.5,
        initial_solution: Optional[OptimizationSolution] = None,
    ):
        if time_limit_sec <= 0:
            raise ValueError("time_limit_sec must be greater than zero")
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if len(drivers) < len(vehicles):
            raise ValueError("Mỗi xe ứng viên phải có một tài xế trong benchmark")
        self.vehicles = vehicles
        self.drivers = drivers
        self.orders = orders
        self.order_by_id = {order.id: order for order in orders}
        self.cargo_by_id = {item.id: item for order in orders for item in order.items}
        self.policy = policy
        self.distance_matrix = distance_matrix
        self.duration_matrix = duration_matrix
        self.node_id_to_index = node_id_to_index
        self.time_limit_sec = time_limit_sec
        self.max_iterations = max_iterations
        self.random_seed = random_seed
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.initial_solution = initial_solution
        self.rng = random.Random(random_seed)
        self._route_cache: Dict[Tuple[int, Tuple[Tuple[str, str], ...]], RouteEvaluation] = {}

        self.destroy_operators: Dict[
            str, Callable[[List[List[ScheduledStop]], int], Tuple[List[List[ScheduledStop]], List[str]]]
        ] = {
            "random": self._destroy_random,
            "worst": self._destroy_worst,
            "related": self._destroy_related,
            "string": self._destroy_string,
        }
        self.repair_operators = ("greedy", "regret2", "regret3")
        self.destroy_weights = {name: 1.0 for name in self.destroy_operators}
        self.repair_weights = {name: 1.0 for name in self.repair_operators}

    @staticmethod
    def _route_key(stops: Sequence[ScheduledStop]) -> Tuple[Tuple[str, str], ...]:
        return tuple((stop.stop_type, stop.order_id or "") for stop in stops)

    def _evaluate_route(
        self, vehicle_index: int, stops: List[ScheduledStop]
    ) -> RouteEvaluation:
        key = (vehicle_index, self._route_key(stops))
        cached = self._route_cache.get(key)
        if cached is not None:
            return copy.deepcopy(cached)
        evaluation = schedule_and_evaluate_route(
            self.vehicles[vehicle_index],
            self.drivers[vehicle_index],
            stops,
            self.order_by_id,
            self.cargo_by_id,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
        )
        self._route_cache[key] = copy.deepcopy(evaluation)
        return evaluation

    def _route_cost(self, vehicle_index: int, stops: List[ScheduledStop]) -> int:
        if not stops:
            return 0
        evaluation = self._evaluate_route(vehicle_index, stops)
        if not evaluation.feasible or evaluation.cost is None:
            return self.policy.unassigned_order_penalty_vnd * len(self.orders)
        return evaluation.cost.total_cost_vnd

    def _make_stops(self, order: OrderPair) -> Tuple[ScheduledStop, ScheduledStop]:
        item_ids = [item.id for item in order.items]
        pickup = ScheduledStop(
            sequence=0,
            stop_type="PICKUP",
            location_id=order.pickup_location.id,
            location_name=order.pickup_location.name,
            order_id=order.id,
            order_number=order.order_number,
            items_loaded=item_ids,
        )
        delivery = ScheduledStop(
            sequence=0,
            stop_type="DELIVERY",
            location_id=order.delivery_location.id,
            location_name=order.delivery_location.name,
            order_id=order.id,
            order_number=order.order_number,
            items_unloaded=item_ids,
        )
        return pickup, delivery

    def _candidate_positions(self, route_length: int) -> List[Tuple[int, int]]:
        if route_length <= 10:
            return [
                (pickup, delivery)
                for pickup in range(route_length + 1)
                for delivery in range(pickup + 1, route_length + 2)
            ]
        anchors = sorted(
            {
                0,
                route_length,
                route_length // 4,
                route_length // 2,
                (3 * route_length) // 4,
            }
        )
        positions: Set[Tuple[int, int]] = set()
        for pickup in anchors:
            for delivery in anchors + [route_length + 1]:
                if delivery > pickup:
                    positions.add((pickup, min(delivery, route_length + 1)))
            positions.add((pickup, min(route_length + 1, pickup + 1)))
        return sorted(positions)

    def _insertions_for_order(
        self,
        order_id: str,
        routes: List[List[ScheduledStop]],
        deadline: float,
        limit: int = 3,
    ) -> List[_Insertion]:
        order = self.order_by_id[order_id]
        pickup, delivery = self._make_stops(order)
        options: List[_Insertion] = []
        checked_empty_types = set()

        for vehicle_index, current in enumerate(routes):
            if time.perf_counter() >= deadline:
                break
            vehicle = self.vehicles[vehicle_index]
            if not current:
                vehicle_type = (
                    vehicle.payload_limit_kg,
                    vehicle.length_cm,
                    vehicle.width_cm,
                    vehicle.height_cm,
                    vehicle.depot.id,
                )
                if vehicle_type in checked_empty_types:
                    continue
                checked_empty_types.add(vehicle_type)

            current_cost = self._route_cost(vehicle_index, current)
            for pickup_pos, delivery_pos in self._candidate_positions(len(current)):
                if time.perf_counter() >= deadline:
                    break
                candidate = (
                    current[:pickup_pos]
                    + [copy.deepcopy(pickup)]
                    + current[pickup_pos : delivery_pos - 1]
                    + [copy.deepcopy(delivery)]
                    + current[delivery_pos - 1 :]
                )
                evaluation = self._evaluate_route(vehicle_index, candidate)
                if not evaluation.feasible or evaluation.cost is None:
                    continue
                options.append(
                    _Insertion(
                        order_id=order_id,
                        vehicle_index=vehicle_index,
                        stops=evaluation.stops,
                        evaluation=evaluation,
                        delta_cost=evaluation.cost.total_cost_vnd - current_cost,
                    )
                )
        options.sort(key=lambda option: (option.delta_cost, option.evaluation.distance_km))
        return options[:limit]

    def _repair(
        self,
        routes: List[List[ScheduledStop]],
        pool: List[str],
        operator: str,
        deadline: float,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        pending = list(dict.fromkeys(pool))
        unassigned: List[str] = []
        regret_k = 1 if operator == "greedy" else (2 if operator == "regret2" else 3)

        while pending and time.perf_counter() < deadline:
            choices = []
            impossible = []
            for order_id in pending:
                options = self._insertions_for_order(order_id, routes, deadline, regret_k)
                if not options:
                    impossible.append(order_id)
                    continue
                best = options[0]
                kth_cost = (
                    options[min(regret_k - 1, len(options) - 1)].delta_cost
                    if len(options) > 1
                    else best.delta_cost + self.policy.unassigned_order_penalty_vnd
                )
                regret = kth_cost - best.delta_cost
                choices.append((regret, -best.delta_cost, order_id, best))

            for order_id in impossible:
                if order_id in pending:
                    pending.remove(order_id)
                    unassigned.append(order_id)
            if not choices:
                break
            if operator == "greedy":
                _, _, chosen_id, chosen = max(choices, key=lambda row: row[1])
            else:
                _, _, chosen_id, chosen = max(choices, key=lambda row: (row[0], row[1]))
            routes[chosen.vehicle_index] = chosen.stops
            pending.remove(chosen_id)

        unassigned.extend(pending)
        return routes, unassigned

    @staticmethod
    def _assigned_order_ids(routes: List[List[ScheduledStop]]) -> List[str]:
        return [
            stop.order_id
            for route in routes
            for stop in route
            if stop.stop_type == "PICKUP" and stop.order_id
        ]

    @staticmethod
    def _remove_orders(
        routes: List[List[ScheduledStop]], order_ids: Set[str]
    ) -> List[List[ScheduledStop]]:
        return [
            [stop for stop in route if stop.order_id not in order_ids]
            for route in routes
        ]

    def _destroy_random(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        removed = self.rng.sample(assigned, min(remove_count, len(assigned))) if assigned else []
        return self._remove_orders(routes, set(removed)), removed

    def _destroy_worst(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        savings = []
        for vehicle_index, route in enumerate(routes):
            current_cost = self._route_cost(vehicle_index, route)
            order_ids = {
                stop.order_id for stop in route if stop.stop_type == "PICKUP" and stop.order_id
            }
            for order_id in order_ids:
                reduced = [stop for stop in route if stop.order_id != order_id]
                savings.append((current_cost - self._route_cost(vehicle_index, reduced), order_id))
        savings.sort(reverse=True)
        removed = [order_id for _, order_id in savings[:remove_count]]
        return self._remove_orders(routes, set(removed)), removed

    def _relatedness(self, first_id: str, second_id: str) -> float:
        first = self.order_by_id[first_id]
        second = self.order_by_id[second_id]
        fp = self.node_id_to_index[first.pickup_location.id]
        sp = self.node_id_to_index[second.pickup_location.id]
        fd = self.node_id_to_index[first.delivery_location.id]
        sd = self.node_id_to_index[second.delivery_location.id]
        spatial = self.distance_matrix[fp][sp] + self.distance_matrix[fd][sd]
        temporal = abs(first.pickup_window_start_sec - second.pickup_window_start_sec)
        weight = abs(first.total_weight_kg - second.total_weight_kg) * 100.0
        return float(spatial) + temporal * 5.0 + weight

    def _destroy_related(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        if not assigned:
            return routes, []
        seed = self.rng.choice(assigned)
        related = sorted(assigned, key=lambda order_id: self._relatedness(seed, order_id))
        removed = related[:remove_count]
        return self._remove_orders(routes, set(removed)), removed

    def _destroy_string(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        nonempty = [index for index, route in enumerate(routes) if route]
        if not nonempty:
            return routes, []
        route = routes[self.rng.choice(nonempty)]
        pickup_ids = [
            stop.order_id
            for stop in route
            if stop.stop_type == "PICKUP" and stop.order_id
        ]
        if not pickup_ids:
            return routes, []
        start = self.rng.randrange(len(pickup_ids))
        removed = pickup_ids[start : start + remove_count]
        if len(removed) < remove_count:
            removed += pickup_ids[: remove_count - len(removed)]
        return self._remove_orders(routes, set(removed)), removed

    def _plan_cost(
        self, routes: List[List[ScheduledStop]], unassigned: List[str]
    ) -> int:
        return sum(
            self._route_cost(index, route)
            for index, route in enumerate(routes)
            if route
        ) + len(unassigned) * self.policy.unassigned_order_penalty_vnd

    def _weighted_choice(self, weights: Dict[str, float]) -> str:
        names = list(weights)
        total = sum(max(0.01, weights[name]) for name in names)
        point = self.rng.random() * total
        for name in names:
            point -= max(0.01, weights[name])
            if point <= 0:
                return name
        return names[-1]

    @staticmethod
    def _update_weight(weights: Dict[str, float], name: str, score: float) -> None:
        weights[name] = 0.8 * weights[name] + 0.2 * score

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        # Khởi tạo nghiệm xuất phát bằng Greedy Insertion nhanh (đảm bảo 100% khả thi ban đầu)
        sol_gr = self.initial_solution or solve_greedy(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
        )
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        veh_id_to_idx = {v.id: idx for idx, v in enumerate(self.vehicles)}
        for r in sol_gr.routes:
            v_idx = veh_id_to_idx.get(r.vehicle.id, 0)
            routes[v_idx] = copy.deepcopy(r.stops)

        assigned = set(self._assigned_order_ids(routes))
        unassigned = [order.id for order in self.orders if order.id not in assigned]
        current_routes = copy.deepcopy(routes)
        current_unassigned = list(unassigned)
        current_cost = self._plan_cost(current_routes, current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        temperature = max(1.0, current_cost * 0.02)
        iteration = 0

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            iteration += 1
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break
            remove_count = self.rng.randint(1, max(1, min(5, assigned_count // 3 or 1)))
            destroy_name = self._weighted_choice(self.destroy_weights)
            repair_name = self._weighted_choice(self.repair_weights)
            destroyed, removed = self.destroy_operators[destroy_name](
                copy.deepcopy(current_routes), remove_count
            )
            pool = list(dict.fromkeys(current_unassigned + removed))
            candidate_routes, candidate_unassigned = self._repair(
                destroyed,
                pool,
                repair_name,
                deadline,
            )
            candidate_cost = self._plan_cost(candidate_routes, candidate_unassigned)
            delta = candidate_cost - current_cost
            accepted = delta <= 0 or self.rng.random() < math.exp(
                -delta / max(1.0, temperature)
            )
            score = 0.5
            if accepted:
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost
                score = 2.0 if delta < 0 else 1.0
                if candidate_cost < best_cost:
                    best_routes = copy.deepcopy(candidate_routes)
                    best_unassigned = list(candidate_unassigned)
                    best_cost = candidate_cost
                    score = 5.0
            self._update_weight(self.destroy_weights, destroy_name, score)
            self._update_weight(self.repair_weights, repair_name, score)
            temperature *= 0.995

        optimized_routes: List[OptimizedRoute] = []
        total_cost = 0
        total_distance = 0.0
        for vehicle_index, stops in enumerate(best_routes):
            if not stops:
                continue
            evaluation = self._evaluate_route(vehicle_index, stops)
            if not evaluation.feasible or evaluation.cost is None:
                best_unassigned.extend(
                    stop.order_id
                    for stop in stops
                    if stop.stop_type == "PICKUP" and stop.order_id
                )
                continue
            route = OptimizedRoute(
                vehicle=self.vehicles[vehicle_index],
                driver=self.drivers[vehicle_index],
                stops=evaluation.stops,
                total_distance_km=evaluation.distance_km,
                total_duration_minutes=evaluation.duration_minutes,
                cost_breakdown=evaluation.cost,
            )
            optimized_routes.append(route)
            total_cost += evaluation.cost.total_cost_vnd
            total_distance += evaluation.distance_km

        best_unassigned = list(dict.fromkeys(best_unassigned))
        unassigned_numbers = [self.order_by_id[oid].order_number for oid in best_unassigned]
        solution = OptimizationSolution(
            solver_name=f"Hybrid ALNS (adaptive, {iteration} iterations)",
            execution_time_sec=0.0,
            routes=optimized_routes,
            unassigned_orders=unassigned_numbers,
            real_economic_cost_vnd=total_cost,
            penalized_objective_vnd=(
                total_cost
                + len(best_unassigned) * self.policy.unassigned_order_penalty_vnd
            ),
            total_distance_km=round(total_distance, 2),
            fulfillment_rate=round(
                (len(self.orders) - len(best_unassigned))
                / max(1, len(self.orders))
                * 100.0,
                1,
            ),
            is_spatial_valid=False,
            spatial_notes="Chưa chạy validator độc lập",
            random_seed=self.random_seed,
        )
        audit_solution(
            solution,
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
        )
        solution.execution_time_sec = round(time.perf_counter() - started_at, 3)
        return solution


def solve_hybrid_alns(
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
    initial_solution: Optional[OptimizationSolution] = None,
) -> OptimizationSolution:
    return HybridALNSSolver(
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
        initial_solution=initial_solution,
    ).solve()
