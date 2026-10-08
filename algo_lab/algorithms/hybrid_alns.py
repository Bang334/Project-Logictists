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
from algo_lab.common.solution_validator import repair_and_audit_solution
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
        max_iterations: int = 500,
        random_seed: int = 0,
        final_spatial_time_limit_sec: float = 2.0,
        final_repair_time_limit_sec: float = 3.0,
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
        self.final_repair_time_limit_sec = final_repair_time_limit_sec
        self.initial_solution = initial_solution
        self.rng = random.Random(random_seed)
        self._route_cache: Dict[Tuple[int, Tuple[Tuple[str, str], ...]], RouteEvaluation] = {}

        self.destroy_operators: Dict[
            str, Callable[[List[List[ScheduledStop]], int], Tuple[List[List[ScheduledStop]], List[str]]]
        ] = {
            "route": self._destroy_route,
            "small": self._destroy_small_routes,
            "cluster": self._destroy_cluster,
            "worst": self._destroy_worst,
            "related": self._destroy_related,
            "heavy": self._destroy_heavy,
            "string": self._destroy_string,
            "random": self._destroy_random,
        }
        self.repair_operators = ("regret2", "regret3", "greedy")
        self.destroy_weights = {
            "route": 2.0,
            "small": 2.0,
            "cluster": 1.8,
            "worst": 1.5,
            "related": 1.2,
            "heavy": 1.2,
            "string": 1.0,
            "random": 0.8,
        }
        self.repair_weights = {
            "regret2": 1.5,
            "regret3": 1.5,
            "greedy": 0.8,
        }

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
        if route_length <= 12:
            return [
                (pickup, delivery)
                for pickup in range(route_length + 1)
                for delivery in range(pickup + 1, route_length + 2)
            ]
        # Tuyến dài: luôn thử tất cả các cặp chèn liền kề (p, p+1)
        positions: Set[Tuple[int, int]] = set(
            (p, p + 1) for p in range(route_length + 1)
        )
        positions.add((0, route_length + 1))
        step = max(1, route_length // 5)
        anchors = sorted(set([0, route_length] + list(range(step, route_length, step))))
        for p in anchors:
            for d in anchors:
                if d > p:
                    positions.add((p, min(d, route_length + 1)))
        return sorted(positions)

    def _representative_empty_vehicle_indices(
        self, routes: Sequence[Sequence[ScheduledStop]]
    ) -> List[int]:
        """Keep one equivalent empty vehicle per physical depot and cost profile.

        Dataset vehicle IDs are resource IDs, not depot IDs.  Grouping on the
        depot ID therefore hid depots when an arbitrary two-type cap was used.
        """
        representatives: List[int] = []
        seen_profiles = set()
        empty_indices = sorted(
            (index for index, route in enumerate(routes) if not route),
            key=lambda index: self.vehicles[index].payload_limit_kg,
            reverse=True,
        )
        for index in empty_indices:
            vehicle = self.vehicles[index]
            driver = self.drivers[index]
            end_depot = vehicle.end_depot or vehicle.depot
            profile = (
                vehicle.payload_limit_kg,
                vehicle.length_cm,
                vehicle.width_cm,
                vehicle.height_cm,
                round(vehicle.depot.latitude, 6),
                round(vehicle.depot.longitude, 6),
                round(end_depot.latitude, 6),
                round(end_depot.longitude, 6),
                vehicle.fuel_consumption_liters_per_100_km,
                vehicle.load_fuel_surcharge_percent_at_full_payload,
                vehicle.fixed_operating_cost_vnd,
                driver.fixed_salary_monthly_vnd,
                driver.trip_base_pay_vnd,
                driver.per_km_pay_vnd,
            )
            if profile in seen_profiles:
                continue
            seen_profiles.add(profile)
            representatives.append(index)
        return representatives

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

        # Pha 1: Ưu tiên duyệt các xe đang hoạt động trước để dồn đơn
        active_indices = [idx for idx, r in enumerate(routes) if r]
        for vehicle_index in active_indices:
            if time.perf_counter() >= deadline:
                break
            current = routes[vehicle_index]
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

        # Pha 2: Nếu xe đang chạy chưa đủ options, thử đại diện ở mọi depot.
        if len(options) < limit:
            for vehicle_index in self._representative_empty_vehicle_indices(routes):
                if time.perf_counter() >= deadline:
                    break
                current = routes[vehicle_index]
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
                            delta_cost=evaluation.cost.total_cost_vnd,
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

    def _destroy_route(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        nonempty_indices = [idx for idx, r in enumerate(routes) if r]
        if not nonempty_indices:
            return routes, []
        counts = [
            (len({s.order_id for s in routes[idx] if s.order_id}), idx)
            for idx in nonempty_indices
        ]
        counts.sort(key=lambda x: x[0])
        top_k = min(3, len(counts))
        target_idx = counts[self.rng.randrange(top_k)][1]
        target_route = routes[target_idx]
        order_ids = list(dict.fromkeys(s.order_id for s in target_route if s.order_id))
        new_routes = [copy.deepcopy(r) for r in routes]
        new_routes[target_idx] = []
        return new_routes, order_ids

    def _destroy_small_routes(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        nonempty_indices = [idx for idx, r in enumerate(routes) if r]
        if not nonempty_indices:
            return routes, []
        small_vehicles = [
            idx for idx in nonempty_indices
            if len({s.order_id for s in routes[idx] if s.order_id}) <= 2
        ]
        if not small_vehicles:
            return self._destroy_route(routes, remove_count)
        new_routes = [copy.deepcopy(r) for r in routes]
        removed_orders: List[str] = []
        for idx in small_vehicles[:2]:
            for s in new_routes[idx]:
                if s.order_id and s.order_id not in removed_orders:
                    removed_orders.append(s.order_id)
            new_routes[idx] = []
        return new_routes, removed_orders

    def _destroy_cluster(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        if not assigned:
            return routes, []
        seed = self.rng.choice(assigned)
        seed_loc = self.node_id_to_index[self.order_by_id[seed].pickup_location.id]
        cluster_sorted = sorted(
            assigned,
            key=lambda oid: self.distance_matrix[seed_loc][
                self.node_id_to_index[self.order_by_id[oid].pickup_location.id]
            ],
        )
        removed = cluster_sorted[:min(remove_count, len(cluster_sorted))]
        return self._remove_orders(routes, set(removed)), removed

    def _destroy_heavy(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        if not assigned:
            return routes, []
        heavy_sorted = sorted(
            assigned,
            key=lambda oid: (
                getattr(self.order_by_id[oid], "total_weight_kg", 0.0),
                getattr(self.order_by_id[oid], "total_volume_m3", 0.0),
            ),
            reverse=True,
        )
        removed = heavy_sorted[:min(remove_count, len(heavy_sorted))]
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

    def _economic_plan_cost(
        self, routes: List[List[ScheduledStop]], unassigned: List[str]
    ) -> int:
        routing_cost = sum(
            self._route_cost(index, route)
            for index, route in enumerate(routes)
            if route
        )
        unassigned_penalty = len(unassigned) * self.policy.unassigned_order_penalty_vnd
        return routing_cost + unassigned_penalty

    def _plan_cost(
        self, routes: List[List[ScheduledStop]], unassigned: List[str]
    ) -> int:
        """Search surrogate; final candidates are ranked by economic cost."""
        active_vehicles = sum(bool(route) for route in routes)
        consolidation_guidance = active_vehicles * 1_000_000
        feasibility_guidance = (
            len(unassigned) * self.policy.unassigned_order_penalty_vnd * 2
        )
        return (
            self._economic_plan_cost(routes, unassigned)
            + consolidation_guidance
            + feasibility_guidance
        )

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

    def _sequential_construction(
        self,
        order_sequence: Sequence[str],
        deadline: float,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        unassigned: List[str] = []
        for order_id in order_sequence:
            if time.perf_counter() >= deadline:
                unassigned.append(order_id)
                continue
            options = self._insertions_for_order(
                order_id,
                routes,
                deadline,
                limit=1,
            )
            if not options:
                unassigned.append(order_id)
                continue
            chosen = options[0]
            routes[chosen.vehicle_index] = chosen.stops
        return routes, unassigned

    def _construct_structured_solutions(
        self, deadline: float
    ) -> List[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []
        # 1. seq_tw: Earliest time-window
        seq_tw = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda o: (o.pickup_window_start_sec, o.delivery_window_end_sec),
            )
        ]
        # 2. seq_area: Best-fit decreasing area
        seq_area = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda o: sum(it.length_cm * it.width_cm for it in o.items),
                reverse=True,
            )
        ]
        sequences = [("seq_tw", seq_tw), ("seq_area", seq_area)]
        for _, seq in sequences:
            if time.perf_counter() >= deadline:
                break
            routes, unassigned = self._sequential_construction(seq, deadline)
            if not unassigned:
                cost = self._plan_cost(routes, unassigned)
                candidates.append((cost, routes, unassigned))

        candidates.sort(key=lambda x: x[0])
        return candidates

    def _eliminate_routes(
        self,
        routes: List[List[ScheduledStop]],
        deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Tích cực triệt tiêu các xe ít đơn nhất bằng cách nhồi đơn sang các xe đang hoạt động khác."""
        improved = True
        current_routes = [copy.deepcopy(r) for r in routes]
        while improved and time.perf_counter() < deadline:
            improved = False
            active_vehicles = [
                (idx, len({s.order_id for s in current_routes[idx] if s.order_id}))
                for idx, r in enumerate(current_routes)
                if r
            ]
            active_vehicles.sort(key=lambda x: x[1])
            for victim_idx, count in active_vehicles:
                if count > 4 or time.perf_counter() >= deadline:
                    continue
                victim_orders = list(dict.fromkeys(
                    s.order_id for s in current_routes[victim_idx] if s.order_id
                ))
                temp_routes = [copy.deepcopy(r) for r in current_routes]
                temp_routes[victim_idx] = []
                all_inserted = True
                for oid in victim_orders:
                    active_other = [i for i, r in enumerate(temp_routes) if r and i != victim_idx]
                    best_opt = None
                    order = self.order_by_id[oid]
                    pickup, delivery = self._make_stops(order)
                    for v_idx in active_other:
                        cur = temp_routes[v_idx]
                        cur_cost = self._route_cost(v_idx, cur)
                        for p_pos, d_pos in self._candidate_positions(len(cur)):
                            cand = (
                                cur[:p_pos] + [copy.deepcopy(pickup)]
                                + cur[p_pos:d_pos - 1] + [copy.deepcopy(delivery)]
                                + cur[d_pos - 1:]
                            )
                            eval_res = self._evaluate_route(v_idx, cand)
                            if eval_res.feasible and eval_res.cost is not None:
                                delta = eval_res.cost.total_cost_vnd - cur_cost
                                if best_opt is None or delta < best_opt[0]:
                                    best_opt = (delta, v_idx, eval_res.stops)
                    if best_opt is not None:
                        temp_routes[best_opt[1]] = best_opt[2]
                    else:
                        all_inserted = False
                        break
                if all_inserted:
                    current_routes = temp_routes
                    improved = True
                    break
        return current_routes

    def _best_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
        *,
        sample_limit: int = 8,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Thử di dời 1 đơn hàng sang vị trí tốt hơn để giảm chi phí."""
        incumbent_cost = self._plan_cost(routes, unassigned)
        best_neighbor = None
        assigned = list(dict.fromkeys(self._assigned_order_ids(routes)))
        self.rng.shuffle(assigned)
        for order_id in assigned[:min(sample_limit, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_orders(routes, {order_id})
            options = self._insertions_for_order(order_id, reduced, deadline, limit=4)
            for option in options:
                candidate_routes = copy.deepcopy(reduced)
                candidate_routes[option.vehicle_index] = option.stops
                candidate_cost = self._plan_cost(candidate_routes, unassigned)
                if candidate_cost < incumbent_cost:
                    if best_neighbor is None or candidate_cost < best_neighbor[0]:
                        best_neighbor = (candidate_cost, candidate_routes, list(unassigned))
        return best_neighbor

    def _build_solution(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        solver_name: str,
    ) -> OptimizationSolution:
        optimized_routes: List[OptimizedRoute] = []
        total_cost = 0
        total_distance = 0.0
        reported_unassigned = list(unassigned)
        for vehicle_index, stops in enumerate(routes):
            if not stops:
                continue
            evaluation = self._evaluate_route(vehicle_index, stops)
            if not evaluation.feasible or evaluation.cost is None:
                reported_unassigned.extend(
                    stop.order_id for stop in stops if stop.stop_type == "PICKUP" and stop.order_id
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

        reported_unassigned = list(dict.fromkeys(reported_unassigned))
        unassigned_numbers = [self.order_by_id[oid].order_number for oid in reported_unassigned]
        return OptimizationSolution(
            solver_name=solver_name,
            execution_time_sec=0.0,
            routes=optimized_routes,
            unassigned_orders=unassigned_numbers,
            real_economic_cost_vnd=total_cost,
            penalized_objective_vnd=(
                total_cost + len(reported_unassigned) * self.policy.unassigned_order_penalty_vnd
            ),
            total_distance_km=round(total_distance, 2),
            fulfillment_rate=round(
                (len(self.orders) - len(reported_unassigned)) / max(1, len(self.orders)) * 100.0,
                1,
            ),
            is_spatial_valid=False,
            spatial_notes="Chưa chạy validator độc lập",
            random_seed=self.random_seed,
        )

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

        elite_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []
        elite_candidates.append((current_cost, copy.deepcopy(current_routes), list(current_unassigned)))

        # Chỉ dùng các bước dựng/gom tuyến đắt tiền khi nghiệm đầu chưa giao đủ.
        # Với nghiệm Greedy đầy đủ, dành toàn bộ budget cho vòng ALNS chính; trước
        # đây preprocessing có thể ăn hết budget và trả về với 0 iterations.
        if current_unassigned:
            struct_deadline = min(
                deadline,
                started_at + min(0.6, self.time_limit_sec * 0.15),
            )
            struct_candidates = self._construct_structured_solutions(struct_deadline)
            if struct_candidates:
                best_struct_cost, best_struct_routes, best_struct_unassigned = struct_candidates[0]
                if best_struct_cost < current_cost:
                    current_routes = copy.deepcopy(best_struct_routes)
                    current_unassigned = list(best_struct_unassigned)
                    current_cost = best_struct_cost
                    elite_candidates.append(
                        (current_cost, copy.deepcopy(current_routes), list(current_unassigned))
                    )

            elim_deadline = min(
                deadline,
                started_at + min(1.2, self.time_limit_sec * 0.30),
            )
            elim_routes = self._eliminate_routes(current_routes, elim_deadline)
            elim_cost = self._plan_cost(elim_routes, current_unassigned)
            if elim_cost < current_cost:
                current_routes = copy.deepcopy(elim_routes)
                current_cost = elim_cost
                elite_candidates.append(
                    (current_cost, copy.deepcopy(current_routes), list(current_unassigned))
                )

        # Intensification sớm: relocation có chi phí thấp hơn ruin/recreate đầy đủ
        # và đặc biệt hiệu quả với các case nhỏ hoặc đang dùng thừa xe. Giới hạn
        # phần ngân sách này để vòng ALNS chính vẫn luôn có thời gian chạy.
        intensify_fraction = 0.60 if len(self.orders) <= 8 else 0.0
        intensify_deadline = min(
            deadline,
            started_at + min(4.0, self.time_limit_sec * intensify_fraction),
        )
        while (
            not current_unassigned
            and time.perf_counter() < intensify_deadline
        ):
            relocated = self._best_relocation(
                current_routes,
                current_unassigned,
                intensify_deadline,
                sample_limit=min(8, len(self.orders)),
            )
            if relocated is None:
                break
            current_cost, current_routes, current_unassigned = relocated
            elite_candidates.append(
                (current_cost, copy.deepcopy(current_routes), list(current_unassigned))
            )

        fallback_compact_routes = copy.deepcopy(current_routes)
        fallback_compact_unassigned = list(current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        best_nonempty = sum(1 for r in best_routes if r)
        temperature = max(1.0, current_cost * 0.02)
        iteration = 0
        last_improved_iteration = 0

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            iteration += 1
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break

            # Cơ chế Local Search Relocation / Elimination khi bế tắc 6 vòng
            if iteration - last_improved_iteration >= 6:
                relocated = self._best_relocation(best_routes, best_unassigned, deadline, sample_limit=6)
                if relocated is not None and relocated[0] < best_cost:
                    best_cost, best_routes, best_unassigned = relocated
                    current_cost, current_routes, current_unassigned = relocated
                    best_nonempty = sum(1 for r in best_routes if r)
                    if len(best_unassigned) == 0:
                        elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                    last_improved_iteration = iteration
                    continue

                elim_routes = self._eliminate_routes(best_routes, deadline)
                cand_cost = self._plan_cost(elim_routes, best_unassigned)
                if cand_cost < best_cost:
                    best_routes = elim_routes
                    best_cost = cand_cost
                    current_routes = copy.deepcopy(elim_routes)
                    current_cost = cand_cost
                    best_nonempty = sum(1 for r in best_routes if r)
                    if len(best_unassigned) == 0:
                        elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                    last_improved_iteration = iteration
                    continue

                temperature = max(temperature * 1.5, best_cost * 0.02)
                destroy_name = self.rng.choice(["route", "small", "cluster"])
                last_improved_iteration = iteration
            else:
                destroy_name = self._weighted_choice(self.destroy_weights)

            max_rem = min(4, max(1, int(assigned_count * 0.25)))
            remove_count = self.rng.randint(1, max_rem)
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
            cand_nonempty = sum(1 for r in candidate_routes if r)
            delta = candidate_cost - current_cost
            accepted = delta <= 0 or self.rng.random() < math.exp(
                -delta / max(1.0, temperature)
            )
            score = 0.2
            if accepted:
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost
                score = 1.0
                if delta < 0:
                    score = 3.0
                if cand_nonempty < best_nonempty and len(candidate_unassigned) == 0:
                    score = 10.0

                if candidate_cost < best_cost and len(candidate_unassigned) <= len(best_unassigned):
                    best_routes = copy.deepcopy(candidate_routes)
                    best_unassigned = list(candidate_unassigned)
                    best_cost = candidate_cost
                    best_nonempty = cand_nonempty
                    score = max(score, 6.0)
                    last_improved_iteration = iteration
                    if len(best_unassigned) == 0:
                        elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))

            self._update_weight(self.destroy_weights, destroy_name, score)
            self._update_weight(self.repair_weights, repair_name, score)
            temperature *= 0.993

        # Lọc các ứng viên duy nhất trong elite candidates đã giao đủ 100% đơn
        unique_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []
        seen_signatures = set()
        for cand in sorted(
            elite_candidates,
            key=lambda candidate: (
                len(candidate[2]),
                self._economic_plan_cost(candidate[1], candidate[2]),
                candidate[0],
            ),
        ):
            if len(cand[2]) > 0:
                continue
            sig = tuple(self._route_key(r) for r in cand[1])
            if sig in seen_signatures:
                continue
            seen_signatures.add(sig)
            unique_candidates.append(cand)

        # Kiểm chứng đa ứng viên elite: chọn ứng viên tốt nhất vượt qua SpatialValidator
        for rank, (_, cand_routes, cand_unassigned) in enumerate(unique_candidates[:3], start=1):
            solution = self._build_solution(
                cand_routes,
                cand_unassigned,
                f"Hybrid ALNS (adaptive, {iteration} iters, elite #{rank})",
            )
            repair_and_audit_solution(
                solution,
                self.vehicles,
                self.drivers,
                self.orders,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
                spatial_time_limit_sec=self.final_spatial_time_limit_sec,
                repair_time_limit_sec=self.final_repair_time_limit_sec,
            )
            is_valid = bool(
                solution.solution_audited
                and solution.is_contract_valid
                and solution.is_temporally_valid
                and solution.is_spatial_valid
                and solution.fulfillment_rate >= 99.9
            )
            if is_valid:
                solution.execution_time_sec = round(time.perf_counter() - started_at, 3)
                return solution

        # Bảo vệ toàn vẹn: nếu tất cả elite không đạt, thử audit fallback_compact trước khi về sol_gr
        fallback_sol = self._build_solution(
            fallback_compact_routes,
            fallback_compact_unassigned,
            f"Hybrid ALNS (compact fallback, {iteration} iters)",
        )
        repair_and_audit_solution(
            fallback_sol,
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
        )
        if (
            fallback_sol.solution_audited
            and fallback_sol.is_contract_valid
            and fallback_sol.is_temporally_valid
            and fallback_sol.is_spatial_valid
            and fallback_sol.fulfillment_rate >= 99.9
        ):
            fallback_sol.execution_time_sec = round(time.perf_counter() - started_at, 3)
            return fallback_sol

        # Fallback an toàn cuối cùng về nghiệm Greedy
        if sol_gr is not None:
            sol_gr_valid = bool(
                sol_gr.is_contract_valid
                and sol_gr.is_temporally_valid
                and sol_gr.is_spatial_valid
                and sol_gr.fulfillment_rate >= 99.9
            )
            if sol_gr_valid:
                fallback = copy.deepcopy(sol_gr)
                fallback.solver_name = f"Hybrid ALNS (safe fallback, {iteration} iters)"
                fallback.execution_time_sec = round(time.perf_counter() - started_at, 3)
                return fallback

        # Nghiệm mặc định
        default_sol = self._build_solution(
            best_routes,
            best_unassigned,
            f"Hybrid ALNS (adaptive, {iteration} iters)",
        )
        repair_and_audit_solution(
            default_sol,
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
        )
        default_sol.execution_time_sec = round(time.perf_counter() - started_at, 3)
        return default_sol


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
    final_spatial_time_limit_sec: float = 2.0,
    final_repair_time_limit_sec: float = 3.0,
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
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=initial_solution,
    ).solve()
