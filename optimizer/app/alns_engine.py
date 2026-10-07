"""Adaptive Large Neighborhood Search (ALNS) Core Optimizer for Fleet Routing.

Production-grade optimizer integrating:
1. Dynamic 2D Non-stackable Packing & LIFO Door Clearance (T21-T27 compliant).
2. Intelligent Vehicle Selection & Fleet Sizing (Consolidates orders into larger vehicles when cost-effective).
3. Driver-to-Vehicle Wage Optimization via Hungarian Matching (O(V^3) < 1ms).
4. Multi-day and Vehicle-restriction awareness (service_day_index, allowed_source_vehicle_ids).
5. Full contract compliance with FleetOptimizationResponse, RouteCostBreakdown, SpatialValidationResult, and BenchmarkComparisonResponse.
"""

import copy
import math
import random
import time
from typing import Dict, List, Optional, Set, Tuple

from .baseline_calculator import BaselineCostCalculator
from .driver_matcher import DriverMatcher
from .models import (
    BenchmarkComparisonResponse,
    BenchmarkMetric,
    CargoItem,
    FloorState,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    PackageAccessPath,
    PlacedItem,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    UnassignedOrder,
    can_driver_drive_vehicle,
)
from .route_costing import calculate_driver_cost, calculate_route_economic_metrics
from .spatial_validator import SpatialValidator


