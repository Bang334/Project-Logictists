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

from .models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from .route_evaluator import RouteEvaluation, schedule_and_evaluate_route
from .solution_validator import repair_and_audit_solution
from .greedy_insertion import solve_greedy
from .objective import solution_key
from .legacy_solver import LegacyHybridALNSSolver
from .stop_moves import ranked_stop_moves


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
        post_audit_reserve_sec: float = 0.0,
    ):
        if time_limit_sec <= 0:
            raise ValueError("time_limit_sec must be greater than zero")
        if post_audit_reserve_sec < 0 or post_audit_reserve_sec >= time_limit_sec:
            raise ValueError("post_audit_reserve_sec must be nonnegative and smaller than time_limit_sec")
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
        self.post_audit_reserve_sec = post_audit_reserve_sec
        self.max_iterations = max_iterations
        self.random_seed = random_seed
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.final_repair_time_limit_sec = final_repair_time_limit_sec
        self.initial_solution = initial_solution
        self.rng = random.Random(random_seed)
        self._route_cache: Dict[
            Tuple[Tuple[object, ...], Tuple[Tuple[str, str], ...]],
            RouteEvaluation,
        ] = {}
        self._quick_route_cache: Dict[
            Tuple[Tuple[object, ...], Tuple[Tuple[str, str], ...]],
            RouteEvaluation,
        ] = {}
        self._resource_profile_cache: Dict[int, Tuple[object, ...]] = {}
        self._last_elimination_path: List[List[List[ScheduledStop]]] = []
        self._last_split_candidates: List[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = []
        self._last_diversified_candidates: List[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = []
        self._vehicle_guidance_vnd = 1_000_000
        self._same_order_guidance_vnd = 2_000_000
        self._day_guidance_vnd = 50_000
        self._allow_empty_insertion_competition = False
        self._route_pool: List[Tuple[int, List[ScheduledStop]]] = []

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

    def _resource_profile(self, vehicle_index: int) -> Tuple[object, ...]:
        """Return every resource attribute that can change route evaluation.

        Vehicle and depot IDs are intentionally excluded. Benchmark datasets
        often model several interchangeable resources with distinct IDs; the
        matrix rows and economic/physical attributes capture real differences.
        """
        cached = self._resource_profile_cache.get(vehicle_index)
        if cached is not None:
            return cached
        vehicle = self.vehicles[vehicle_index]
        driver = self.drivers[vehicle_index]
        end_depot = vehicle.end_depot or vehicle.depot
        depot_index = self.node_id_to_index[vehicle.depot.id]
        end_depot_index = self.node_id_to_index[end_depot.id]
        service_indices = sorted(
            {
                self.node_id_to_index[location.id]
                for order in self.orders
                for location in (order.pickup_location, order.delivery_location)
            }
        )
        profile = (
            vehicle.service_day_index,
            vehicle.available_start_sec,
            vehicle.available_end_sec,
            driver.service_day_index,
            vehicle.length_cm,
            vehicle.width_cm,
            vehicle.height_cm,
            vehicle.payload_limit_kg,
            vehicle.door_position,
            vehicle.fuel_consumption_liters_per_100_km,
            vehicle.load_fuel_surcharge_percent_at_full_payload,
            vehicle.fixed_operating_cost_vnd,
            tuple(self.distance_matrix[depot_index][index] for index in service_indices),
            tuple(self.duration_matrix[depot_index][index] for index in service_indices),
            tuple(self.distance_matrix[index][end_depot_index] for index in service_indices),
            tuple(self.duration_matrix[index][end_depot_index] for index in service_indices),
            driver.fixed_salary_monthly_vnd,
            driver.trip_base_pay_vnd,
            driver.per_km_pay_vnd,
        )
        self._resource_profile_cache[vehicle_index] = profile
        return profile

    def _evaluate_route(
        self,
        vehicle_index: int,
        stops: List[ScheduledStop],
        *,
        allow_layout_search: bool = True,
    ) -> RouteEvaluation:
        key = (
            self._resource_profile(vehicle_index),
            self._route_key(stops),
            allow_layout_search,
        )
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
            allow_layout_search=allow_layout_search,
        )
        self._route_cache[key] = copy.deepcopy(evaluation)
        return evaluation

    def _evaluate_route_without_packing(
        self, vehicle_index: int, stops: List[ScheduledStop]
    ) -> RouteEvaluation:
        """Reject temporal/load-invalid sequences before geometric packing."""
        key = (self._resource_profile(vehicle_index), self._route_key(stops))
        cached = self._quick_route_cache.get(key)
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
            use_fast_packing=False,
        )
        self._quick_route_cache[key] = copy.deepcopy(evaluation)
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
        if route_length <= 20:
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
            key=lambda index: (
                self.vehicles[index].service_day_index,
                -self.vehicles[index].payload_limit_kg,
            ),
        )
        for index in empty_indices:
            vehicle = self.vehicles[index]
            driver = self.drivers[index]
            end_depot = vehicle.end_depot or vehicle.depot
            profile = (
                vehicle.service_day_index,
                vehicle.available_start_sec,
                vehicle.available_end_sec,
                driver.service_day_index,
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
        limit: int = 5,
    ) -> List[_Insertion]:
        has_empty_vehicles = any(not r for r in routes)
        order_obj = self.order_by_id.get(order_id)
        order_items_count = len(order_obj.items) if order_obj else 1
        active_indices = []
        for idx, r in enumerate(routes):
            if not r:
                continue
            if has_empty_vehicles:
                r_orders = {s.order_id for s in r if s.order_id}
                max_safe_orders = 12 if self.vehicles[idx].payload_limit_kg > 5000 else 8
                if len(r_orders) >= max_safe_orders:
                    continue
                r_items = sum(
                    len(self.order_by_id[s.order_id].items)
                    for s in r
                    if s.order_id and s.stop_type == "PICKUP" and s.order_id in self.order_by_id
                )
                max_safe_items = 25 if self.vehicles[idx].payload_limit_kg < 3000 else 38
                if r_items + order_items_count > max_safe_items:
                    continue
            active_indices.append(idx)
        if not active_indices and not has_empty_vehicles:
            active_indices = [idx for idx, r in enumerate(routes) if r]
        options = self._insertions_on_vehicles(
            order_id, routes, active_indices, deadline, limit
        )

        empty_options: List[_Insertion] = []
        empty_indices: List[int] = []
        if self._allow_empty_insertion_competition or len(options) < limit:
            empty_limit = limit if self._allow_empty_insertion_competition else limit - len(options)
            empty_indices = self._representative_empty_vehicle_indices(routes)
            empty_options = self._insertions_on_vehicles(
                order_id,
                routes,
                empty_indices,
                deadline,
                empty_limit,
            )
            options.extend(empty_options)

        options.sort(key=lambda option: (option.delta_cost, option.evaluation.distance_km))
        selected = options[:limit]
        if self._allow_empty_insertion_competition and empty_options:
            required_empty: List[_Insertion] = []
            seen_empty_vehicles = set()
            for option in empty_options:
                if option.vehicle_index in seen_empty_vehicles:
                    continue
                seen_empty_vehicles.add(option.vehicle_index)
                required_empty.append(option)
            required_empty = required_empty[:limit]
            active_options = [
                option
                for option in options
                if option.vehicle_index not in empty_indices
            ]
            selected = (
                active_options[: max(0, limit - len(required_empty))]
                + required_empty
            )
            selected.sort(
                key=lambda option: (option.delta_cost, option.evaluation.distance_km)
            )
        return selected

    def _insertions_on_vehicles(
        self,
        order_id: str,
        routes: List[List[ScheduledStop]],
        vehicle_indices: Sequence[int],
        deadline: float,
        limit: int,
    ) -> List[_Insertion]:
        """Return cheapest packing-feasible insertions on explicit vehicles.

        Temporal, capacity and economic checks are cheap.  Sorting those
        candidates first means the geometric packing checker only runs until
        enough best feasible options have been found; accepted insertions are
        still always packing-checked.
        """
        if limit <= 0:
            return []
        order = self.order_by_id[order_id]
        pickup, delivery = self._make_stops(order)
        quick_candidates: List[Tuple[int, float, int, List[ScheduledStop]]] = []
        for vehicle_index in vehicle_indices:
            if time.perf_counter() >= deadline:
                break
            vehicle = self.vehicles[vehicle_index]
            if order.total_weight_kg > vehicle.payload_limit_kg + 0.01:
                continue
            if order.allowed_source_vehicle_ids:
                src_id = vehicle.source_vehicle_id or vehicle.id
                if src_id not in order.allowed_source_vehicle_ids and vehicle.id not in order.allowed_source_vehicle_ids:
                    continue
            if (
                order.pickup_window_end_sec < vehicle.available_start_sec
                or order.delivery_window_start_sec > vehicle.available_end_sec
            ):
                continue
            current = routes[vehicle_index]
            target_source_id = order.source_order_id or order.id
            shares_source_order = (
                any(
                    s.order_id in self.order_by_id
                    and (self.order_by_id[s.order_id].source_order_id or s.order_id)
                    == target_source_id
                    for s in current
                )
            )
            current_cost = self._route_cost(vehicle_index, current)
            for pickup_pos, delivery_pos in self._candidate_positions(len(current)):
                if time.perf_counter() >= deadline:
                    break
                if pickup_pos > 0 and current[pickup_pos - 1].departure_time_sec > order.pickup_window_end_sec:
                    continue
                pred_deliv_idx = delivery_pos - 2
                if 0 <= pred_deliv_idx < len(current) and current[pred_deliv_idx].departure_time_sec > order.delivery_window_end_sec:
                    continue
                candidate = (
                    current[:pickup_pos]
                    + [pickup]
                    + current[pickup_pos : delivery_pos - 1]
                    + [delivery]
                    + current[delivery_pos - 1 :]
                )
                quick = self._evaluate_route_without_packing(vehicle_index, candidate)
                if not quick.feasible or quick.cost is None:
                    continue
                delta_val = quick.cost.total_cost_vnd - current_cost
                if not current:
                    delta_val += self.vehicles[vehicle_index].service_day_index * self._day_guidance_vnd
                elif shares_source_order:
                    delta_val -= self._same_order_guidance_vnd
                quick_candidates.append(
                    (
                        delta_val,
                        quick.distance_km,
                        vehicle_index,
                        quick.stops,
                    )
                )

        quick_candidates.sort(key=lambda row: (row[0], row[1]))
        options: List[_Insertion] = []
        rejected_for_fallback: List[Tuple[float, int, List[ScheduledStop]]] = []

        # Tier 1: Fast packing filter with allow_layout_search=False
        for _delta, _distance, vehicle_index, candidate in quick_candidates:
            if time.perf_counter() >= deadline:
                break
            evaluation = self._evaluate_route(
                vehicle_index, candidate, allow_layout_search=False
            )
            if not evaluation.feasible or evaluation.cost is None:
                if len(rejected_for_fallback) < 6:
                    rejected_for_fallback.append((_delta, vehicle_index, candidate))
                continue
            current_cost = self._route_cost(vehicle_index, routes[vehicle_index])
            d_cost = evaluation.cost.total_cost_vnd - current_cost
            if not routes[vehicle_index]:
                d_cost += self.vehicles[vehicle_index].service_day_index * self._day_guidance_vnd
            elif (
                order.split_group_id is None
                and any(
                    s.order_id in self.order_by_id
                    and (self.order_by_id[s.order_id].source_order_id or s.order_id)
                    == (order.source_order_id or order.id)
                    for s in routes[vehicle_index]
                )
            ):
                d_cost -= self._same_order_guidance_vnd
            options.append(
                _Insertion(
                    order_id=order_id,
                    vehicle_index=vehicle_index,
                    stops=evaluation.stops,
                    evaluation=evaluation,
                    delta_cost=d_cost,
                )
            )
            if len(options) >= limit:
                break

        # Tier 2: Bounded spatial fallback on at most 2 top rejected candidates if needed
        need_fallback = len(options) < limit or (
            options
            and rejected_for_fallback
            and rejected_for_fallback[0][0] < options[0].delta_cost
        )
        if need_fallback and rejected_for_fallback:
            for _r_delta, v_idx, cand_stops in rejected_for_fallback[:2]:
                if time.perf_counter() >= deadline:
                    break
                eval_fb = self._evaluate_route(
                    v_idx, cand_stops, allow_layout_search=True
                )
                if not eval_fb.feasible or eval_fb.cost is None:
                    continue
                c_cost = self._route_cost(v_idx, routes[v_idx])
                fb_cost = eval_fb.cost.total_cost_vnd - c_cost
                if not routes[v_idx]:
                    fb_cost += self.vehicles[v_idx].service_day_index * self._day_guidance_vnd
                elif (
                    order.split_group_id is None
                    and any(
                        s.order_id in self.order_by_id
                        and (self.order_by_id[s.order_id].source_order_id or s.order_id)
                        == (order.source_order_id or order.id)
                        for s in routes[v_idx]
                    )
                ):
                    fb_cost -= self._same_order_guidance_vnd
                options.append(
                    _Insertion(
                        order_id=order_id,
                        vehicle_index=v_idx,
                        stops=eval_fb.stops,
                        evaluation=eval_fb,
                        delta_cost=fb_cost,
                    )
                )

        options.sort(key=lambda opt: opt.delta_cost)
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
        candidates = []
        for idx in nonempty_indices:
            order_ids = list(
                dict.fromkeys(
                    stop.order_id
                    for stop in routes[idx]
                    if stop.stop_type == "PICKUP" and stop.order_id
                )
            )
            candidates.append(
                (len(order_ids), -self._route_cost(idx, routes[idx]), idx)
            )
        candidates.sort()
        target_idx = candidates[0][2]
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

    def _extra_order_trips(self, routes: List[List[ScheduledStop]]) -> int:
        trips_by_source: Dict[str, Set[int]] = {}
        for v_idx, route in enumerate(routes):
            for stop in route:
                if stop.stop_type != "PICKUP" or not stop.order_id:
                    continue
                order = self.order_by_id.get(stop.order_id)
                source_id = (order.source_order_id or order.id) if order else stop.order_id
                trips_by_source.setdefault(source_id, set()).add(v_idx)
        return sum(max(0, len(v_set) - 1) for v_set in trips_by_source.values())

    def _plan_cost(
        self, routes: List[List[ScheduledStop]], unassigned: List[str]
    ) -> int:
        """Search surrogate; final candidates are ranked by lexicographic objective."""
        active_vehicles = sum(bool(route) for route in routes)
        consolidation_guidance = active_vehicles * self._vehicle_guidance_vnd
        grouping_guidance = (
            self._extra_order_trips(routes) * self._same_order_guidance_vnd
        )
        feasibility_guidance = (
            len(unassigned) * self.policy.unassigned_order_penalty_vnd * 2
        )
        day_guidance = sum(
            self.vehicles[index].service_day_index * self._day_guidance_vnd
            for index, route in enumerate(routes)
            if route
        )
        return (
            self._economic_plan_cost(routes, unassigned)
            + grouping_guidance
            + consolidation_guidance
            + feasibility_guidance
            + day_guidance
        )

    def _candidate_key(
        self, routes: List[List[ScheduledStop]], unassigned: List[str],
    ) -> Tuple[int, int, int, int]:
        """Order an elite before audit without allowing costs to buy trips."""
        return (len(set(unassigned)), self._extra_order_trips(routes),
                sum(bool(route) for route in routes),
                self._economic_plan_cost(routes, unassigned))

    def _polish_seed(
        self, routes: List[List[ScheduledStop]], unassigned: List[str], deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Improve stop order without changing package/vehicle assignments."""
        current = copy.deepcopy(routes)
        for _ in range(2):
            if time.perf_counter() >= deadline:
                break
            neighbor = self._best_intra_route_relocation(
                current, unassigned, [i for i,r in enumerate(current) if r], deadline)
            if neighbor is None or self._candidate_key(neighbor[1], neighbor[2]) >= self._candidate_key(current, unassigned):
                break
            current = neighbor[1]
        return current

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

    def _time_wave_order_sequence(self) -> List[str]:
        """Interleave pickup waves while reversing every second wave.

        A plain earliest-window construction tends to fill the vehicle with one
        wave before it sees cargo from the next wave.  Interleaving the waves
        exposes floor-reuse opportunities to the insertion heuristic.  The
        alternating direction avoids giving the same edge of every wave a
        permanent priority while remaining deterministic for a caller seed.
        """
        orders_by_pickup_start: Dict[int, List[str]] = {}
        for order in self.orders:
            orders_by_pickup_start.setdefault(
                order.pickup_window_start_sec,
                [],
            ).append(order.id)
        if len(orders_by_pickup_start) < 2:
            return []

        waves: List[List[str]] = []
        for wave_index, pickup_start in enumerate(sorted(orders_by_pickup_start)):
            wave = list(orders_by_pickup_start[pickup_start])
            if wave_index % 2 == 1:
                wave.reverse()
            waves.append(wave)

        sequence: List[str] = []
        offset = 0
        while any(offset < len(wave) for wave in waves):
            for wave in waves:
                if offset < len(wave):
                    sequence.append(wave[offset])
            offset += 1
        return sequence

    def _build_time_wave_start(
        self,
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        candidate_sequences: List[List[str]] = []

        orders_by_pickup_start: Dict[int, List[str]] = {}
        for order in self.orders:
            orders_by_pickup_start.setdefault(
                order.pickup_window_start_sec,
                [],
            ).append(order.id)

        order_ids = [order.id for order in self.orders]
        by_deadline = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda o: (o.delivery_window_end_sec, o.pickup_window_start_sec),
            )
        ]

        wave_seq = self._time_wave_order_sequence()

        # In a multi-shift relay problem (3-4 distinct shift waves), pickup wave sequence is primary.
        # When pickup windows are fine-grained (> 4), original / deadline order is primary.
        if 3 <= len(orders_by_pickup_start) <= 4 and wave_seq:
            candidate_sequences.append(wave_seq)
            candidate_sequences.append(order_ids)
            candidate_sequences.append(by_deadline)
        else:
            candidate_sequences.append(order_ids)
            candidate_sequences.append(by_deadline)
            if wave_seq:
                candidate_sequences.append(wave_seq)

        # Pickup window sequence
        by_pickup = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda o: (o.pickup_window_start_sec, o.delivery_window_end_sec),
            )
        ]
        if by_pickup not in candidate_sequences:
            candidate_sequences.append(by_pickup)

        best_candidate: Optional[Tuple[int, List[List[ScheduledStop]], List[str]]] = None
        self._last_wave_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []

        for idx, seq in enumerate(candidate_sequences):
            if idx >= 2 and best_candidate is not None and time.perf_counter() >= deadline:
                break
            routes, unassigned = self._sequential_construction(seq, deadline)
            if unassigned:
                continue
            cand_cost = self._plan_cost(routes, unassigned)
            self._last_wave_candidates.append((cand_cost, copy.deepcopy(routes), list(unassigned)))
            if sum(bool(r) for r in routes) <= 3:
                for _ in range(3):
                    if time.perf_counter() >= deadline:
                        break
                    relocated = self._best_relocation(
                        routes,
                        unassigned,
                        deadline,
                        sample_limit=len(self.orders),
                    )
                    if relocated is None or relocated[0] >= cand_cost:
                        break
                    cand_cost, routes, unassigned = relocated
                    self._last_wave_candidates.append(
                        (cand_cost, copy.deepcopy(routes), list(unassigned))
                    )
            if best_candidate is None or cand_cost < best_candidate[0]:
                best_candidate = (cand_cost, routes, unassigned)
            if sum(bool(r) for r in routes) >= 6:
                break

        return best_candidate


    def _diversified_construction(
        self,
        order_sequence: Sequence[str],
        deadline: float,
        *,
        alpha: float = 0.0,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Construct a start from a wider restricted candidate list."""
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
                limit=2 if alpha <= 0.0 else max(4, min(12, len(self.vehicles) * 2)),
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
            chosen = self.rng.choice(restricted or [options[0]])
            routes[chosen.vehicle_index] = chosen.stops
        return routes, unassigned

    def _build_diversified_start(
        self, deadline: float
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        sequences = [
            [
                order.id
                for order in sorted(
                    self.orders,
                    key=lambda order: (
                        order.pickup_window_start_sec,
                        order.delivery_window_end_sec,
                    ),
                )
            ],
            [
                order.id
                for order in sorted(
                    self.orders,
                    key=lambda order: sum(
                        item.length_cm * item.width_cm for item in order.items
                    ),
                    reverse=True,
                )
            ],
            [
                order.id
                for order in sorted(
                    self.orders,
                    key=lambda order: order.total_weight_kg,
                    reverse=True,
                )
            ],
        ]
        best_candidate = None
        self._last_diversified_candidates = []
        for sequence in sequences:
            if time.perf_counter() >= deadline:
                break
            routes, unassigned = self._diversified_construction(
                sequence, deadline
            )
            if unassigned:
                continue
            improved = self._best_relocation(
                routes,
                unassigned,
                deadline,
                sample_limit=len(self.orders)
                if sum(bool(r) for r in routes) <= 3
                else min(8, len(self.orders)),
            )
            if improved is not None:
                candidate_cost, routes, unassigned = improved
            else:
                candidate_cost = self._plan_cost(routes, unassigned)
            candidate = (candidate_cost, copy.deepcopy(routes), list(unassigned))
            self._last_diversified_candidates.append(candidate)
            if best_candidate is None or candidate_cost < best_candidate[0]:
                best_candidate = (candidate_cost, routes, unassigned)
        return best_candidate

    def _build_multi_depot_start(
        self, deadline: float
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Evaluate a small deterministic multi-start population for depot choice."""
        order_ids = [order.id for order in self.orders]
        by_deadline = sorted(
            order_ids,
            key=lambda order_id: self.order_by_id[
                order_id
            ].delivery_window_end_sec,
        )
        # Pre-generate the full small population before evaluation so the
        # construction/local-search random stream is stable across budgets.
        randomized_sequences: List[List[str]] = []
        while len(randomized_sequences) < 8:
            chromosome = list(order_ids)
            self.rng.shuffle(chromosome)
            randomized_sequences.append(chromosome)
        # Interleave both halves of the generated population.  Adjacent
        # shuffles can remain in the same depot-assignment basin; under a
        # wall-clock deadline the second half was never evaluated even when it
        # contained the strongest assignment for that caller seed.
        half = len(randomized_sequences) // 2
        priority_indices = list(range(min(2, half)))
        for offset in range(half):
            priority_indices.append(half + offset)
            if 2 + offset < half:
                priority_indices.append(2 + offset)
        diversified_order = [
            randomized_sequences[index]
            for index in priority_indices
        ]
        by_pickup = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda o: (o.pickup_window_start_sec, o.delivery_window_end_sec),
            )
        ]
        # Evaluate structured starts first, then diverse depot assignments
        sequences = [by_deadline, by_pickup, list(order_ids)] + diversified_order

        best_candidate = None
        self._last_multi_depot_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []
        for sequence in sequences:
            if best_candidate is not None and time.perf_counter() >= deadline:
                break
            routes, unassigned = self._diversified_construction(
                sequence, deadline
            )
            if unassigned:
                continue
            improved = self._best_relocation(
                routes,
                unassigned,
                deadline,
                sample_limit=min(6, len(self.orders)),
            )
            if improved is not None:
                candidate_cost, routes, unassigned = improved
            else:
                candidate_cost = self._plan_cost(routes, unassigned)
            candidate = (candidate_cost, copy.deepcopy(routes), list(unassigned))
            self._last_multi_depot_candidates.append(candidate)
            if best_candidate is None or candidate_cost < best_candidate[0]:
                best_candidate = (candidate_cost, routes, unassigned)

        if best_candidate is not None and time.perf_counter() < deadline:
            cand_cost, routes, unassigned = best_candidate
            active_v = [v_idx for v_idx, r in enumerate(routes) if r]
            if active_v and time.perf_counter() < deadline:
                intra = self._best_intra_route_relocation(
                    routes, unassigned, active_v, deadline
                )
                if intra is not None:
                    best_candidate = intra
                    cand_cost, routes, unassigned = best_candidate
            improved = self._best_relocation(
                routes,
                unassigned,
                deadline,
                sample_limit=min(6, len(self.orders)),
            )
            if improved is not None:
                best_candidate = improved

        return best_candidate

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
        self._last_elimination_path = [copy.deepcopy(current_routes)]
        while improved and time.perf_counter() < deadline:
            improved = False
            active_vehicles = [
                (idx, len({s.order_id for s in current_routes[idx] if s.order_id}))
                for idx, r in enumerate(current_routes)
                if r
            ]
            active_vehicles.sort(key=lambda x: x[1])
            for victim_idx, count in active_vehicles:
                if (count > max(12, len(self.orders) // 2)) or time.perf_counter() >= deadline:
                    continue
                merged = self._try_eliminate_route(
                    current_routes, victim_idx, deadline, use_regret=False
                )
                if merged is None and time.perf_counter() < deadline:
                    merged = self._try_eliminate_route(
                        current_routes, victim_idx, deadline, use_regret=True
                    )
                if merged is not None:
                    current_routes = merged
                    self._last_elimination_path.append(copy.deepcopy(current_routes))
                    improved = True
                    break
        return current_routes

    def _try_eliminate_route(
        self,
        routes: List[List[ScheduledStop]],
        victim_idx: int,
        deadline: float,
        *,
        use_regret: bool,
    ) -> Optional[List[List[ScheduledStop]]]:
        """Try moving every order off one route without reopening empty routes."""
        candidate_routes = [copy.deepcopy(route) for route in routes]
        victim_orders = list(
            dict.fromkeys(
                stop.order_id
                for stop in candidate_routes[victim_idx]
                if stop.order_id
            )
        )
        candidate_routes[victim_idx] = []
        pending = victim_orders

        while pending and time.perf_counter() < deadline:
            target_indices = [
                index
                for index, route in enumerate(candidate_routes)
                if route and index != victim_idx
                and len({s.order_id for s in route if s.order_id}) < (30 if self.vehicles[index].payload_limit_kg > 5000 else 20)
                and sum(
                    len(self.order_by_id[s.order_id].items)
                    for s in route
                    if s.order_id and s.stop_type == "PICKUP" and s.order_id in self.order_by_id
                ) < (150 if self.vehicles[index].payload_limit_kg > 5000 else 80)
            ]
            choices: List[Tuple[int, int, str, _Insertion]] = []
            order_ids = pending if use_regret else pending[:1]
            for order_id in order_ids:
                options = self._insertions_on_vehicles(
                    order_id,
                    candidate_routes,
                    target_indices,
                    deadline,
                    2 if use_regret else 1,
                )
                if not options:
                    if not use_regret:
                        return None
                    continue
                best = options[0]
                kth_cost = (
                    options[1].delta_cost
                    if len(options) > 1
                    else best.delta_cost + self.policy.unassigned_order_penalty_vnd
                )
                choices.append(
                    (kth_cost - best.delta_cost, -best.delta_cost, order_id, best)
                )

            if not choices:
                return None
            if use_regret:
                _, _, chosen_id, chosen = max(
                    choices, key=lambda row: (row[0], row[1])
                )
            else:
                _, _, chosen_id, chosen = choices[0]
            candidate_routes[chosen.vehicle_index] = chosen.stops
            pending.remove(chosen_id)

        return candidate_routes if not pending else None

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
        if sample_limit >= len(assigned):
             prioritized: List[str] = []
             for v_idx, r_stops in enumerate(routes):
                 if r_stops:
                     prioritized.extend(self._orders_by_removal_saving(v_idx, r_stops))
             assigned = list(dict.fromkeys(prioritized + assigned))
        else:
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

    def _best_route_split(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Build the cheapest one-order split onto an unused resource.

        This neighborhood deliberately permits a higher route count. It is
        useful after sequence optimization finds a cheap route whose packing
        is too tight for the production spatial validator, and for multi-depot
        cases where a nearby extra vehicle lowers the real economic cost.
        """
        best_split: Optional[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = None
        split_candidates: List[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = []
        for source_index, source_route in enumerate(routes):
            if time.perf_counter() >= deadline:
                break
            order_ids = list(
                dict.fromkeys(
                    stop.order_id
                    for stop in source_route
                    if stop.stop_type == "PICKUP" and stop.order_id
                )
            )
            if len(order_ids) < 2:
                continue
            for order_id in order_ids:
                if time.perf_counter() >= deadline:
                    break
                reduced = self._remove_orders(routes, {order_id})
                empty_indices = self._representative_empty_vehicle_indices(reduced)
                options = self._insertions_on_vehicles(
                    order_id,
                    reduced,
                    empty_indices,
                    deadline,
                    limit=max(1, len(empty_indices)),
                )
                for option in options:
                    candidate_routes = copy.deepcopy(reduced)
                    candidate_routes[option.vehicle_index] = option.stops
                    candidate_cost = self._plan_cost(candidate_routes, unassigned)
                    split_candidates.append(
                        (candidate_cost, candidate_routes, list(unassigned))
                    )
                    if best_split is None or candidate_cost < best_split[0]:
                        best_split = (
                            candidate_cost,
                            candidate_routes,
                            list(unassigned),
                        )
        self._last_split_candidates = sorted(
            split_candidates, key=lambda candidate: candidate[0]
        )
        return best_split

    def _orders_by_removal_saving(
        self,
        vehicle_index: int,
        route: List[ScheduledStop],
    ) -> List[str]:
        route_cost = self._route_cost(vehicle_index, route)
        order_ids = list(
            dict.fromkeys(
                stop.order_id
                for stop in route
                if stop.stop_type == "PICKUP" and stop.order_id
            )
        )
        return sorted(
            order_ids,
            key=lambda order_id: route_cost
            - self._route_cost(
                vehicle_index,
                [stop for stop in route if stop.order_id != order_id],
            ),
            reverse=True,
        )

    def _best_order_exchange(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str], Tuple[int, int]]]:
        """Try reciprocal order exchanges between active routes."""
        best_exchange = None
        attempts = 0
        active_indices = [index for index, route in enumerate(routes) if route]
        order_limit = 8 if len(active_indices) <= 3 else 4
        attempt_limit = 40 if len(active_indices) <= 3 else 16
        for first_pos, first_index in enumerate(active_indices):
            for second_index in active_indices[first_pos + 1:]:
                first_orders = self._orders_by_removal_saving(
                    first_index, routes[first_index]
                )[:order_limit]
                second_orders = self._orders_by_removal_saving(
                    second_index, routes[second_index]
                )[:order_limit]
                for first_order in first_orders:
                    for second_order in second_orders:
                        if time.perf_counter() >= deadline:
                            return best_exchange
                        attempts += 1
                        reduced = self._remove_orders(
                            routes, {first_order, second_order}
                        )
                        first_options = self._insertions_on_vehicles(
                            first_order,
                            reduced,
                            [second_index],
                            deadline,
                            limit=3,
                        )
                        second_options = self._insertions_on_vehicles(
                            second_order,
                            reduced,
                            [first_index],
                            deadline,
                            limit=3,
                        )
                        if not first_options or not second_options:
                            continue
                        for opt1 in first_options:
                            for opt2 in second_options:
                                candidate_routes = copy.deepcopy(reduced)
                                candidate_routes[second_index] = opt1.stops
                                candidate_routes[first_index] = opt2.stops
                                candidate_cost = self._plan_cost(
                                    candidate_routes, unassigned
                                )
                                candidate = (
                                    candidate_cost,
                                    candidate_routes,
                                    list(unassigned),
                                    (first_index, second_index),
                                )
                                if best_exchange is None or candidate_cost < best_exchange[0]:
                                    best_exchange = candidate
                        if attempts >= attempt_limit:
                            return best_exchange

                # 2-order simultaneous swap if single swap didn't find improving move
                if len(first_orders) >= 2 and len(second_orders) >= 2 and attempts < attempt_limit:
                    for f_i in range(min(2, len(first_orders) - 1)):
                        for s_i in range(min(2, len(second_orders) - 1)):
                            if time.perf_counter() >= deadline or attempts >= attempt_limit:
                                break
                            pair1 = {first_orders[f_i], first_orders[f_i + 1]}
                            pair2 = {second_orders[s_i], second_orders[s_i + 1]}
                            attempts += 1
                            reduced2 = self._remove_orders(routes, pair1 | pair2)
                            ins = copy.deepcopy(reduced2)
                            failed = False
                            for o in pair1:
                                opts = self._insertions_on_vehicles(o, ins, [second_index], deadline, limit=1)
                                if not opts:
                                    failed = True
                                    break
                                ins[second_index] = opts[0].stops
                            if failed:
                                continue
                            for o in pair2:
                                opts = self._insertions_on_vehicles(o, ins, [first_index], deadline, limit=1)
                                if not opts:
                                    failed = True
                                    break
                                ins[first_index] = opts[0].stops
                            if failed:
                                continue
                            c_cost = self._plan_cost(ins, unassigned)
                            if best_exchange is None or c_cost < best_exchange[0]:
                                best_exchange = (c_cost, ins, list(unassigned), (first_index, second_index))
        return best_exchange

    def _first_improving_stop_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Find a quick improving move with the full pickup/delivery manifest.

        Pair reinsertion cannot reach every useful stop ordering in one move.
        Schedule and price first; only improving moves pay for packing checks.
        The original incumbent remains available if final spatial audit fails.
        """
        incumbent_costs: Dict[int, int] = {}
        moves = ranked_stop_moves(
            [[self.node_id_to_index[stop.location_id] for stop in route] for route in routes],
            [[(stop.order_id or "", stop.stop_type) for stop in route] for route in routes],
            [self.node_id_to_index[vehicle.depot.id] for vehicle in self.vehicles],
            [self.node_id_to_index[(vehicle.end_depot or vehicle.depot).id] for vehicle in self.vehicles],
            self.distance_matrix, deadline,
        )
        for _, vehicle_index, source, target in moves:
            if time.perf_counter() >= deadline:
                return None
            route = routes[vehicle_index]
            reduced = route[:source] + route[source + 1:]
            moved = reduced[:target] + [route[source]] + reduced[target:]
            quick = self._evaluate_route_without_packing(vehicle_index, moved)
            if not quick.feasible or quick.cost is None:
                continue
            if vehicle_index not in incumbent_costs:
                incumbent_costs[vehicle_index] = self._route_cost(vehicle_index, route)
            saving = incumbent_costs[vehicle_index] - quick.cost.total_cost_vnd
            if saving <= 0:
                continue
            checked = self._evaluate_route(vehicle_index, quick.stops, allow_layout_search=False)
            if not checked.feasible:
                continue
            candidate = list(routes)
            candidate[vehicle_index] = checked.stops
            # Yield now so the caller can apply and re-probe the changed plan
            # instead of spending the whole budget on one best-improvement scan.
            return (self._plan_cost(candidate, unassigned), candidate, list(unassigned))
        return None

    def _best_intra_route_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        vehicle_indices: Sequence[int],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        incumbent_cost = self._plan_cost(routes, unassigned)
        best_candidate = None
        for vehicle_index in vehicle_indices:
            current_route = routes[vehicle_index]
            if not current_route:
                continue

            # 1. Fast Adjacent Stop Swap (2-opt stop order)
            for i in range(len(current_route) - 1):
                if time.perf_counter() >= deadline:
                    return best_candidate
                s1 = current_route[i]
                s2 = current_route[i + 1]
                if s1.order_id == s2.order_id and s1.stop_type == "PICKUP" and s2.stop_type == "DELIVERY":
                    continue
                if s1.order_id == s2.order_id and s1.stop_type == "DELIVERY" and s2.stop_type == "PICKUP":
                    continue
                cand_stops = current_route[:i] + [s2, s1] + current_route[i + 2:]
                eval_swap = self._evaluate_route(vehicle_index, cand_stops, allow_layout_search=False)
                if eval_swap.feasible and eval_swap.cost is not None:
                    cand_routes = copy.deepcopy(routes)
                    cand_routes[vehicle_index] = eval_swap.stops
                    c_cost = self._plan_cost(cand_routes, unassigned)
                    if c_cost < incumbent_cost:
                        if best_candidate is None or c_cost < best_candidate[0]:
                            best_candidate = (c_cost, cand_routes, list(unassigned))

            # 2. Single Order Removal and Optimal Reinsertion
            order_ids = self._orders_by_removal_saving(vehicle_index, current_route)
            for order_id in order_ids:
                if time.perf_counter() >= deadline:
                    return best_candidate
                reduced = self._remove_orders(routes, {order_id})
                options = self._insertions_on_vehicles(
                    order_id,
                    reduced,
                    [vehicle_index],
                    deadline,
                    limit=6,
                )
                for option in options:
                    candidate_routes = copy.deepcopy(reduced)
                    candidate_routes[vehicle_index] = option.stops
                    candidate_cost = self._plan_cost(candidate_routes, unassigned)
                    if candidate_cost < incumbent_cost:
                        if best_candidate is None or candidate_cost < best_candidate[0]:
                            best_candidate = (candidate_cost, candidate_routes, list(unassigned))

            # 3. Intra-route Pair Reinsertion for tightly constrained routes
            if len(order_ids) >= 2 and time.perf_counter() < deadline:
                for i_pos in range(min(3, len(order_ids))):
                    o1 = order_ids[i_pos]
                    for j_pos in range(i_pos + 1, min(4, len(order_ids))):
                        if time.perf_counter() >= deadline:
                            return best_candidate
                        o2 = order_ids[j_pos]
                        reduced_2 = self._remove_orders(routes, {o1, o2})
                        opts1 = self._insertions_on_vehicles(o1, reduced_2, [vehicle_index], deadline, limit=3)
                        for opt1 in opts1:
                            r_step1 = copy.deepcopy(reduced_2)
                            r_step1[vehicle_index] = opt1.stops
                            opts2 = self._insertions_on_vehicles(o2, r_step1, [vehicle_index], deadline, limit=3)
                            for opt2 in opts2:
                                r_step2 = copy.deepcopy(r_step1)
                                r_step2[vehicle_index] = opt2.stops
                                cand_cost = self._plan_cost(r_step2, unassigned)
                                if cand_cost < incumbent_cost:
                                    if best_candidate is None or cand_cost < best_candidate[0]:
                                        best_candidate = (cand_cost, r_step2, list(unassigned))
        return best_candidate

    def _best_vehicle_reassignment(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Try reassigning active routes to cheaper empty vehicles or swapping vehicles."""
        current_cost = self._plan_cost(routes, unassigned)
        best_candidate = None
        active_indices = [idx for idx, r in enumerate(routes) if r]
        empty_indices = [idx for idx, r in enumerate(routes) if not r]

        # 1. Try shifting an active route to a cheaper empty vehicle
        checked_empty_types: Set[Tuple] = set()
        for src_idx in active_indices:
            src_v = self.vehicles[src_idx]
            src_stops = routes[src_idx]
            for tgt_idx in empty_indices:
                if time.perf_counter() >= deadline:
                    return best_candidate
                tgt_v = self.vehicles[tgt_idx]
                v_type = (
                    tgt_v.length_cm,
                    tgt_v.width_cm,
                    tgt_v.height_cm,
                    tgt_v.payload_limit_kg,
                    tgt_v.fixed_operating_cost_vnd,
                    tgt_v.depot.id,
                    tgt_v.service_day_index,
                )
                if v_type in checked_empty_types:
                    continue
                if (
                    tgt_v.fixed_operating_cost_vnd >= src_v.fixed_operating_cost_vnd
                    and tgt_v.fuel_consumption_liters_per_100_km >= src_v.fuel_consumption_liters_per_100_km
                    and tgt_v.depot.id == src_v.depot.id
                ):
                    continue

                eval_tgt = self._evaluate_route(tgt_idx, src_stops, allow_layout_search=False)
                if not eval_tgt.feasible or eval_tgt.cost is None:
                    continue

                checked_empty_types.add(v_type)
                cand_routes = copy.deepcopy(routes)
                cand_routes[src_idx] = []
                cand_routes[tgt_idx] = eval_tgt.stops
                cand_cost = self._plan_cost(cand_routes, unassigned)
                if cand_cost < current_cost:
                    if best_candidate is None or cand_cost < best_candidate[0]:
                        best_candidate = (cand_cost, cand_routes, list(unassigned))

        # 2. Try swapping vehicles between two active routes with different vehicle profiles
        if len(active_indices) >= 2:
            for i, v1 in enumerate(active_indices):
                for v2 in active_indices[i + 1:]:
                    if time.perf_counter() >= deadline:
                        return best_candidate
                    veh1 = self.vehicles[v1]
                    veh2 = self.vehicles[v2]
                    if (
                        veh1.fixed_operating_cost_vnd == veh2.fixed_operating_cost_vnd
                        and veh1.fuel_consumption_liters_per_100_km == veh2.fuel_consumption_liters_per_100_km
                        and veh1.depot.id == veh2.depot.id
                    ):
                        continue

                    eval1 = self._evaluate_route(v2, routes[v1], allow_layout_search=False)
                    if not eval1.feasible or eval1.cost is None:
                        continue
                    eval2 = self._evaluate_route(v1, routes[v2], allow_layout_search=False)
                    if not eval2.feasible or eval2.cost is None:
                        continue

                    cand_routes = copy.deepcopy(routes)
                    cand_routes[v1] = eval2.stops
                    cand_routes[v2] = eval1.stops
                    cand_cost = self._plan_cost(cand_routes, unassigned)
                    if cand_cost < current_cost:
                        if best_candidate is None or cand_cost < best_candidate[0]:
                            best_candidate = (cand_cost, cand_routes, list(unassigned))

        return best_candidate

    def _refine_pairwise_empty_cycles(
        self,
        routes: List[List[ScheduledStop]],
        deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Refine routes that unload each order before the next pickup.

        Once a spatial repair produces independent one-order load cycles, the
        general pickup/delivery insertion neighborhood does unnecessary
        geometric work.  Optimize the order-pair sequence directly, but rank
        with the quick evaluator and require the normal packing evaluator
        before accepting any move (especially one that changes vehicles).
        """
        active_indices = [index for index, route in enumerate(routes) if route]
        if not active_indices:
            return [copy.deepcopy(route) for route in routes]

        sequences: List[List[str]] = []
        assigned: Set[str] = set()
        for vehicle_index in active_indices:
            route = routes[vehicle_index]
            if len(route) % 2 != 0:
                return [copy.deepcopy(candidate) for candidate in routes]
            order_ids: List[str] = []
            for position in range(0, len(route), 2):
                pickup = route[position]
                delivery = route[position + 1]
                if (
                    pickup.stop_type != "PICKUP"
                    or delivery.stop_type != "DELIVERY"
                    or not pickup.order_id
                    or pickup.order_id != delivery.order_id
                    or pickup.order_id in assigned
                ):
                    return [copy.deepcopy(candidate) for candidate in routes]
                assigned.add(pickup.order_id)
                order_ids.append(pickup.order_id)
            sequences.append(order_ids)

        def stops_for(order_ids: Sequence[str]) -> List[ScheduledStop]:
            stops: List[ScheduledStop] = []
            for order_id in order_ids:
                stops.extend(self._make_stops(self.order_by_id[order_id]))
            return stops

        def routes_for(
            candidate_sequences: Sequence[Sequence[str]],
        ) -> List[List[ScheduledStop]]:
            candidate_routes = [copy.deepcopy(route) for route in routes]
            for position, vehicle_index in enumerate(active_indices):
                candidate_routes[vehicle_index] = stops_for(
                    candidate_sequences[position]
                )
            return candidate_routes

        def quick_cost(
            candidate_sequences: Sequence[Sequence[str]],
        ) -> Optional[int]:
            total = 0
            for position, vehicle_index in enumerate(active_indices):
                order_ids = candidate_sequences[position]
                if not order_ids:
                    continue
                evaluation = self._evaluate_route_without_packing(
                    vehicle_index,
                    stops_for(order_ids),
                )
                if not evaluation.feasible or evaluation.cost is None:
                    return None
                total += evaluation.cost.total_cost_vnd
            return total

        current_routes = [copy.deepcopy(route) for route in routes]
        current_cost = self._economic_plan_cost(current_routes, [])

        while time.perf_counter() < deadline:
            ranked: List[Tuple[int, List[List[str]]]] = []
            seen: Set[Tuple[Tuple[str, ...], ...]] = set()

            def consider(candidate_sequences: List[List[str]]) -> None:
                signature = tuple(tuple(row) for row in candidate_sequences)
                if signature in seen:
                    return
                seen.add(signature)
                candidate_cost = quick_cost(candidate_sequences)
                if candidate_cost is not None and candidate_cost < current_cost:
                    ranked.append((candidate_cost, candidate_sequences))

            for source_index, source in enumerate(sequences):
                for order_position, order_id in enumerate(source):
                    reduced = source[:order_position] + source[order_position + 1 :]
                    for target_index, target in enumerate(sequences):
                        insertion_base = target if target_index != source_index else reduced
                        for insertion_position in range(len(insertion_base) + 1):
                            if time.perf_counter() >= deadline:
                                return current_routes
                            candidate = [list(row) for row in sequences]
                            candidate[source_index] = list(reduced)
                            candidate[target_index] = (
                                insertion_base[:insertion_position]
                                + [order_id]
                                + insertion_base[insertion_position:]
                            )
                            consider(candidate)

                for first in range(len(source)):
                    for second in range(first + 1, len(source)):
                        if time.perf_counter() >= deadline:
                            return current_routes
                        swapped = [list(row) for row in sequences]
                        swapped[source_index][first], swapped[source_index][second] = (
                            swapped[source_index][second],
                            swapped[source_index][first],
                        )
                        consider(swapped)

                        reversed_segment = [list(row) for row in sequences]
                        reversed_segment[source_index] = (
                            source[:first]
                            + list(reversed(source[first : second + 1]))
                            + source[second + 1 :]
                        )
                        consider(reversed_segment)

            for first_index in range(len(sequences)):
                for second_index in range(first_index + 1, len(sequences)):
                    for first_position, first_order in enumerate(
                        sequences[first_index]
                    ):
                        for second_position, second_order in enumerate(
                            sequences[second_index]
                        ):
                            if time.perf_counter() >= deadline:
                                return current_routes
                            exchanged = [list(row) for row in sequences]
                            exchanged[first_index][first_position] = second_order
                            exchanged[second_index][second_position] = first_order
                            consider(exchanged)

            accepted = None
            for _, candidate_sequences in sorted(
                ranked,
                key=lambda candidate: candidate[0],
            )[:64]:
                if time.perf_counter() >= deadline:
                    break
                candidate_routes = routes_for(candidate_sequences)
                candidate_cost = self._economic_plan_cost(candidate_routes, [])
                if candidate_cost < current_cost:
                    accepted = (
                        candidate_cost,
                        candidate_routes,
                        candidate_sequences,
                    )
                    break
            if accepted is None:
                break
            current_cost, current_routes, sequences = accepted

        return current_routes

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

    @staticmethod
    def _select_audit_candidates(
        candidates: Sequence[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ],
        *,
        limit: int = 6,
        max_per_route_count: int = 4,
        fallback: Optional[Tuple[int, List[List[ScheduledStop]], List[str]]] = None,
    ) -> List[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Keep the cheapest candidate from each route-count basin first.

        Spatial feasibility often changes discontinuously when a route is
        removed.  Taking several cheap candidates from one compact (but
        invalid) basin could previously exhaust the audit budget before a
        slightly more expensive, valid route count was checked.
        """
        if limit <= 0:
            return []

        selected: List[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = []
        overflow: List[
            Tuple[int, List[List[ScheduledStop]], List[str]]
        ] = []
        counts: Dict[int, int] = {}
        if fallback is not None:
            selected.append(fallback)
            counts[sum(bool(route) for route in fallback[1])] = 1
        for candidate in candidates:
            if len(selected) >= limit:
                return selected
            if candidate is fallback:
                continue
            route_count = sum(bool(route) for route in candidate[1])
            if route_count not in counts:
                selected.append(candidate)
                counts[route_count] = 1
                if len(selected) >= limit:
                    return selected
            else:
                overflow.append(candidate)

        for candidate in overflow:
            route_count = sum(bool(route) for route in candidate[1])
            if counts.get(route_count, 0) >= max_per_route_count:
                continue
            selected.append(candidate)
            counts[route_count] = counts.get(route_count, 0) + 1
            if len(selected) >= limit:
                break
        return selected


    def _solve_set_partitioning(
        self,
        elite_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]],
        time_limit_sec: float = 0.5,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        """Combine elite routes from different iterations into a lower-cost plan using CP-SAT."""
        try:
            from ortools.sat.python import cp_model
        except ImportError:
            return None

        all_order_ids = set(self.order_by_id.keys())
        if not all_order_ids:
            return None

        seen_route_signatures = set()
        unique_routes: List[Tuple[int, List[ScheduledStop], Set[str], int]] = []

        pool_sources: List[Tuple[int, List[ScheduledStop]]] = []
        for _, plan_routes, _ in elite_candidates:
            for vehicle_index, stops in enumerate(plan_routes):
                if stops:
                    pool_sources.append((vehicle_index, stops))
        pool_sources.extend(getattr(self, "_route_pool", []))

        for vehicle_index, stops in pool_sources:
            if not stops:
                continue
            route_key = (vehicle_index, self._route_key(stops))
            if route_key in seen_route_signatures:
                continue
            seen_route_signatures.add(route_key)
            orders_served = {
                stop.order_id
                for stop in stops
                if stop.stop_type == "PICKUP" and stop.order_id
            }
            if not orders_served:
                continue
            cost = self._route_cost(vehicle_index, stops)
            unique_routes.append((vehicle_index, stops, orders_served, cost))

        if not unique_routes:
            return None

        order_to_routes: Dict[str, List[int]] = {order_id: [] for order_id in all_order_ids}
        for route_idx, (_, _, orders_served, _) in enumerate(unique_routes):
            for order_id in orders_served:
                if order_id in order_to_routes:
                    order_to_routes[order_id].append(route_idx)

        if any(len(route_indices) == 0 for route_indices in order_to_routes.values()):
            return None

        model = cp_model.CpModel()
        route_vars = [model.NewBoolVar(f"r_{i}") for i in range(len(unique_routes))]

        for order_id, route_indices in order_to_routes.items():
            model.Add(sum(route_vars[r_i] for r_i in route_indices) == 1)

        vehicle_to_routes: Dict[int, List[int]] = {}
        for route_idx, (v_idx, _, _, _) in enumerate(unique_routes):
            vehicle_to_routes.setdefault(v_idx, []).append(route_idx)
        for v_idx, route_indices in vehicle_to_routes.items():
            if len(route_indices) > 1:
                model.Add(sum(route_vars[r_i] for r_i in route_indices) <= 1)

        day_plate_to_routes: Dict[Tuple[int, str], List[int]] = {}
        day_driver_to_routes: Dict[Tuple[int, str], List[int]] = {}
        for route_idx, (v_idx, _, _, _) in enumerate(unique_routes):
            vehicle = self.vehicles[v_idx]
            plate_key = (vehicle.service_day_index, vehicle.source_vehicle_id or vehicle.plate_number or vehicle.id)
            day_plate_to_routes.setdefault(plate_key, []).append(route_idx)
            if v_idx < len(self.drivers):
                driver = self.drivers[v_idx]
                driver_key = (driver.service_day_index, driver.source_driver_id or driver.id)
                day_driver_to_routes.setdefault(driver_key, []).append(route_idx)
        for day_key, route_indices in day_plate_to_routes.items():
            if len(route_indices) > 1:
                model.Add(sum(route_vars[r_i] for r_i in route_indices) <= 1)
        for driver_key, route_indices in day_driver_to_routes.items():
            if len(route_indices) > 1:
                model.Add(sum(route_vars[r_i] for r_i in route_indices) <= 1)

        model.Minimize(sum(c_r * route_vars[r_i] for r_i, (_, _, _, c_r) in enumerate(unique_routes)))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = time_limit_sec
        solver.parameters.num_workers = 1
        status = solver.Solve(model)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            assembled_routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
            for route_idx, (v_idx, stops, _, _) in enumerate(unique_routes):
                if solver.Value(route_vars[route_idx]) == 1:
                    assembled_routes[v_idx] = copy.deepcopy(stops)
            assigned_orders = set(self._assigned_order_ids(assembled_routes))
            unassigned = [order_id for order_id in all_order_ids if order_id not in assigned_orders]
            if not unassigned:
                total_cost = self._plan_cost(assembled_routes, unassigned)
                return (total_cost, assembled_routes, unassigned)
        return None

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec - self.post_audit_reserve_sec
        # Khởi tạo nghiệm xuất phát bằng Greedy Insertion nhanh (đảm bảo 100% khả thi ban đầu)
        sol_pure_greedy = solve_greedy(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
        )
        veh_id_to_idx = {v.id: idx for idx, v in enumerate(self.vehicles)}
        greedy_routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        for r in sol_pure_greedy.routes:
            v_idx = veh_id_to_idx.get(r.vehicle.id, 0)
            greedy_routes[v_idx] = copy.deepcopy(r.stops)
        greedy_assigned = set(self._assigned_order_ids(greedy_routes))
        greedy_unassigned = [order.id for order in self.orders if order.id not in greedy_assigned]

        # So sánh giữa initial_solution (nếu có từ ngoài) và pure greedy để chọn nghiệm tốt hơn
        sol_gr = sol_pure_greedy
        if self.initial_solution is not None:
            init_routes_temp: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
            for r in self.initial_solution.routes:
                v_idx = veh_id_to_idx.get(r.vehicle.id, 0)
                init_routes_temp[v_idx] = copy.deepcopy(r.stops)
            init_assigned = set(self._assigned_order_ids(init_routes_temp))
            init_unassigned = [order.id for order in self.orders if order.id not in init_assigned]
            if self._candidate_key(init_routes_temp, init_unassigned) < self._candidate_key(greedy_routes, greedy_unassigned):
                sol_gr = self.initial_solution

        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        for r in sol_gr.routes:
            v_idx = veh_id_to_idx.get(r.vehicle.id, 0)
            routes[v_idx] = copy.deepcopy(r.stops)

        assigned = set(self._assigned_order_ids(routes))
        unassigned = [order.id for order in self.orders if order.id not in assigned]
        current_routes = copy.deepcopy(routes)
        current_unassigned = list(unassigned)
        depot_profiles = {
            (
                round(vehicle.depot.latitude, 6),
                round(vehicle.depot.longitude, 6),
                round((vehicle.end_depot or vehicle.depot).latitude, 6),
                round((vehicle.end_depot or vehicle.depot).longitude, 6),
            )
            for vehicle in self.vehicles
        }
        vehicle_profiles = {
            (
                vehicle.length_cm,
                vehicle.width_cm,
                vehicle.height_cm,
                vehicle.payload_limit_kg,
                vehicle.fixed_operating_cost_vnd,
            )
            for vehicle in self.vehicles
        }
        has_multi_depot = len(depot_profiles) > 1
        init_budget_pct = 0.35 if has_multi_depot else 0.25
        init_deadline = min(deadline, started_at + min(self.time_limit_sec * init_budget_pct, max(0.05, self.time_limit_sec - 0.2)))
        elim_deadline = min(
            # Consolidation must leave useful time for cost refinement. Merely
            # reserving 50 ms let the first neighborhood exhaust short runs.
            deadline - min(0.75, self.time_limit_sec * 0.30),
            started_at + max(self.time_limit_sec * 0.45, self.time_limit_sec - 0.1),
        )
        current_routes = self._polish_seed(
            current_routes, current_unassigned,
            min(init_deadline, time.perf_counter() + min(0.3, self.time_limit_sec * 0.08)),
        )
        current_cost = self._plan_cost(current_routes, current_unassigned)
        initial_active_route_count = sum(bool(route) for route in current_routes)

        elite_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []
        elite_candidates.append((current_cost, copy.deepcopy(current_routes), list(current_unassigned)))
        if not greedy_unassigned and greedy_routes != current_routes:
            greedy_cost = self._plan_cost(greedy_routes, greedy_unassigned)
            elite_candidates.append((greedy_cost, copy.deepcopy(greedy_routes), list(greedy_unassigned)))
        used_diversified_start = False
        should_skip_heavy_starts = bool(
            self.initial_solution is not None
            and self.time_limit_sec <= 4.0
            and not current_unassigned
        )
        if (
            not should_skip_heavy_starts
            and not current_unassigned
            and len(depot_profiles) == 1
            and len(vehicle_profiles) == 1
            and initial_active_route_count >= 2
            and self.time_limit_sec >= 2.0
            and time.perf_counter() < init_deadline
        ):
            wave_cap = 3.0 if len(self.orders) >= 14 else 1.5
            wave_frac = 0.70 if len(self.orders) >= 14 else 0.35
            wave_deadline = min(
                init_deadline,
                time.perf_counter() + min(wave_cap, max(0.0, init_deadline - time.perf_counter()) * wave_frac),
            )
            wave_start = self._build_time_wave_start(wave_deadline)
            for w_cand in getattr(self, "_last_wave_candidates", []):
                elite_candidates.append(
                    (
                        w_cand[0],
                        copy.deepcopy(w_cand[1]),
                        list(w_cand[2]),
                    )
                )
            if wave_start is not None:
                wave_cost, wave_routes, wave_unassigned = wave_start
                elite_candidates.append(
                    (
                        wave_cost,
                        copy.deepcopy(wave_routes),
                        list(wave_unassigned),
                    )
                )
                if self._candidate_key(wave_routes, wave_unassigned) < self._candidate_key(current_routes, current_unassigned):
                    current_cost = wave_cost
                    current_routes = copy.deepcopy(wave_routes)
                    current_unassigned = list(wave_unassigned)
                    used_diversified_start = True

        if (
            not should_skip_heavy_starts
            and not current_unassigned
            and len(depot_profiles) == 1
            and len(vehicle_profiles) > 1
            and (
                initial_active_route_count < 8
                or (len(self.vehicles) <= 16 and len(vehicle_profiles) <= 3)
            )
            and self.time_limit_sec >= 2.0
            and time.perf_counter() < init_deadline
        ):
            warm_deadline = min(
                init_deadline,
                time.perf_counter() + max(0.0, init_deadline - time.perf_counter()),
            )
            warm_routes, warm_unassigned = self._sequential_construction(
                [order.id for order in self.orders],
                warm_deadline,
            )
            if not warm_unassigned:
                warm_cost = self._plan_cost(warm_routes, warm_unassigned)
                elite_candidates.append(
                    (warm_cost, copy.deepcopy(warm_routes), [])
                )
                for _ in range(3):
                    if time.perf_counter() >= warm_deadline:
                        break
                    relocated_warm = self._best_relocation(
                        warm_routes,
                        warm_unassigned,
                        warm_deadline,
                        sample_limit=len(self.orders),
                    )
                    if relocated_warm is None or relocated_warm[0] >= warm_cost:
                        break
                    warm_cost, warm_routes, warm_unassigned = relocated_warm
                    elite_candidates.append(
                        (warm_cost, copy.deepcopy(warm_routes), [])
                    )
                if self._candidate_key(warm_routes, warm_unassigned) < self._candidate_key(current_routes, current_unassigned):
                    if (
                        sum(bool(r) for r in warm_routes) <= 2
                        and initial_active_route_count >= 4
                    ):
                        self._eliminate_routes(
                            routes,
                            min(
                                deadline,
                                time.perf_counter()
                                + min(1.8, self.time_limit_sec * 0.30),
                            ),
                        )
                        for path_routes in self._last_elimination_path[1:]:
                            path_cost = self._plan_cost(path_routes, [])
                            elite_candidates.append(
                                (path_cost, copy.deepcopy(path_routes), [])
                            )
                    current_routes = copy.deepcopy(warm_routes)
                    current_unassigned = []
                    current_cost = warm_cost

        active_route_count = sum(bool(route) for route in current_routes)
        has_multi_day = any(v.service_day_index > 0 for v in self.vehicles)
        if (
            not should_skip_heavy_starts
            and not current_unassigned
            and len(self.orders) >= 10
            and len(depot_profiles) > 1
            and active_route_count >= 2
            and self.time_limit_sec >= 2.0
            and time.perf_counter() < init_deadline
        ):
            md_cap = 4.5 if has_multi_day else 3.5
            md_frac = 0.85 if has_multi_day else 0.75
            multi_depot_deadline = min(
                init_deadline,
                time.perf_counter()
                + min(
                    md_cap,
                    max(0.0, init_deadline - time.perf_counter()) * md_frac,
                ),
            )
            multi_depot = self._build_multi_depot_start(
                multi_depot_deadline
            )
            for md_cand in getattr(self, "_last_multi_depot_candidates", []):
                elite_candidates.append(
                    (
                        md_cand[0],
                        copy.deepcopy(md_cand[1]),
                        list(md_cand[2]),
                    )
                )
            if multi_depot is not None:
                multi_cost, multi_routes, multi_unassigned = multi_depot
                elite_candidates.append(
                    (
                        multi_cost,
                        copy.deepcopy(multi_routes),
                        list(multi_unassigned),
                    )
                )
                if self._candidate_key(multi_routes, multi_unassigned) < self._candidate_key(current_routes, current_unassigned):
                    current_cost = multi_cost
                    current_routes = copy.deepcopy(multi_routes)
                    current_unassigned = list(multi_unassigned)
                    used_diversified_start = True
                if sum(bool(r) for r in multi_routes) >= 3 and time.perf_counter() < init_deadline:
                    elim_md = self._eliminate_routes(multi_routes, init_deadline)
                    cost_md = self._plan_cost(elim_md, multi_unassigned)
                    if self._candidate_key(elim_md, multi_unassigned) < self._candidate_key(current_routes, current_unassigned):
                        current_cost = cost_md
                        current_routes = copy.deepcopy(elim_md)
                        current_unassigned = list(multi_unassigned)
                        elite_candidates.append((current_cost, copy.deepcopy(current_routes), list(current_unassigned)))

        active_route_count = sum(bool(route) for route in current_routes)
        if (
            not should_skip_heavy_starts
            and not current_unassigned
            and len(self.orders) >= 10
            and len(depot_profiles) == 1
            and active_route_count >= 2
            and self.time_limit_sec >= 2.0
            and time.perf_counter() < init_deadline
        ):
            if (
                len(depot_profiles) == 1
                and len(vehicle_profiles) == 1
                and self.time_limit_sec >= 20.0
            ):
                diversified_cap = 8.0
                diversified_frac = 0.60
            elif (
                len(depot_profiles) == 1
                and len(vehicle_profiles) == 1
                and active_route_count >= 5
            ):
                diversified_cap = 1.2
                diversified_frac = 0.35
            elif len(self.orders) >= 25:
                diversified_cap = 1.5
                diversified_frac = 0.30
            else:
                diversified_cap = 3.5
                diversified_frac = 0.60
            diversified_deadline = min(
                init_deadline,
                time.perf_counter()
                + min(diversified_cap, max(0.0, init_deadline - time.perf_counter()) * diversified_frac),
            )
            diversified = self._build_diversified_start(diversified_deadline)
            for div_cand in self._last_diversified_candidates:
                elite_candidates.append(
                    (
                        div_cand[0],
                        copy.deepcopy(div_cand[1]),
                        list(div_cand[2]),
                    )
                )
            if diversified is not None:
                diversified_cost, diversified_routes, diversified_unassigned = diversified
                elite_candidates.append(
                    (
                        diversified_cost,
                        copy.deepcopy(diversified_routes),
                        list(diversified_unassigned),
                    )
                )
                if self._candidate_key(diversified_routes, diversified_unassigned) < self._candidate_key(current_routes, current_unassigned):
                    current_cost = diversified_cost
                    current_routes = copy.deepcopy(diversified_routes)
                    current_unassigned = list(diversified_unassigned)
                    used_diversified_start = True

        # Với nghiệm chưa đủ đơn, ưu tiên dựng lại khả thi. Với nghiệm đầy đủ
        # nhưng còn nhiều tuyến, dành một phần budget cho gom tuyến có định hướng.
        if current_unassigned:
            struct_deadline = min(
                deadline,
                started_at + min(0.6, self.time_limit_sec * 0.15),
            )
            struct_candidates = self._construct_structured_solutions(struct_deadline)
            if struct_candidates:
                best_struct_cost, best_struct_routes, best_struct_unassigned = struct_candidates[0]
                if self._candidate_key(best_struct_routes, best_struct_unassigned) < self._candidate_key(current_routes, current_unassigned):
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
            if self._candidate_key(elim_routes, current_unassigned) < self._candidate_key(current_routes, current_unassigned):
                current_routes = copy.deepcopy(elim_routes)
                current_cost = elim_cost
                elite_candidates.append(
                    (current_cost, copy.deepcopy(current_routes), list(current_unassigned))
                )
        elif sum(bool(route) for route in current_routes) >= 2:
            consolidation_remaining = max(
                0.0,
                deadline - time.perf_counter(),
            )
            if (
                len(depot_profiles) == 1
                and len(vehicle_profiles) > 1
                and self.time_limit_sec >= 20.0
            ):
                consolidation_cap = 8.0
                consolidation_fraction = 0.45
            elif (
                len(depot_profiles) == 1
                and len(vehicle_profiles) == 1
                and (
                    sum(bool(route) for route in current_routes) >= 5
                    or (initial_active_route_count >= 8 and self.time_limit_sec >= 10.0)
                )
            ):
                consolidation_cap = 6.0
                consolidation_fraction = 0.85
            elif (len(depot_profiles) > 1 or len(self.orders) >= 25) and self.time_limit_sec >= 2.0:
                consolidation_cap = 5.0
                consolidation_fraction = 0.85
            else:
                consolidation_cap = 4.0
                consolidation_fraction = 0.45
            consolidation_deadline = min(
                elim_deadline,
                time.perf_counter()
                + min(
                    consolidation_cap,
                    max(0.0, elim_deadline - time.perf_counter()),
                ),
            )
            # Gom tuyến cho các ứng viên Đa kho nếu có (đặc biệt hiệu quả cho hub-spoke)
            last_md = getattr(self, "_last_multi_depot_candidates", [])
            if last_md and time.perf_counter() < consolidation_deadline:
                best_md_cand = min(
                    [c for c in last_md if not c[2] and sum(bool(r) for r in c[1]) >= 3],
                    key=lambda c: self._candidate_key(c[1], c[2]),
                    default=None,
                )
                if best_md_cand is not None:
                    md_elim = self._eliminate_routes(
                        best_md_cand[1],
                        consolidation_deadline,
                    )
                    for path_routes in self._last_elimination_path[1:]:
                        path_cost = self._plan_cost(path_routes, [])
                        elite_candidates.append((path_cost, copy.deepcopy(path_routes), []))
                    md_elim_cost = self._plan_cost(md_elim, [])
                    if self._candidate_key(md_elim, []) < self._candidate_key(current_routes, current_unassigned):
                        current_routes = copy.deepcopy(md_elim)
                        current_unassigned = []
                        current_cost = md_elim_cost
                        elite_candidates.append((current_cost, copy.deepcopy(current_routes), []))

            if (
                not greedy_unassigned
                and greedy_routes != current_routes
                and (
                    (len(depot_profiles) > 1 and not has_multi_day)
                    or len(self.orders) >= 25
                )
            ):
                greedy_consolidated = self._eliminate_routes(
                    greedy_routes,
                    consolidation_deadline,
                )
                for path_routes in self._last_elimination_path[1:]:
                    path_cost = self._plan_cost(path_routes, [])
                    elite_candidates.append(
                        (
                            path_cost,
                            copy.deepcopy(path_routes),
                            [],
                        )
                    )
                greedy_cons_cost = self._plan_cost(greedy_consolidated, [])
                if self._candidate_key(greedy_consolidated, []) < self._candidate_key(current_routes, current_unassigned):
                    current_routes = copy.deepcopy(greedy_consolidated)
                    current_unassigned = []
                    current_cost = greedy_cons_cost
                    elite_candidates.append(
                        (current_cost, copy.deepcopy(current_routes), [])
                    )
            consolidated_routes = self._eliminate_routes(
                current_routes,
                consolidation_deadline,
            )
            for path_routes in self._last_elimination_path[1:]:
                path_cost = self._plan_cost(path_routes, current_unassigned)
                elite_candidates.append(
                    (
                        path_cost,
                        copy.deepcopy(path_routes),
                        list(current_unassigned),
                    )
                )
            consolidated_cost = self._plan_cost(
                consolidated_routes,
                current_unassigned,
            )
            if self._candidate_key(consolidated_routes, current_unassigned) < self._candidate_key(current_routes, current_unassigned):
                current_routes = copy.deepcopy(consolidated_routes)
                current_cost = consolidated_cost
                elite_candidates.append(
                    (current_cost, copy.deepcopy(current_routes), list(current_unassigned))
                )

        # Intensification sớm: relocation có chi phí thấp hơn ruin/recreate đầy đủ
        # và đặc biệt hiệu quả với các case nhỏ hoặc đang dùng thừa xe. Giới hạn
        # phần ngân sách này để vòng ALNS chính vẫn luôn có thời gian chạy.
        intensify_fraction = 0.20 if len(self.orders) <= 8 else 0.0
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

        # The construction phase uses a strong vehicle-count guide to escape
        # Greedy over-allocation. The ALNS phase then optimizes the reported
        # economic objective and may reopen an empty vehicle when that lowers
        # the real total cost.
        if sum(bool(route) for route in current_routes) <= 3:
            self._vehicle_guidance_vnd = 0
            self._allow_empty_insertion_competition = True
            current_cost = self._plan_cost(current_routes, current_unassigned)

            remaining_search_time = max(0.0, deadline - time.perf_counter())
            economic_deadline = min(
                deadline,
                time.perf_counter() + min(3.0, remaining_search_time * 0.5),
            )
            while not current_unassigned and time.perf_counter() < economic_deadline:
                relocated = self._best_relocation(
                    current_routes,
                    current_unassigned,
                    economic_deadline,
                    sample_limit=min(16, len(self.orders)),
                )
                if relocated is None:
                    break
                current_cost, current_routes, current_unassigned = relocated
                elite_candidates.append(
                    (current_cost, copy.deepcopy(current_routes), list(current_unassigned))
                )

            if self.time_limit_sec >= 10.0 or len(depot_profiles) > 1:
                split_remaining = max(0.0, deadline - time.perf_counter())
                split_deadline = min(
                    deadline,
                    time.perf_counter() + min(2.0, split_remaining * 0.4),
                )
                split_candidate = self._best_route_split(
                    current_routes,
                    current_unassigned,
                    split_deadline,
                )
                if split_candidate is not None:
                    split_cost, split_routes, split_unassigned = split_candidate
                    for candidate_cost, candidate_routes, candidate_unassigned in (
                        self._last_split_candidates[:8]
                    ):
                        elite_candidates.append(
                            (
                                candidate_cost,
                                copy.deepcopy(candidate_routes),
                                list(candidate_unassigned),
                            )
                        )
                    if split_cost < current_cost:
                        current_cost = split_cost
                        current_routes = copy.deepcopy(split_routes)
                        current_unassigned = list(split_unassigned)

        fallback_compact_routes = copy.deepcopy(current_routes)
        fallback_compact_unassigned = list(current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        best_nonempty = sum(1 for r in best_routes if r)
        temperature = max(1.0, current_cost * 0.02)
        iteration = 0
        last_improved_iteration = 0
        refine_reserve_sec = max(0.35, min(1.5, self.time_limit_sec * 0.25))
        alns_deadline = max(time.perf_counter(), deadline - refine_reserve_sec)

        while iteration < self.max_iterations and (iteration == 0 or time.perf_counter() < alns_deadline):
            iteration += 1
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break

            # Local search is substantially more expensive than one ALNS move;
            # allow enough ruin/recreate diversity before intensifying.
            if iteration - last_improved_iteration >= 8:
                relocated = self._best_relocation(best_routes, best_unassigned, alns_deadline, sample_limit=6)
                if relocated is not None and self._candidate_key(relocated[1], relocated[2]) < self._candidate_key(best_routes, best_unassigned):
                    best_cost, best_routes, best_unassigned = relocated
                    current_cost, current_routes, current_unassigned = relocated
                    best_nonempty = sum(1 for r in best_routes if r)
                    if len(best_unassigned) == 0:
                        elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                    last_improved_iteration = iteration
                    continue

                elim_routes = self._eliminate_routes(best_routes, alns_deadline)
                cand_cost = self._plan_cost(elim_routes, best_unassigned)
                if self._candidate_key(elim_routes, best_unassigned) < self._candidate_key(best_routes, best_unassigned):
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
                if best_nonempty <= 1:
                    destroy_name = self.rng.choice(["related", "string", "worst", "cluster"])
                else:
                    destroy_name = self.rng.choice(["route", "small", "cluster"])
                last_improved_iteration = iteration
            else:
                destroy_name = self._weighted_choice(self.destroy_weights)
                if best_nonempty <= 1 and destroy_name in ("route", "small"):
                    destroy_name = self.rng.choice(["related", "string", "worst", "random"])

            if best_nonempty <= 1:
                max_rem = min(3, max(1, int(assigned_count * 0.18)))
            elif iteration - last_improved_iteration >= 12:
                max_rem = min(8, max(3, int(assigned_count * 0.45)))
            else:
                max_rem = min(6, max(2, int(assigned_count * 0.35)))
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
                alns_deadline,
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
                    if len(self._route_pool) < 800:
                        for v_i, r_stops in enumerate(candidate_routes):
                            if r_stops:
                                self._route_pool.append((v_i, copy.deepcopy(r_stops)))
                if cand_nonempty < best_nonempty and len(candidate_unassigned) == 0:
                    score = 10.0

                if self._candidate_key(candidate_routes, candidate_unassigned) < self._candidate_key(best_routes, best_unassigned):
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

        # 1. CP-SAT Set Partitioning over Route Pool to recombine optimal routes
        if len(elite_candidates) >= 2:
            sp_time_limit = min(0.4, max(0.15, self.time_limit_sec * 0.12))
            if self.post_audit_reserve_sec:
                sp_time_limit = min(sp_time_limit, max(0.0, deadline - time.perf_counter()))
            sp_result = (self._solve_set_partitioning(elite_candidates, time_limit_sec=sp_time_limit)
                if sp_time_limit > 0 else None)
            if sp_result is not None:
                sp_cost, sp_routes, sp_unassigned = sp_result
                if len(sp_unassigned) == 0:
                    elite_candidates.insert(0, (sp_cost, sp_routes, sp_unassigned))
                    if self._candidate_key(sp_routes, sp_unassigned) < self._candidate_key(best_routes, best_unassigned):
                        best_cost = sp_cost
                        best_routes = copy.deepcopy(sp_routes)
                        best_unassigned = list(sp_unassigned)

        # 2. Pha tinh chỉnh kinh tế bảo toàn số chuyến và chất lượng gom đơn
        refine_deadline = (deadline if self.post_audit_reserve_sec else
            max(deadline, time.perf_counter() + 0.20))
        while time.perf_counter() < refine_deadline:
            improved_in_round = False
            active_vehicles_now = [idx for idx, r in enumerate(best_routes) if r]

            # Give cheap stop moves a bounded share before pair reinsertion.
            stop_deadline = min(refine_deadline, time.perf_counter() + max(0.01, (refine_deadline - time.perf_counter()) * 0.5))
            while time.perf_counter() < stop_deadline:
                moved = self._first_improving_stop_relocation(best_routes, best_unassigned, stop_deadline)
                if moved is None:
                    break
                best_cost, best_routes, best_unassigned = moved
                elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                improved_in_round = True

            # 2.1 Intra-route relocation for active routes (includes Adjacent Stop Swap & Pair Reinsertion)
            if active_vehicles_now and time.perf_counter() < refine_deadline:
                refined_intra = self._best_intra_route_relocation(
                    best_routes, best_unassigned, active_vehicles_now, refine_deadline
                )
                if refined_intra is not None and self._candidate_key(refined_intra[1], refined_intra[2]) < self._candidate_key(best_routes, best_unassigned):
                    best_cost, best_routes, best_unassigned = refined_intra
                    elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                    improved_in_round = True

            # 2.2 Best relocation
            if time.perf_counter() < refine_deadline:
                relocated = self._best_relocation(
                    best_routes, best_unassigned, refine_deadline, sample_limit=min(20, len(self.orders))
                )
                if relocated is not None and self._candidate_key(relocated[1], relocated[2]) < self._candidate_key(best_routes, best_unassigned):
                    best_cost, best_routes, best_unassigned = relocated
                    elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                    improved_in_round = True

            # 2.3 Best order exchange + intra-route
            if len(active_vehicles_now) > 1 and time.perf_counter() < refine_deadline:
                exchanged = self._best_order_exchange(best_routes, best_unassigned, refine_deadline)
                if exchanged is not None:
                    ex_cost, ex_routes, ex_unassigned, aff = exchanged
                    ref = self._best_intra_route_relocation(ex_routes, ex_unassigned, aff, refine_deadline)
                    if ref is not None and self._candidate_key(ref[1], ref[2]) < self._candidate_key(ex_routes, ex_unassigned):
                        ex_cost, ex_routes, ex_unassigned = ref
                    if self._candidate_key(ex_routes, ex_unassigned) < self._candidate_key(best_routes, best_unassigned):
                        best_cost, best_routes, best_unassigned = ex_cost, ex_routes, ex_unassigned
                        elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                        improved_in_round = True

            # 2.4 Best vehicle reassignment
            if time.perf_counter() < refine_deadline:
                reassigned = self._best_vehicle_reassignment(best_routes, best_unassigned, refine_deadline)
                if reassigned is not None and self._candidate_key(reassigned[1], reassigned[2]) < self._candidate_key(best_routes, best_unassigned):
                    best_cost, best_routes, best_unassigned = reassigned
                    elite_candidates.append((best_cost, copy.deepcopy(best_routes), list(best_unassigned)))
                    improved_in_round = True

            if not improved_in_round:
                break

        # Lọc các ứng viên duy nhất trong elite candidates đã giao đủ 100% đơn
        unique_candidates: List[Tuple[int, List[List[ScheduledStop]], List[str]]] = []
        seen_signatures = set()
        for cand in sorted(
            elite_candidates,
            key=lambda candidate: self._candidate_key(candidate[1], candidate[2]),
        ):
            if len(cand[2]) > 0:
                continue
            sig = tuple(self._route_key(r) for r in cand[1])
            if sig in seen_signatures:
                continue
            seen_signatures.add(sig)
            unique_candidates.append(cand)

        # Preserve route-count diversity in the bounded spatial audit. A cheap
        # but geometrically invalid compact basin must not crowd every safer
        # intermediate consolidation state out of the six audit slots.
        greedy_signature = tuple(self._route_key(route) for route in greedy_routes)
        greedy_fallback = next((candidate for candidate in unique_candidates
            if tuple(self._route_key(route) for route in candidate[1]) == greedy_signature), None)
        audit_candidates = self._select_audit_candidates(unique_candidates, fallback=greedy_fallback)

        # Repair can turn a cheap fast-check candidate into a materially more
        # expensive valid plan. Audit the bounded elite set and compare the
        # post-repair economic costs instead of returning the first valid row.
        valid_elite_solutions: List[OptimizationSolution] = []
        for rank, (_, cand_routes, cand_unassigned) in enumerate(audit_candidates, start=1):
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
                valid_elite_solutions.append(solution)

        if valid_elite_solutions:
            best_valid_solution = min(
                valid_elite_solutions,
                key=lambda solution: solution_key(solution, self.orders),
            )
            should_refine_pairwise = bool(
                self.time_limit_sec >= 20.0
                and len(depot_profiles) == 1
                and len(vehicle_profiles) > 1
                and len(self.orders) <= 20
                and 1 < len(best_valid_solution.routes) <= 5
            )
            if should_refine_pairwise:
                vehicle_index = {
                    vehicle.id: index
                    for index, vehicle in enumerate(self.vehicles)
                }
                audited_routes: List[List[ScheduledStop]] = [
                    [] for _vehicle in self.vehicles
                ]
                for route in best_valid_solution.routes:
                    audited_routes[vehicle_index[route.vehicle.id]] = (
                        copy.deepcopy(route.stops)
                    )
                refinement_deadline = time.perf_counter() + min(
                    8.0,
                    self.final_repair_time_limit_sec,
                )
                refined_routes = self._refine_pairwise_empty_cycles(
                    audited_routes,
                    refinement_deadline,
                )
                if self._economic_plan_cost(refined_routes, []) < (
                    best_valid_solution.real_economic_cost_vnd
                ):
                    refined_solution = self._build_solution(
                        refined_routes,
                        [],
                        f"{best_valid_solution.solver_name} + pairwise refinement",
                    )
                    repair_and_audit_solution(
                        refined_solution,
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
                    refined_valid = bool(
                        refined_solution.solution_audited
                        and refined_solution.is_contract_valid
                        and refined_solution.is_temporally_valid
                        and refined_solution.is_spatial_valid
                        and refined_solution.fulfillment_rate >= 99.9
                    )
                    if (
                        refined_valid
                        and refined_solution.real_economic_cost_vnd
                        < best_valid_solution.real_economic_cost_vnd
                    ):
                        best_valid_solution = refined_solution
            best_valid_solution.execution_time_sec = round(
                time.perf_counter() - started_at, 3
            )
            # The audit portfolio is already bounded. The production caller
            # prices calendar salary/lateness, which this lightweight model
            # does not know; do not truncate audited alternatives by its cost.
            setattr(best_valid_solution, "_candidate_solutions", valid_elite_solutions)
            return best_valid_solution

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
            fallback = copy.deepcopy(sol_gr)
            if not fallback.solution_audited:
                repair_and_audit_solution(
                    fallback,
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
            sol_gr_valid = bool(
                fallback.solution_audited
                and fallback.is_contract_valid
                and fallback.is_temporally_valid
                and fallback.is_spatial_valid
                and fallback.fulfillment_rate >= 99.9
            )
            if sol_gr_valid:
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
    max_iterations: int = 500,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 2.0,
    final_repair_time_limit_sec: float = 3.0,
    initial_solution: Optional[OptimizationSolution] = None,
    operator_weights_out: Optional[Dict[str, Dict[str, float]]] = None,
    search_profile: str = "historical_portfolio",
    post_audit_reserve_sec: float = 0.0,
) -> OptimizationSolution:
    if time_limit_sec <= 0:
        raise ValueError("time_limit_sec must be greater than zero")
    if post_audit_reserve_sec < 0 or post_audit_reserve_sec >= time_limit_sec:
        raise ValueError("post_audit_reserve_sec must be nonnegative and smaller than time_limit_sec")
    if search_profile == "algo_lab_legacy_v1" and post_audit_reserve_sec:
        raise ValueError("The legacy profile does not support a post-audit search reserve")
    if search_profile not in {
        "historical_portfolio",
        "algo_lab_legacy_v1",
        "evolved",
    }:
        raise ValueError(
            "search_profile must be 'historical_portfolio', "
            "'algo_lab_legacy_v1' or 'evolved'"
        )

    hybrid_initial = initial_solution
    if search_profile in {"historical_portfolio", "algo_lab_legacy_v1"}:
        # The lab benchmark built this shared seed before timing each search.
        # Preserve that experiment contract so ALNS does not lose its entire
        # search budget to deterministic packing construction on dense cases.
        hybrid_initial = hybrid_initial or solve_greedy(
            vehicles,
            drivers,
            orders,
            policy,
            distance_matrix,
            duration_matrix,
            node_id_to_index,
        )

    if search_profile == "historical_portfolio":
        depot_profiles = {
            (
                round(vehicle.depot.latitude, 6),
                round(vehicle.depot.longitude, 6),
                round((vehicle.end_depot or vehicle.depot).latitude, 6),
                round((vehicle.end_depot or vehicle.depot).longitude, 6),
            )
            for vehicle in vehicles
        }
        vehicle_profiles = {
            (
                vehicle.length_cm,
                vehicle.width_cm,
                vehicle.height_cm,
                vehicle.payload_limit_kg,
                vehicle.fixed_operating_cost_vnd,
            )
            for vehicle in vehicles
        }
        cargo_item_count = sum(len(order.items) for order in orders)
        dense_cargo_seed = bool(
            time_limit_sec >= 30.0
            and orders
            and cargo_item_count >= len(orders) * 10
            and len(vehicle_profiles) == 1
        )
        compact_trap_seed = bool(
            time_limit_sec >= 20.0
            and len(depot_profiles) == 1
            and len(vehicle_profiles) == 1
            and 4 <= len(hybrid_initial.routes) <= 5
        )
        single_depot = len(depot_profiles) == 1
        search_profile = "evolved" 

    if search_profile == "algo_lab_legacy_v1":
        legacy_solver = LegacyHybridALNSSolver(
            vehicles,
            drivers,
            orders,
            policy,
            distance_matrix,
            duration_matrix,
            node_id_to_index,
            time_limit_sec=time_limit_sec,
            max_iterations=max_iterations,
            random_seed=random_seed,
            final_spatial_time_limit_sec=final_spatial_time_limit_sec,
            final_repair_time_limit_sec=final_repair_time_limit_sec,
            initial_solution=hybrid_initial,
        )
        solution = legacy_solver.solve()
        if operator_weights_out is not None:
            operator_weights_out["destroy"] = dict(legacy_solver.destroy_weights)
            operator_weights_out["repair"] = dict(legacy_solver.repair_weights)
        return solution

    started_at = time.perf_counter()
    hybrid_initial = hybrid_initial or solve_greedy(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
    )
    alns_budget = time_limit_sec
    best_seed_solution: Optional[OptimizationSolution] = None

    depot_profiles = {
        (
            round(vehicle.depot.latitude, 6),
            round(vehicle.depot.longitude, 6),
            round((vehicle.end_depot or vehicle.depot).latitude, 6),
            round((vehicle.end_depot or vehicle.depot).longitude, 6),
        )
        for vehicle in vehicles
    }
    vehicle_profiles = {
        (
            vehicle.length_cm,
            vehicle.width_cm,
            vehicle.height_cm,
            vehicle.payload_limit_kg,
            vehicle.fixed_operating_cost_vnd,
        )
        for vehicle in vehicles
    }
    cargo_item_count = sum(len(order.items) for order in orders)
    dense_cargo_seed = bool(
        time_limit_sec >= 30.0
        and orders
        and cargo_item_count >= len(orders) * 10
        and len(vehicle_profiles) == 1
    )
    compact_trap_seed = bool(
        time_limit_sec >= 20.0
        and len(depot_profiles) == 1
        and len(vehicle_profiles) == 1
        and 4 <= len(hybrid_initial.routes) <= 6
    )
    use_sa_seed = dense_cargo_seed or compact_trap_seed
    if use_sa_seed:
        # Dense multi-item cargo and compact homogeneous starts can trap
        # destroy/repair in spatially difficult basins. The historical
        # specialist-30 profile gave dense cargo 30-40% of the budget, while
        # specialist-95 gave compact route-consolidation one long deterministic
        # SA stream. Use the diversified ``seed + 4`` stream from the original
        # portfolio: splitting it into short restarts made the result depend
        # heavily on packing/audit wall-clock overhead.
        from .advanced_metaheuristics import (
            solve_simulated_annealing,
        )

        if dense_cargo_seed:
            seed_runs = [
                (random_seed, min(12.0, time_limit_sec * 0.40)),
            ]
        else:
            seed_runs = [
                (random_seed + 4, time_limit_sec * 0.95),
            ]

        valid_seed_solutions: List[OptimizationSolution] = []
        construction_fraction = 0.30 if dense_cargo_seed else 0.95
        for seed, seed_budget in seed_runs:
            seed_solution = solve_simulated_annealing(
                vehicles,
                drivers,
                orders,
                policy,
                distance_matrix,
                duration_matrix,
                node_id_to_index,
                time_limit_sec=seed_budget,
                random_seed=seed,
                final_spatial_time_limit_sec=final_spatial_time_limit_sec,
                final_repair_time_limit_sec=final_repair_time_limit_sec,
                initial_solution=hybrid_initial,
                construction_fraction=construction_fraction,
            )
            if (
                seed_solution.solution_audited
                and seed_solution.is_contract_valid
                and seed_solution.is_temporally_valid
                and seed_solution.is_spatial_valid
                and seed_solution.fulfillment_rate >= 99.9
                and not seed_solution.unassigned_orders
                and solution_key(seed_solution, orders) < solution_key(hybrid_initial, orders)
            ):
                valid_seed_solutions.append(seed_solution)
        if valid_seed_solutions:
            best_seed_solution = min(
                valid_seed_solutions,
                key=lambda candidate: solution_key(candidate, orders),
            )
            hybrid_initial = best_seed_solution
        alns_budget = time_limit_sec - sum(
            budget for _seed, budget in seed_runs
        )

    alns_solver = HybridALNSSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=alns_budget,
        max_iterations=max_iterations,
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
        final_repair_time_limit_sec=final_repair_time_limit_sec,
        initial_solution=hybrid_initial,
        post_audit_reserve_sec=post_audit_reserve_sec,
    )
    solution = alns_solver.solve()
    if operator_weights_out is not None:
        operator_weights_out["destroy"] = dict(alns_solver.destroy_weights)
        operator_weights_out["repair"] = dict(alns_solver.repair_weights)
    if (
        best_seed_solution is not None
        and solution_key(best_seed_solution, orders) < solution_key(solution, orders)
    ):
        solution = copy.deepcopy(best_seed_solution)
    if use_sa_seed:
        solution.solver_name = (
            f"Hybrid adaptive SA seed | {solution.solver_name}"
        )
        solution.random_seed = random_seed
        solution.execution_time_sec = round(time.perf_counter() - started_at, 3)
    return solution