class FastLIFOPackingChecker:
    """Microsecond-fast non-stackable 2D floor packing with LIFO door clearance check."""

    def __init__(self, vehicle: FleetVehicle):
        self.vehicle = vehicle
        self.bed_l = vehicle.length_cm
        self.bed_w = vehicle.width_cm
        self.bed_area = self.bed_l * self.bed_w
        self.payload = vehicle.payload_limit_kg

    def validate_route_stops(
        self,
        candidate_stops: List[ScheduledStop],
        cargo_by_id: Dict[str, CargoItem],
    ) -> Tuple[bool, str]:
        placed_boxes: List[Dict] = []
        onboard_weight = 0.0

        for stop in candidate_stops:
            if stop.stop_type == "PICKUP":
                for item_id in stop.items_loaded:
                    item = cargo_by_id.get(item_id)
                    if not item:
                        continue
                    onboard_weight += item.weight_kg
                    if onboard_weight > self.payload + 0.01:
                        return False, "Vượt tải trọng xe"

                    placed = self._place_box(item, placed_boxes)
                    if placed is None:
                        return False, "Không đủ diện tích sàn hoặc bị kẹt góc"
                    placed_boxes.append(placed)

            elif stop.stop_type == "DELIVERY":
                for item_id in stop.items_unloaded:
                    target_box = next((b for b in placed_boxes if b["id"] == item_id), None)
                    if not target_box:
                        continue

                    # LIFO door clearance: Check if path from rear door (x = bed_l) to target box is blocked
                    for other in placed_boxes:
                        if other["id"] == target_box["id"]:
                            continue
                        if other["x"] > target_box["x"] + 0.01:
                            if not (other["y"] + other["w"] <= target_box["y"] + 0.01 or other["y"] >= target_box["y"] + target_box["w"] - 0.01):
                                return False, "Bị hàng dỡ sau chặn lối ra cửa đuôi"

                    placed_boxes = [b for b in placed_boxes if b["id"] != item_id]
                    item = cargo_by_id.get(item_id)
                    if item:
                        onboard_weight = max(0.0, onboard_weight - item.weight_kg)

        return True, "Hợp lệ"

    def _place_box(self, item: CargoItem, placed_boxes: List[Dict]) -> Optional[Dict]:
        total_used_area = sum(b["l"] * b["w"] for b in placed_boxes)
        box_area = item.length_cm * item.width_cm
        if total_used_area + box_area > self.bed_area + 0.01:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if item.can_rotate and abs(item.length_cm - item.width_cm) > 0.1:
            orientations.append((item.width_cm, item.length_cm))

        candidate_positions = [(0.0, 0.0)]
        for b in placed_boxes:
            candidate_positions.append((b["x"] + b["l"], b["y"]))
            candidate_positions.append((b["x"], b["y"] + b["w"]))

        candidate_positions.sort(key=lambda p: (p[0], p[1]))

        for l_dim, w_dim in orientations:
            if l_dim > self.bed_l or w_dim > self.bed_w:
                continue

            for x_cand, y_cand in candidate_positions:
                if x_cand + l_dim <= self.bed_l + 0.01 and y_cand + w_dim <= self.bed_w + 0.01:
                    overlap = False
                    for other in placed_boxes:
                        if not (
                            x_cand + l_dim <= other["x"] + 0.01
                            or x_cand >= other["x"] + other["l"] - 0.01
                            or y_cand + w_dim <= other["y"] + 0.01
                            or y_cand >= other["y"] + other["w"] - 0.01
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


class ALNSFleetOptimizer:
    """Production ALNS Fleet Routing Optimizer with LIFO Door Clearance & Driver Matching."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        max_iterations: int = 150,
        time_budget_seconds: Optional[float] = None,
        random_seed: int = 0,
    ):
        self.request = request
        self.vehicles = request.vehicles
        self.drivers = request.drivers
        self.orders = request.orders
        self.policy = request.policy

        self.max_iterations = max_iterations
        self.time_limit_sec = time_budget_seconds or min(request.max_time_seconds, 15.0)
        self.random_seed = random_seed
        self.rng = random.Random(random_seed)

        self.order_by_id = {o.id: o for o in self.orders}
        self.cargo_by_id = {it.id: it for o in self.orders for it in o.items}
        self.vehicle_by_id = {v.id: v for v in self.vehicles}
        self.order_node_indices = {
            order.id: (len(self.vehicles) + 2 * index, len(self.vehicles) + 2 * index + 1)
            for index, order in enumerate(self.orders)
        }

        self.checkers = [FastLIFOPackingChecker(v) for v in self.vehicles]
        self._packing_cache: Dict[Tuple[str, Tuple[Tuple[str, str], ...]], bool] = {}

    def _stop_node_index(self, stop: ScheduledStop) -> Optional[int]:
        """Resolve a stop to its exact matrix node, even when locations repeat."""
        allocation_id = stop.allocation_id or stop.order_id
        indices = self.order_node_indices.get(allocation_id or "")
        if indices is None:
            return None
        return indices[0] if stop.stop_type == "PICKUP" else indices[1]

    def _schedule_stops(
        self, v_idx: int, stops: List[ScheduledStop]
    ) -> Optional[Tuple[List[ScheduledStop], int, int]]:
        """Apply travel, waiting and service time and enforce every time window."""
        vehicle = self.vehicles[v_idx]
        current_time = float(vehicle.available_start_sec)
        previous_index = v_idx
        scheduled: List[ScheduledStop] = []

        for sequence, stop in enumerate(stops, start=1):
            node_index = self._stop_node_index(stop)
            allocation_id = stop.allocation_id or stop.order_id
            order = self.order_by_id.get(allocation_id or "")
            if node_index is None or order is None:
                return None

            travel_time = float(
                self.request.duration_matrix_seconds[previous_index][node_index]
            )
            leg_start = current_time
            current_time += travel_time
            window_start = (
                order.pickup_window_start_sec
                if stop.stop_type == "PICKUP"
                else order.delivery_window_start_sec
            )
            window_end = (
                order.pickup_window_end_sec
                if stop.stop_type == "PICKUP"
                else order.delivery_window_end_sec
            )
            current_time = max(current_time, float(window_start))
            if current_time > window_end or current_time > vehicle.available_end_sec:
                return None

            arrival = round(current_time)
            travel_seconds = max(0, round(travel_time))
            waiting_seconds = max(0, arrival - round(leg_start) - travel_seconds)
            departure = arrival + order.service_time_sec
            if departure > vehicle.available_end_sec:
                return None

            scheduled.append(
                stop.model_copy(
                    update={
                        "sequence": sequence,
                        "arrival_time_sec": arrival,
                        "departure_time_sec": departure,
                        "travel_time_sec": travel_seconds,
                        "waiting_time_sec": waiting_seconds,
                        "service_time_sec": order.service_time_sec,
                    }
                )
            )
            current_time = float(departure)
            previous_index = node_index

        return_travel = round(
            self.request.duration_matrix_seconds[previous_index][v_idx]
        )
        route_end = round(current_time) + return_travel
        if route_end > vehicle.available_end_sec:
            return None
        return scheduled, route_end, return_travel

    def _validate_stops_cached(self, v_idx: int, cand_stops: List[ScheduledStop]) -> bool:
        v = self.vehicles[v_idx]
        cache_key = (
            v.id,
            tuple((st.order_id, st.stop_type) for st in cand_stops if st.order_id),
        )
        if cache_key in self._packing_cache:
            return self._packing_cache[cache_key]

        valid, _ = self.checkers[v_idx].validate_route_stops(cand_stops, self.cargo_by_id)
        self._packing_cache[cache_key] = valid
        return valid

    def _calc_route_distance_km(self, v_idx: int, stops: List[ScheduledStop]) -> float:
        if not stops:
            return 0.0
        v = self.vehicles[v_idx]
        depot_idx = v_idx
        total_meters = 0.0
        prev = depot_idx
        for st in stops:
            cur = self._stop_node_index(st)
            if cur is None:
                return float("inf")
            if prev < len(self.request.distance_matrix_meters) and cur < len(self.request.distance_matrix_meters[prev]):
                total_meters += self.request.distance_matrix_meters[prev][cur]
            prev = cur
        if prev < len(self.request.distance_matrix_meters) and depot_idx < len(self.request.distance_matrix_meters[prev]):
            total_meters += self.request.distance_matrix_meters[prev][depot_idx]
        return total_meters / 1000.0

    def _evaluate_plan_cost(
        self, routes_stops: List[List[ScheduledStop]], unassigned_ids: List[str]
    ) -> Tuple[int, int, float]:
        total_economic = 0
        total_km = 0.0

        for v_idx, stops in enumerate(routes_stops):
            if not stops:
                continue
            v = self.vehicles[v_idx]
            dist_km = self._calc_route_distance_km(v_idx, stops)
            total_km += dist_km

            liters = (v.fuel_consumption_liters_per_100_km / 100.0) * dist_km
            fuel_cost = round(liters * self.policy.fuel_price_per_liter_vnd)
            fixed_cost = v.fixed_operating_cost_vnd
            driver_est = 150_000 + round(1_200 * dist_km)

            total_economic += (fuel_cost + fixed_cost + driver_est)

        penalized = (
            total_economic
            + len(unassigned_ids) * self.policy.unassigned_order_penalty_vnd
        )
        return penalized, total_economic, total_km

    def _order_allows_vehicle(self, order: OrderPair, vehicle: FleetVehicle) -> bool:
        """Enforces allowed_source_vehicle_ids constraint."""
        if not order.allowed_source_vehicle_ids:
            return True
        v_phys_id = vehicle.source_vehicle_id or vehicle.id
        return (v_phys_id in order.allowed_source_vehicle_ids) or (vehicle.id in order.allowed_source_vehicle_ids)

    def _vehicle_has_compatible_driver(self, vehicle: FleetVehicle) -> bool:
        vehicle_type = vehicle.vehicle_type or vehicle.model or ""
        return any(
            driver.service_day_index == vehicle.service_day_index
            and can_driver_drive_vehicle(
                driver.license_class, vehicle.payload_limit_kg, vehicle_type
            )
            for driver in self.drivers
        )

    def _can_insert_order(
        self,
        v_idx: int,
        current_stops: List[ScheduledStop],
        order: OrderPair,
        p_pos: int,
        d_pos: int,
    ) -> Tuple[bool, List[ScheduledStop]]:
        v = self.vehicles[v_idx]

        # Check vehicle restriction
        if not self._order_allows_vehicle(order, v):
            return False, []
        if not self._vehicle_has_compatible_driver(v):
            return False, []

        p_stop = ScheduledStop(
            sequence=0,
            stop_type="PICKUP",
            location_id=order.pickup_location.id,
            location_name=order.pickup_location.name,
            order_id=order.id,
            allocation_id=order.id,
            latitude=order.pickup_location.latitude,
            longitude=order.pickup_location.longitude,
            arrival_time_sec=0,
            departure_time_sec=0,
            service_time_sec=order.service_time_sec,
            items_loaded=[it.id for it in order.items],
            items_unloaded=[],
        )
        d_stop = ScheduledStop(
            sequence=0,
            stop_type="DELIVERY",
            location_id=order.delivery_location.id,
            location_name=order.delivery_location.name,
            order_id=order.id,
            allocation_id=order.id,
            latitude=order.delivery_location.latitude,
            longitude=order.delivery_location.longitude,
            arrival_time_sec=0,
            departure_time_sec=0,
            service_time_sec=order.service_time_sec,
            items_loaded=[],
            items_unloaded=[it.id for it in order.items],
        )

        cand_stops = (
            current_stops[:p_pos]
            + [p_stop]
            + current_stops[p_pos : d_pos - 1]
            + [d_stop]
            + current_stops[d_pos - 1 :]
        )

        # 1. Capacity check along the route
        w = 0.0
        order_weights = {o.id: sum(it.weight_kg for it in o.items) for o in self.orders}
        for st in cand_stops:
            if st.stop_type == "PICKUP":
                w += order_weights.get(st.order_id, 0.0)
            elif st.stop_type == "DELIVERY":
                w -= order_weights.get(st.order_id, 0.0)
            st.current_weight_kg = w
            if w > v.payload_limit_kg + 0.01:
                return False, []

        # 2. Packing & LIFO door clearance check
        if not self._validate_stops_cached(v_idx, cand_stops):
            return False, []

        # 3. Time windows, vehicle availability and return-to-depot feasibility.
        if self._schedule_stops(v_idx, cand_stops) is None:
            return False, []

        return True, cand_stops

    def _repair_greedy_insert(
        self,
        routes_stops: List[List[ScheduledStop]],
        unassigned_ids: List[str],
        start_time: Optional[float] = None,
        randomize: bool = True,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        still_unassigned = []
        orders_to_insert = [self.order_by_id[oid] for oid in unassigned_ids]
        if randomize:
            self.rng.shuffle(orders_to_insert)
        else:
            orders_to_insert.sort(
                key=lambda order: (
                    sum(item.weight_kg for item in order.items),
                    sum(item.length_cm * item.width_cm for item in order.items),
                    -(
                        order.delivery_window_end_sec
                        - order.pickup_window_start_sec
                    ),
                ),
                reverse=True,
            )

        for order in orders_to_insert:
            if start_time is not None and time.perf_counter() - start_time >= self.time_limit_sec:
                still_unassigned.append(order.id)
                continue

            best_incremental_cost = float("inf")
            best_v_idx: Optional[int] = None
            best_cand_stops: Optional[List[ScheduledStop]] = None
            checked_empty_types: Set[Tuple] = set()

            for v_idx in range(len(self.vehicles)):
                curr_stops = routes_stops[v_idx]
                v = self.vehicles[v_idx]

                if not self._order_allows_vehicle(order, v):
                    continue

                if len(curr_stops) == 0:
                    v_type = (
                        v.payload_limit_kg,
                        v.length_cm,
                        v.width_cm,
                        v.height_cm,
                        v.depot.id,
                        v.service_day_index,
                    )
                    if v_type in checked_empty_types:
                        continue
                    checked_empty_types.add(v_type)

                n = len(curr_stops)
                if n <= 4:
                    positions = [(i, j) for i in range(n + 1) for j in range(i + 1, n + 2)]
                else:
                    positions = [(n, n + 1), (0, n + 1), (max(0, n - 2), n + 1)]

                base_dist = self._calc_route_distance_km(v_idx, curr_stops)

                for i, j in positions:
                    feasible, cand_stops = self._can_insert_order(v_idx, curr_stops, order, i, j)
                    if feasible:
                        cand_dist = self._calc_route_distance_km(v_idx, cand_stops)
                        inc_dist = cand_dist - base_dist

                        inc_fuel = (v.fuel_consumption_liters_per_100_km / 100.0) * inc_dist * self.policy.fuel_price_per_liter_vnd
                        inc_fixed = v.fixed_operating_cost_vnd if len(curr_stops) == 0 else 0
                        inc_driver = (150_000 if len(curr_stops) == 0 else 0) + round(1_200 * inc_dist)
                        inc_cost = inc_fuel + inc_fixed + inc_driver

                        if inc_cost < best_incremental_cost:
                            best_incremental_cost = inc_cost
                            best_v_idx = v_idx
                            best_cand_stops = cand_stops

            if best_v_idx is not None and best_cand_stops is not None:
                routes_stops[best_v_idx] = best_cand_stops
            else:
                still_unassigned.append(order.id)

        return routes_stops, still_unassigned

    def _destroy_random(
        self,
        routes_stops: List[List[ScheduledStop]],
        num_remove: int,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        all_assigned = []
        for v_idx, stops in enumerate(routes_stops):
            for st in stops:
                if st.stop_type == "PICKUP" and st.order_id:
                    all_assigned.append((st.order_id, v_idx))

        if not all_assigned:
            return routes_stops, []

        remove_orders = {
            item[0]
            for item in self.rng.sample(
                all_assigned, min(num_remove, len(all_assigned))
            )
        }

        new_routes = []
        for stops in routes_stops:
            filtered = [s for s in stops if s.order_id not in remove_orders]
            new_routes.append(filtered)

        return new_routes, list(remove_orders)

    def _destroy_small_route(
        self, routes_stops: List[List[ScheduledStop]]
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        active_routes = [(v_idx, stops) for v_idx, stops in enumerate(routes_stops) if stops]
        if len(active_routes) <= 1:
            return self._destroy_random(routes_stops, 2)

        active_routes.sort(key=lambda item: len({s.order_id for s in item[1] if s.order_id}))
        victim_v_idx, victim_stops = active_routes[0]

        removed_ids = list({s.order_id for s in victim_stops if s.order_id})
        new_routes = copy.deepcopy(routes_stops)
        new_routes[victim_v_idx] = []

        return new_routes, removed_ids

    def solve(self) -> FleetOptimizationResponse:
        start_time = time.perf_counter()

        # 1. Initial Feasible Solution
        current_routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        all_order_ids = [o.id for o in self.orders]
        current_routes, current_unassigned = self._repair_greedy_insert(
            current_routes, all_order_ids, start_time=None
        )

        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_penalized, _, _ = self._evaluate_plan_cost(
            best_routes, best_unassigned
        )
        curr_penalized = best_penalized

        # 2. Simulated Annealing Optimization Loop
        temperature = 400_000.0
        cooling_rate = 0.95
        iteration = 0

        while iteration < self.max_iterations:
            if time.perf_counter() - start_time >= self.time_limit_sec:
                break
            iteration += 1

            if self.rng.random() < 0.35 and any(r for r in current_routes):
                destroyed_routes, removed_ids = self._destroy_small_route(current_routes)
            else:
                num_remove = self.rng.randint(
                    1, max(1, min(3, len(self.orders) // 3))
                )
                destroyed_routes, removed_ids = self._destroy_random(
                    copy.deepcopy(current_routes), num_remove
                )

            pool = list(set(current_unassigned + removed_ids))

            repaired_routes, new_unassigned = self._repair_greedy_insert(
                destroyed_routes, pool, start_time=start_time
            )
            new_penalized, _, _ = self._evaluate_plan_cost(repaired_routes, new_unassigned)

            delta = new_penalized - curr_penalized
            if delta < 0 or (
                temperature > 1e-4
                and self.rng.random() < math.exp(-delta / max(1.0, temperature))
            ):
                current_routes = repaired_routes
                current_unassigned = new_unassigned
                curr_penalized = new_penalized

                if new_penalized < best_penalized:
                    best_penalized = new_penalized
                    best_routes = copy.deepcopy(repaired_routes)
                    best_unassigned = list(new_unassigned)

            temperature *= cooling_rate

        # 3. Post-process & Format Final Response
        return self._build_final_response(best_routes, best_unassigned)

    def _build_final_response(
        self, routes_stops: List[List[ScheduledStop]], unassigned_ids: List[str]
    ) -> FleetOptimizationResponse:
        optimized_routes: List[OptimizedRoute] = []
        total_dist_km = 0.0
        total_dur_min = 0.0
        total_cost_vnd = 0
        final_unassigned_ids = list(dict.fromkeys(unassigned_ids))
        diagnostics: List[str] = []

        order_by_id = self.order_by_id
        nodes = []
        for v in self.vehicles:
            nodes.append({"id": v.depot.id, "latitude": v.depot.latitude, "longitude": v.depot.longitude})
        for o in self.orders:
            nodes.append({"id": o.pickup_location.id, "latitude": o.pickup_location.latitude, "longitude": o.pickup_location.longitude})
            nodes.append({"id": o.delivery_location.id, "latitude": o.delivery_location.latitude, "longitude": o.delivery_location.longitude})

        for v_idx, stops in enumerate(routes_stops):
            if not stops:
                continue
            v = self.vehicles[v_idx]
            schedule_result = self._schedule_stops(v_idx, stops)
            if schedule_result is None:
                final_unassigned_ids.extend(
                    stop.allocation_id or stop.order_id
                    for stop in stops
                    if stop.stop_type == "PICKUP"
                    and (stop.allocation_id or stop.order_id)
                )
                diagnostics.append(
                    f"ILS loại tuyến {v.plate_number} vì không còn thỏa time window/ca xe khi kiểm tra cuối."
                )
                continue
            scheduled_stops, route_end_sec, return_travel_sec = schedule_result
            curr_weight = 0.0

            formatted_stops: List[ScheduledStop] = []
            stop_actions: List[StopAction] = []

            for st in scheduled_stops:
                if st.stop_type == "PICKUP":
                    curr_weight += sum(
                        it.weight_kg for it in order_by_id[st.allocation_id or st.order_id].items
                    )
                else:
                    curr_weight = max(
                        0.0,
                        curr_weight
                        - sum(
                            it.weight_kg
                            for it in order_by_id[st.allocation_id or st.order_id].items
                        ),
                    )

                f_stop = st.model_copy(
                    update={
                        "order_id": order_by_id[
                            st.allocation_id or st.order_id
                        ].source_order_id
                        or st.order_id,
                        "order_stop_id": (
                            order_by_id[
                                st.allocation_id or st.order_id
                            ].pickup_location.source_location_id
                            if st.stop_type == "PICKUP"
                            else order_by_id[
                                st.allocation_id or st.order_id
                            ].delivery_location.source_location_id
                        )
                        or st.order_stop_id
                        or st.location_id,
                        "current_weight_kg": round(curr_weight, 2),
                    }
                )
                formatted_stops.append(f_stop)

                action_items_load = [self.cargo_by_id[it_id] for it_id in st.items_loaded if it_id in self.cargo_by_id]
                stop_actions.append(
                    StopAction(
                        stop_id=st.location_id,
                        sequence=st.sequence,
                        stop_type=st.stop_type,
                        address=st.location_name,
                        latitude=st.latitude,
                        longitude=st.longitude,
                        items_to_load=action_items_load,
                        items_to_unload=st.items_unloaded,
                    )
                )

            route_dist_km = self._calc_route_distance_km(v_idx, formatted_stops)
            route_dur_min = round(
                (route_end_sec - v.available_start_sec) / 60.0, 1
            )

            # Spatial validation using production validator
            validator = SpatialValidator(v)
            spatial_res = validator.validate_plan(stop_actions)
            if not spatial_res.is_valid:
                final_unassigned_ids.extend(
                    stop.allocation_id or stop.order_id
                    for stop in formatted_stops
                    if stop.stop_type == "PICKUP"
                    and (stop.allocation_id or stop.order_id)
                )
                diagnostics.append(
                    f"ILS loại tuyến {v.plate_number}: "
                    f"{spatial_res.error_message or spatial_res.violation_code or 'bố trí không hợp lệ'}."
                )
                continue

            fuel_cost, holding_cost, late_penalty, ton_km, ton_hrs = calculate_route_economic_metrics(
                self.request, nodes, order_by_id, v, formatted_stops
            )

            liters = (v.fuel_consumption_liters_per_100_km / 100.0) * route_dist_km
            base_fuel = round(liters * self.policy.fuel_price_per_liter_vnd)
            load_fuel = max(0, fuel_cost - base_fuel)

            cost_bd = RouteCostBreakdown(
                base_fuel_cost_vnd=base_fuel,
                load_fuel_surcharge_vnd=load_fuel,
                fuel_cost_vnd=fuel_cost,
                cargo_holding_cost_vnd=holding_cost,
                late_delivery_penalty_vnd=late_penalty,
                cargo_distance_ton_km=ton_km,
                cargo_time_ton_hours=ton_hrs,
                vehicle_fixed_cost_vnd=v.fixed_operating_cost_vnd,
                driver_fixed_salary_allocation_vnd=0,
                driver_trip_pay_vnd=0,
                total_cost_vnd=fuel_cost + v.fixed_operating_cost_vnd + holding_cost + late_penalty,
            )

            opt_route = OptimizedRoute(
                route_id=v.id,
                vehicle_id=v.source_vehicle_id or v.id,
                plate_number=v.plate_number,
                vehicle_length_cm=v.length_cm,
                vehicle_width_cm=v.width_cm,
                service_day_index=v.service_day_index,
                start_time_sec=v.available_start_sec,
                end_time_sec=route_end_sec,
                total_distance_km=round(route_dist_km, 2),
                total_duration_minutes=route_dur_min,
                return_travel_time_sec=return_travel_sec,
                return_waiting_time_sec=0,
                stops=formatted_stops,
                spatial_validation=spatial_res,
                cost=cost_bd,
            )
            optimized_routes.append(opt_route)

            total_dist_km += route_dist_km
            total_dur_min += route_dur_min

        # 4. Optimal Driver Assignment (Hungarian Algorithm < 1ms)
        driver_matcher = DriverMatcher(self.request)
        optimized_routes = driver_matcher.assign_drivers_to_routes(optimized_routes)

        for r in optimized_routes:
            if r.cost:
                total_cost_vnd += r.cost.total_cost_vnd

        final_unassigned_ids = list(dict.fromkeys(final_unassigned_ids))
        unassigned_objects: List[UnassignedOrder] = []
        for oid in final_unassigned_ids:
            ord_obj = self.order_by_id.get(oid)
            num_str = ord_obj.order_number if ord_obj else oid
            unassigned_objects.append(
                UnassignedOrder(
                    order_id=oid,
                    order_number=num_str,
                    reason_code="UNASSIGNED",
                    reason_message="Không tìm thấy phương án ghép xe thỏa mãn thời gian hoặc không gian LIFO",
                )
            )

        status_str = (
            "SUCCESS"
            if not unassigned_objects
            else "PARTIAL"
            if optimized_routes
            else "INFEASIBLE"
        )

        # 5. Compute Direct Dedicated Baseline Comparison
        benchmarks = None
        try:
            calc = BaselineCostCalculator(self.request, nodes)
            benchmarks = calc.build_comparison(
                optimized_routes,
                total_cost_vnd,
                total_dist_km,
                total_dur_min,
                ortools_is_feasible=(status_str == "SUCCESS"),
            )
        except Exception as error:
            diagnostics.append(f"Không tính được benchmark ILS: {error}")

        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status=status_str,
            routes=optimized_routes,
            unassigned_orders=unassigned_objects,
            total_distance_km=round(total_dist_km, 2),
            total_duration_minutes=round(total_dur_min, 1),
            total_cost_vnd=total_cost_vnd,
            benchmarks=benchmarks,
            diagnostics=diagnostics
            + [
                f"ALNS hoàn tất: {len(optimized_routes)} tuyến hợp lệ, "
                f"{len(unassigned_objects)} đơn chưa phân công."
            ],
        )
