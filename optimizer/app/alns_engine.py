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
from typing import Any, Dict, List, Optional, Set, Tuple

from .baseline_calculator import BaselineCostCalculator
from .driver_matcher import DriverMatcher
from .interprovincial import (
    ScheduledTimelineResult,
    calculate_route_overnight_allowance_vnd,
    calculate_route_toll_vnd,
    check_cross_day_resource_conflicts,
    is_driver_compatible_with_vehicle,
    is_order_compatible_with_vehicle_and_warehouses,
    location_identity,
    resolve_rest_policy_limits,
    resolve_vehicle_end_location,
    resolve_vehicle_end_node_index,
    route_stops_have_cargo_conflict,
    schedule_route_timeline,
)
from .models import (
    BenchmarkComparisonResponse,
    BenchmarkMetric,
    CargoItem,
    DemoStackingPolicy,
    FloorState,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    PackageAccessPath,
    PlacedItem,
    RestBreakRecord,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    UnassignedOrder,
    advance_past_curfews,
    can_driver_drive_vehicle,
)
from .planning_objective import calendar_salary_for_span, operational_late_penalty_for_stops
from .packing_rules import calculate_route_weight_balance_penalty_vnd, resolve_can_rotate
from .route_costing import (
    calculate_driver_cost,
    calculate_late_delivery_penalty,
    calculate_route_economic_metrics,
)
from .request_preprocessor import split_infeasible_orders_across_fleet
from .hybrid_alns.packing_checker import bounded_spatial_fallback
from .spatial_validator import SpatialValidator
from .stacking import (
    enforce_spatial_weight_balance_if_needed,
    fast_validate_stacked_route,
    sync_route_stacking_unloads,
    validate_stop_actions,
)


class FastLIFOPackingChecker:
    """Microsecond-fast non-stackable 2D floor packing with LIFO door clearance check."""

    def __init__(self, vehicle: FleetVehicle, *, demo_stacking: Optional[DemoStackingPolicy] = None):
        self.vehicle = vehicle
        self.demo_stacking = demo_stacking
        self.bed_l = vehicle.length_cm
        self.bed_w = vehicle.width_cm
        self.bed_area = self.bed_l * self.bed_w
        self.payload = vehicle.payload_limit_kg

    def validate_route_stops(
        self,
        candidate_stops: List[ScheduledStop],
        cargo_by_id: Dict[str, CargoItem],
    ) -> Tuple[bool, str]:
        if self.demo_stacking is not None:
            return fast_validate_stacked_route(
                self.vehicle,
                candidate_stops,
                cargo_by_id,
                self.demo_stacking,
                allow_layout_search=False,
            )
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
                # Packages unloaded at the same stop may leave one by one.  The
                # former input-order loop treated a nearer package from the same
                # delivery as a permanent blocker and rejected most multi-item
                # orders.  Remove door-nearest packages first, without moving any
                # package that remains onboard after this stop.
                onboard_ids = {box["id"] for box in placed_boxes}
                missing_ids = [
                    item_id
                    for item_id in stop.items_unloaded
                    if item_id not in onboard_ids
                ]
                if missing_ids:
                    return False, "Dỡ kiện chưa có trên xe"
                target_boxes = [
                    box for box in placed_boxes if box["id"] in stop.items_unloaded
                ]
                target_boxes.sort(
                    key=lambda box: box["x"] + box["l"], reverse=True
                )
                for target_box in target_boxes:

                    # LIFO door clearance: Check if path from rear door (x = bed_l) to target box is blocked
                    for other in placed_boxes:
                        if other["id"] == target_box["id"]:
                            continue
                        if other["x"] > target_box["x"] + 0.01:
                            if not (other["y"] + other["w"] <= target_box["y"] + 0.01 or other["y"] >= target_box["y"] + target_box["w"] - 0.01):
                                return False, "Bị hàng dỡ sau chặn lối ra cửa đuôi"

                    placed_boxes = [
                        box for box in placed_boxes if box["id"] != target_box["id"]
                    ]
                    item = cargo_by_id.get(target_box["id"])
                    if item:
                        onboard_weight = max(0.0, onboard_weight - item.weight_kg)

        return True, "Hợp lệ"

    def _place_box(self, item: CargoItem, placed_boxes: List[Dict]) -> Optional[Dict]:
        total_used_area = sum(b["l"] * b["w"] for b in placed_boxes)
        box_area = item.length_cm * item.width_cm
        if total_used_area + box_area > self.bed_area + 0.01:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if resolve_can_rotate(item) and abs(item.length_cm - item.width_cm) > 0.1:
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
        should_split_orders: bool = True,
    ):
        self.objective_request = request
        if should_split_orders:
            request, _ = split_infeasible_orders_across_fleet(request)
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
        self._order_weight_by_id = {
            o.id: sum(it.weight_kg for it in o.items) for o in self.orders
        }
        self.cargo_by_id = {it.id: it for o in self.orders for it in o.items}
        self.vehicle_by_id = {v.id: v for v in self.vehicles}
        self.order_node_indices = {
            order.id: (len(self.vehicles) + 2 * index, len(self.vehicles) + 2 * index + 1)
            for index, order in enumerate(self.orders)
        }

        self.checkers = [FastLIFOPackingChecker(v, demo_stacking=request.demo_stacking) for v in self.vehicles]
        self._packing_cache: Dict[
            Tuple[Tuple[object, ...], Tuple[Tuple[str, str], ...]], bool
        ] = {}

    def _stop_node_index(self, stop: ScheduledStop) -> Optional[int]:
        """Resolve a stop to its exact matrix node, even when locations repeat."""
        allocation_id = stop.allocation_id or stop.order_id
        indices = self.order_node_indices.get(allocation_id or "")
        if indices is None:
            return None
        return indices[0] if stop.stop_type == "PICKUP" else indices[1]

    @staticmethod
    def _adjust_first_stop_waiting_for_jit_start(
        vehicle: FleetVehicle,
        stops: List[ScheduledStop],
    ) -> Tuple[int, List[ScheduledStop]]:
        """Move pre-opening wait to the depot start time without double-counting it.

        Keeping the original stop waiting while shifting ``start_time_sec`` forward
        violates ``arrival - previous_departure = travel + waiting`` in ``is_fully_served``.
        """
        first_stop = stops[0]
        route_start_sec = max(
            vehicle.available_start_sec,
            first_stop.arrival_time_sec - first_stop.travel_time_sec,
        )
        first_stop_waiting_sec = max(
            0,
            first_stop.arrival_time_sec
            - route_start_sec
            - first_stop.travel_time_sec,
        )
        if first_stop_waiting_sec == first_stop.waiting_time_sec:
            return route_start_sec, stops
        adjusted_stops = list(stops)
        adjusted_stops[0] = first_stop.model_copy(
            update={"waiting_time_sec": first_stop_waiting_sec}
        )
        return route_start_sec, adjusted_stops

    def _schedule_stops_detailed(
        self,
        v_idx: int,
        stops: List[ScheduledStop],
        *,
        apply_jit_start: bool = False,
    ) -> Optional[ScheduledTimelineResult]:
        if route_stops_have_cargo_conflict(stops, self.order_by_id):
            return None
        vehicle = self.vehicles[v_idx]
        timeline = schedule_route_timeline(
            vehicle=vehicle,
            vehicle_index=v_idx,
            stops=stops,
            order_by_id=self.order_by_id,
            distance_matrix=self.request.distance_matrix_meters,
            duration_matrix=self.request.duration_matrix_seconds,
            stop_node_resolver=self._stop_node_index,
            end_node_index=resolve_vehicle_end_node_index(
                self.vehicles, self.orders, v_idx, vehicle
            ),
            rest_policy=getattr(self.policy, "driving_rest_policy", None),
            apply_jit_start=apply_jit_start,
        )
        return timeline if timeline.feasible else None

    def _schedule_stops(
        self, v_idx: int, stops: List[ScheduledStop]
    ) -> Optional[Tuple[List[ScheduledStop], int, int]]:
        """Apply travel, waiting, rest breaks, docking and time windows."""
        timeline = self._schedule_stops_detailed(v_idx, stops, apply_jit_start=False)
        if timeline is None:
            return None
        return (
            timeline.scheduled_stops,
            timeline.route_end_sec,
            timeline.return_travel_time_sec,
        )

    def _validate_stops_cached(self, v_idx: int, cand_stops: List[ScheduledStop]) -> bool:
        v = self.vehicles[v_idx]
        cache_key = (
            getattr(self, "_allow_layout_search", True),
            (
                v.length_cm,
                v.width_cm,
                v.height_cm,
                v.payload_limit_kg,
                v.door_position,
                v.door_width_cm,
            ),
            tuple(
                (st.allocation_id or st.order_id or "", st.stop_type)
                for st in cand_stops
                if st.allocation_id or st.order_id
            ),
        )
        if cache_key in self._packing_cache:
            return self._packing_cache[cache_key]

        valid, _ = self.checkers[v_idx].validate_route_stops(cand_stops, self.cargo_by_id)
        if not valid and getattr(self, "_allow_layout_search", True):
            valid = bounded_spatial_fallback(
                v,
                cand_stops,
                self.cargo_by_id,
                demo_stacking=self.request.demo_stacking,
                cost_policy=self.policy,
            )
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
        end_idx = resolve_vehicle_end_node_index(self.vehicles, self.orders, v_idx, v)
        if end_idx is not None and prev < len(self.request.distance_matrix_meters) and end_idx < len(self.request.distance_matrix_meters[prev]):
            total_meters += self.request.distance_matrix_meters[prev][end_idx]
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

            onboard_weight = 0.0
            holding_cost = 0
            load_fuel_surcharge = 0
            for st in stops:
                oid = getattr(st, "allocation_id", None) or getattr(st, "order_id", None)
                ord_pair = self.order_by_id.get(oid) if oid and hasattr(self, "order_by_id") else None
                if ord_pair:
                    if getattr(st, "stop_type", "") == "PICKUP":
                        onboard_weight += ord_pair.total_weight_kg
                    elif getattr(st, "stop_type", "") == "DELIVERY":
                        onboard_weight = max(0.0, onboard_weight - ord_pair.total_weight_kg)
                load_ratio = min(1.0, max(0.0, onboard_weight / max(1.0, v.payload_limit_kg)))
                load_fuel_surcharge += round(
                    fuel_cost * (v.load_fuel_surcharge_percent_at_full_payload / 100.0) * load_ratio / max(1, len(stops))
                )
                holding_rate = getattr(self.policy, "cargo_holding_cost_vnd_per_ton_hour", 30_000)
                holding_cost += round((onboard_weight / 1000.0) * (holding_rate / 3600.0) * 1800)

            total_economic += (fuel_cost + load_fuel_surcharge + holding_cost + fixed_cost + driver_est)

        obj_req = getattr(self, "objective_request", getattr(self, "request", None))
        span = max(
            (
                self.vehicles[v_idx].service_day_index + 1
                for v_idx, stops in enumerate(routes_stops)
                if stops
            ),
            default=0,
        )
        if span > 1 and obj_req is not None:
            total_economic += max(
                0,
                calendar_salary_for_span(obj_req, span)
                - calendar_salary_for_span(obj_req, 1),
            )
        if obj_req is not None and self.policy.late_delivery_penalty_mode == "NONE":
            total_economic += operational_late_penalty_for_stops(
                obj_req,
                routes_stops,
                order_by_id=self.order_by_id,
            )

        penalized = (
            total_economic
            + len(unassigned_ids) * self.policy.unassigned_order_penalty_vnd
        )
        return penalized, total_economic, total_km

    def _order_allows_vehicle(self, order: OrderPair, vehicle: FleetVehicle) -> bool:
        """Enforces allowlist, thermal mode, warehouse truck limits & lift gear."""
        return is_order_compatible_with_vehicle_and_warehouses(order, vehicle)

    def _vehicle_has_compatible_driver(self, vehicle: FleetVehicle) -> bool:
        return any(
            is_driver_compatible_with_vehicle(driver, vehicle)
            for driver in self.drivers
        )

    def _can_insert_order(
        self,
        v_idx: int,
        current_stops: List[ScheduledStop],
        order: OrderPair,
        p_pos: int,
        d_pos: int,
        check_packing: bool = True,
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
            service_time_sec=order.service_seconds("PICKUP"),
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
            service_time_sec=order.service_seconds("DELIVERY"),
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

        if route_stops_have_cargo_conflict(cand_stops, self.order_by_id):
            return False, []

        # 1. Capacity check along the route
        w = 0.0
        order_weights = self._order_weight_by_id
        for st in cand_stops:
            if st.stop_type == "PICKUP":
                w += order_weights.get(st.order_id, 0.0)
            elif st.stop_type == "DELIVERY":
                w -= order_weights.get(st.order_id, 0.0)
            st.current_weight_kg = w
            if w > v.payload_limit_kg + 0.01:
                return False, []

        # 2. Reject cheap temporal failures before the more expensive packing
        # check. Multi-day snapshots contain many vehicle-day copies that cannot
        # serve a given order, so the former order wasted most of the ALNS budget
        # packing routes that the schedule would reject immediately.
        if self._schedule_stops(v_idx, cand_stops) is None:
            return False, []

        # 3. Packing & LIFO door clearance check.
        if check_packing and not self._validate_stops_cached(v_idx, cand_stops):
            return False, []

        return True, cand_stops

    def _repair_greedy_insert(
        self,
        routes_stops: List[List[ScheduledStop]],
        unassigned_ids: List[str],
        start_time: Optional[float] = None,
        randomize: bool = True,
        deadline: Optional[float] = None,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        still_unassigned = []
        orders_to_insert = [self.order_by_id[oid] for oid in unassigned_ids]
        if randomize:
            self.rng.shuffle(orders_to_insert)
        else:
            orders_to_insert.sort(
                key=lambda order: (
                    order.source_order_id or order.id,
                    -sum(item.weight_kg for item in order.items),
                    -sum(item.length_cm * item.width_cm for item in order.items),
                    (order.delivery_window_end_sec - order.pickup_window_start_sec),
                ),
            )

        effective_deadline = deadline
        if start_time is not None:
            start_deadline = start_time + self.time_limit_sec
            effective_deadline = (
                min(effective_deadline, start_deadline)
                if effective_deadline is not None
                else start_deadline
            )

        for order_idx, order in enumerate(orders_to_insert):
            if effective_deadline is not None and time.perf_counter() >= effective_deadline:
                still_unassigned.extend(o.id for o in orders_to_insert[order_idx:])
                break

            best_incremental_cost = float("inf")
            best_v_idx: Optional[int] = None
            best_cand_stops: Optional[List[ScheduledStop]] = None
            checked_empty_types: Set[Tuple] = set()
            obj_req = getattr(self, "objective_request", getattr(self, "request", None))
            existing_span = max(
                (
                    self.vehicles[idx].service_day_index + 1
                    for idx, r in enumerate(routes_stops)
                    if r
                ),
                default=0,
            )
            calendar_by_span = {
                existing_span: calendar_salary_for_span(obj_req, existing_span)
                if obj_req is not None
                else 0
            }

            timed_out = False
            for v_idx in range(len(self.vehicles)):
                if effective_deadline is not None and time.perf_counter() >= effective_deadline:
                    timed_out = True
                    break
                curr_stops = routes_stops[v_idx]
                v = self.vehicles[v_idx]

                if not self._order_allows_vehicle(order, v):
                    continue
                span = max(existing_span, v.service_day_index + 1)
                if span not in calendar_by_span:
                    calendar_by_span[span] = (
                        calendar_salary_for_span(obj_req, span)
                        if obj_req is not None
                        else 0
                    )
                calendar_extension = (
                    calendar_by_span[span] - calendar_by_span[existing_span]
                )

                if len(curr_stops) == 0:
                    if (v.fixed_operating_cost_vnd + 150_000 + calendar_extension) >= best_incremental_cost:
                        continue
                    max_routes = getattr(self.request.policy, "max_routes_per_day", None)
                    if (
                        max_routes is not None
                        and sum(
                            1
                            for idx, stops in enumerate(routes_stops)
                            if stops and self.vehicles[idx].service_day_index == v.service_day_index
                        )
                        >= max_routes
                    ):
                        continue
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
                if n <= 12:
                    positions = [(i, j) for i in range(n + 1) for j in range(i + 1, n + 2)]
                else:
                    anchor_indices = sorted({0, n // 4, n // 2, (3 * n) // 4, max(0, n - 2), n})
                    pos_set = set()
                    for i in anchor_indices:
                        for j in [i + 1, (i + 1 + n) // 2, n + 1]:
                            if j > i and j <= n + 1:
                                pos_set.add((i, j))
                    pos_set.add((n, n + 1))
                    pos_set.add((0, n + 1))
                    positions = sorted(pos_set)

                base_dist = self._calc_route_distance_km(v_idx, curr_stops)
                target_source = order.source_order_id or order.id
                shares_source_order = any(
                    (self.order_by_id[st.allocation_id or st.order_id].source_order_id or st.order_id) == target_source
                    for st in curr_stops
                    if (st.allocation_id or st.order_id) in self.order_by_id
                )

                for i, j in positions:
                    if effective_deadline is not None and time.perf_counter() >= effective_deadline:
                        timed_out = True
                        break
                    # Screen schedule and incremental cost before paying the
                    # expensive 3D packing check on non-competitive candidates.
                    feasible, cand_stops = self._can_insert_order(
                        v_idx, curr_stops, order, i, j, check_packing=False
                    )
                    if not feasible:
                        continue
                    cand_dist = self._calc_route_distance_km(v_idx, cand_stops)
                    inc_dist = cand_dist - base_dist

                    inc_fuel = (v.fuel_consumption_liters_per_100_km / 100.0) * inc_dist * self.policy.fuel_price_per_liter_vnd
                    inc_fixed = v.fixed_operating_cost_vnd if len(curr_stops) == 0 else 0
                    inc_driver = (150_000 if len(curr_stops) == 0 else 0) + round(1_200 * inc_dist)
                    inc_cost = inc_fuel + inc_fixed + inc_driver + calendar_extension
                    if shares_source_order:
                        inc_cost -= 50_000

                    if inc_cost >= best_incremental_cost:
                        continue
                    if not self._validate_stops_cached(v_idx, cand_stops):
                        continue
                    best_incremental_cost = inc_cost
                    best_v_idx = v_idx
                    best_cand_stops = cand_stops
                if timed_out:
                    break

            if best_v_idx is not None and best_cand_stops is not None:
                routes_stops[best_v_idx] = best_cand_stops
            else:
                still_unassigned.append(order.id)
            if timed_out:
                still_unassigned.extend(o.id for o in orders_to_insert[order_idx + 1 :])
                break

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

    def _spatial_cargo_item(self, item_id: str) -> CargoItem:
        item = self.cargo_by_id[item_id]
        can_rotate = resolve_can_rotate(
            item,
            d11_default=True,
        )
        return item if item.can_rotate == can_rotate else item.model_copy(
            update={"can_rotate": can_rotate}
        )

    def _validate_spatial_actions(
        self,
        vehicle_index: int,
        actions: List[StopAction],
        max_time_seconds: Optional[float] = None,
    ) -> SpatialValidationResult:
        validator_kwargs = (
            {"max_time_seconds": max_time_seconds}
            if max_time_seconds is not None
            else {}
        )
        res = validate_stop_actions(
            self.request.demo_stacking,
            self.vehicles[vehicle_index],
            actions,
            **validator_kwargs,
        )
        return enforce_spatial_weight_balance_if_needed(
            self.request.demo_stacking, res, cost_policy=self.policy
        )

    @staticmethod
    def _join_direct_cycles(
        trips: List[OptimizedRoute], stops: List[ScheduledStop],
    ) -> Optional[SpatialValidationResult]:
        """Reuse this solve's audited layouts only at consecutive empty-truck boundaries."""
        if not trips or len(stops) != 2 * len(trips):
            return None
        states = []
        for index, trip in enumerate(trips):
            audit = trip.spatial_validation
            pair = stops[2 * index:2 * index + 2]
            if (not audit.is_valid or len(audit.step_states) != 2 or len(trip.stops) != 2
                    or audit.step_states[-1].placed_items
                    or [s.stop_type for s in pair] != ["PICKUP", "DELIVERY"]
                    or set(pair[0].items_loaded) != set(pair[1].items_unloaded)):
                return None
            for step, original, actual in zip(audit.step_states, trip.stops, pair):
                if (not step.is_valid or step.stop_id != actual.location_id
                        or original.allocation_id != actual.allocation_id
                        or original.items_loaded != actual.items_loaded
                        or original.items_unloaded != actual.items_unloaded):
                    return None
                states.append(step.model_copy(update={"step_index": len(states) + 1}))
        audits = [trip.spatial_validation for trip in trips]
        imbalance = [a.max_lateral_imbalance_percent for a in audits if a.max_lateral_imbalance_percent is not None]
        return SpatialValidationResult(
            is_valid=True, step_states=states, demo_stacking=audits[0].demo_stacking,
            max_weight_kg=max(a.max_weight_kg for a in audits),
            max_area_cm2=max(a.max_area_cm2 for a in audits),
            max_lateral_imbalance_percent=max(imbalance, default=None),
        )

    def _economic_nodes(self) -> List[Dict[str, Any]]:
        cached = getattr(self, "_cached_economic_nodes", None)
        if cached is not None:
            return cached
        nodes: List[Dict[str, Any]] = []
        for v in self.vehicles:
            nodes.append({"id": v.depot.id, "latitude": v.depot.latitude, "longitude": v.depot.longitude})
        for o in self.orders:
            nodes.append(
                {
                    "id": o.pickup_location.id,
                    "latitude": o.pickup_location.latitude,
                    "longitude": o.pickup_location.longitude,
                    "order": o,
                }
            )
            nodes.append(
                {
                    "id": o.delivery_location.id,
                    "latitude": o.delivery_location.latitude,
                    "longitude": o.delivery_location.longitude,
                    "order": o,
                }
            )
        self._cached_economic_nodes = nodes
        return nodes

    def _prepare_scheduled_route_with_timeline(
        self,
        v_idx: int,
        stops: List[ScheduledStop],
    ) -> Tuple[
        Optional[
            Tuple[
                Tuple[FleetVehicle, List[ScheduledStop], List[StopAction], int, int, float, float, int],
                ScheduledTimelineResult,
            ]
        ],
        List[str],
        Optional[str],
    ]:
        """Validate vehicle allowance + schedule + format stops/actions with full timeline metadata."""
        v = self.vehicles[v_idx]
        route_order_ids = [
            stop.allocation_id or stop.order_id
            for stop in stops
            if stop.stop_type == "PICKUP" and (stop.allocation_id or stop.order_id)
        ]
        disallowed_order_ids = [
            order_id
            for order_id in set(route_order_ids)
            if order_id in self.order_by_id
            and not self._order_allows_vehicle(self.order_by_id[order_id], v)
        ]
        if disallowed_order_ids:
            return (
                None,
                disallowed_order_ids,
                f"Bộ tìm kiếm loại tuyến {v.plate_number} vì có đơn không cho phép xe vật lý hoặc không tương thích kho.",
            )
        if route_stops_have_cargo_conflict(stops, self.order_by_id):
            return (
                None,
                list(route_order_ids),
                f"Bộ tìm kiếm loại tuyến {v.plate_number} vì có hai nhóm hàng không được chở chung.",
            )

        timeline = self._schedule_stops_detailed(v_idx, stops, apply_jit_start=True)
        if timeline is None:
            return (
                None,
                list(route_order_ids),
                f"Bộ tìm kiếm loại tuyến {v.plate_number} vì không còn thỏa time window/ca xe/nghỉ lái khi kiểm tra cuối.",
            )

        scheduled_stops = timeline.scheduled_stops
        order_by_id = self.order_by_id
        curr_weight = 0.0
        formatted_stops: List[ScheduledStop] = []
        stop_actions: List[StopAction] = []

        for st in scheduled_stops:
            key_oid = st.allocation_id or st.order_id
            order_obj = order_by_id[key_oid]
            order_weight = sum(it.weight_kg for it in order_obj.items)
            if st.stop_type == "PICKUP":
                curr_weight += order_weight
            else:
                curr_weight = max(0.0, curr_weight - order_weight)

            f_stop = st.model_copy(
                update={
                    "order_id": order_obj.source_order_id or st.order_id,
                    "order_stop_id": (
                        order_obj.pickup_location.source_location_id
                        if st.stop_type == "PICKUP"
                        else order_obj.delivery_location.source_location_id
                    )
                    or st.order_stop_id
                    or st.location_id,
                    "current_weight_kg": round(curr_weight, 2),
                }
            )
            formatted_stops.append(f_stop)

            action_items_load = [
                self._spatial_cargo_item(item_id)
                for item_id in st.items_loaded
                if item_id in self.cargo_by_id
            ]
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

        route_dist_km = timeline.total_distance_meters / 1000.0
        route_start_sec = timeline.route_start_sec
        route_end_sec = timeline.route_end_sec
        return_travel_sec = timeline.return_travel_time_sec
        route_dur_min = round((route_end_sec - route_start_sec) / 60.0, 1)
        prepared = (
            v,
            formatted_stops,
            stop_actions,
            route_start_sec,
            route_end_sec,
            route_dist_km,
            route_dur_min,
            return_travel_sec,
        )
        return (prepared, timeline), [], None

    def _prepare_scheduled_route(
        self,
        v_idx: int,
        stops: List[ScheduledStop],
    ) -> Tuple[
        Optional[Tuple[FleetVehicle, List[ScheduledStop], List[StopAction], int, int, float, float, int]],
        List[str],
        Optional[str],
    ]:
        """Validate vehicle allowance + schedule + format stops/actions for one route."""
        wrapped, failed_orders, fail_diag = self._prepare_scheduled_route_with_timeline(
            v_idx, stops
        )
        if wrapped is None:
            return None, failed_orders, fail_diag
        return wrapped[0], [], None

    def _finalize_optimized_route(
        self,
        v: FleetVehicle,
        formatted_stops: List[ScheduledStop],
        route_start_sec: int,
        route_end_sec: int,
        route_dist_km: float,
        route_dur_min: float,
        return_travel_sec: int,
        spatial_res: Optional[SpatialValidationResult],
        *,
        nodes: Optional[List[Dict[str, Any]]] = None,
        timeline: Optional[ScheduledTimelineResult] = None,
    ) -> OptimizedRoute:
        eco_nodes = nodes if nodes is not None else self._economic_nodes()
        order_by_id = self.order_by_id
        base_fuel, load_fuel, holding_cost, ton_km, ton_hrs = calculate_route_economic_metrics(
            self.request, eco_nodes, order_by_id, v, formatted_stops
        )
        fuel_cost = base_fuel + load_fuel
        late_penalty = sum(
            calculate_late_delivery_penalty(
                order_by_id[stop.allocation_id or stop.order_id],
                stop.arrival_time_sec,
                self.policy,
            )
            for stop in formatted_stops
            if stop.stop_type == "DELIVERY"
            and (stop.allocation_id or stop.order_id) in order_by_id
        )
        v_idx = next(
            (idx for idx, veh in enumerate(self.vehicles) if veh.id == v.id),
            None,
        )
        end_node_idx = (
            resolve_vehicle_end_node_index(self.vehicles, self.orders, v_idx, v)
            if v_idx is not None
            else None
        )
        toll_cost_vnd = (
            calculate_route_toll_vnd(
                getattr(self.request, "toll_matrix_vnd", None),
                v_idx,
                v,
                formatted_stops,
                self._stop_node_index,
                end_node_index=end_node_idx,
            )
            if v_idx is not None
            else 0
        )
        overnight_allowance_vnd = calculate_route_overnight_allowance_vnd(
            list(timeline.rest_breaks) if timeline is not None else (),
            getattr(self.policy, "driving_rest_policy", None),
        )
        step_balances = [
            st.weight_balance
            for st in (spatial_res.step_states if spatial_res is not None else ())
            if getattr(st, "weight_balance", None) is not None
        ]
        weight_balance_penalty_vnd = calculate_route_weight_balance_penalty_vnd(
            step_balances,
            self.policy,
            getattr(self.request, "demo_stacking", None),
        )
        total_driving_sec = (
            timeline.total_driving_sec
            if timeline is not None
            else (
                sum(int(getattr(st, "travel_time_sec", 0) or 0) for st in formatted_stops)
                + int(return_travel_sec or 0)
            )
        )
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
            toll_cost_vnd=toll_cost_vnd,
            overnight_allowance_vnd=overnight_allowance_vnd,
            weight_balance_penalty_vnd=weight_balance_penalty_vnd,
            total_cost_vnd=(
                fuel_cost
                + v.fixed_operating_cost_vnd
                + holding_cost
                + late_penalty
                + toll_cost_vnd
                + overnight_allowance_vnd
                + weight_balance_penalty_vnd
            ),
        )
        end_location = resolve_vehicle_end_location(v, formatted_stops, order_by_id)
        return OptimizedRoute(
            route_id=v.id,
            vehicle_id=v.source_vehicle_id or v.id,
            plate_number=v.plate_number,
            vehicle_length_cm=v.length_cm,
            vehicle_width_cm=v.width_cm,
            vehicle_height_cm=v.height_cm,
            service_day_index=v.service_day_index,
            start_time_sec=route_start_sec,
            end_time_sec=route_end_sec,
            total_distance_km=round(route_dist_km, 2),
            total_duration_minutes=route_dur_min,
            return_travel_time_sec=return_travel_sec,
            return_waiting_time_sec=(
                timeline.return_waiting_time_sec if timeline is not None else 0
            ),
            mandatory_rest_sec=(
                timeline.mandatory_rest_sec if timeline is not None else 0
            ),
            total_driving_sec=total_driving_sec,
            rest_breaks=list(timeline.rest_breaks) if timeline is not None else [],
            province_hops=list(timeline.province_hops) if timeline is not None else [],
            depot=v.depot,
            end_location=end_location,
            stops=formatted_stops,
            spatial_validation=spatial_res,
            cost=cost_bd,
        )

    def build_pool_route_stub(
        self, v_idx: int, stops: List[ScheduledStop]
    ) -> Optional[OptimizedRoute]:
        """Build a production-priced route stub without full SpatialValidator audit."""
        if not stops or v_idx < 0 or v_idx >= len(self.vehicles):
            return None
        wrapped, _unassigned, _diag = self._prepare_scheduled_route_with_timeline(v_idx, stops)
        if wrapped is None:
            return None
        prepared, timeline = wrapped
        (
            v,
            formatted_stops,
            _stop_actions,
            route_start_sec,
            route_end_sec,
            route_dist_km,
            route_dur_min,
            return_travel_sec,
        ) = prepared
        return self._finalize_optimized_route(
            v,
            formatted_stops,
            route_start_sec,
            route_end_sec,
            route_dist_km,
            route_dur_min,
            return_travel_sec,
            SpatialValidationResult(
                is_valid=False,
                violation_code="UNAUDITED_POOL_STUB",
                error_message="Tuyến ứng viên từ bể ALNS chưa audit 3D.",
                step_states=[],
            ),
            timeline=timeline,
        )

    def audit_pool_route_stub(
        self,
        v_idx: int,
        stops: List[ScheduledStop],
        *,
        max_time_seconds: float = 0.8,
    ) -> Optional[OptimizedRoute]:
        """Run full production SpatialValidator audit on a single selected pool stub."""
        if not stops or v_idx < 0 or v_idx >= len(self.vehicles):
            return None
        wrapped, _unassigned, _diag = self._prepare_scheduled_route_with_timeline(v_idx, stops)
        if wrapped is None:
            return None
        prepared, timeline = wrapped
        (
            v,
            formatted_stops,
            stop_actions,
            route_start_sec,
            route_end_sec,
            route_dist_km,
            route_dur_min,
            return_travel_sec,
        ) = prepared
        spatial_res = self._validate_spatial_actions(
            v_idx, stop_actions, max_time_seconds=max_time_seconds
        )
        if self.request.demo_stacking is not None:
            formatted_stops = sync_route_stacking_unloads(formatted_stops, spatial_res)
        if not spatial_res.is_valid:
            return None
        return self._finalize_optimized_route(
            v,
            formatted_stops,
            route_start_sec,
            route_end_sec,
            route_dist_km,
            route_dur_min,
            return_travel_sec,
            spatial_res,
            timeline=timeline,
        )

    def _build_final_response(
        self,
        routes_stops: List[List[ScheduledStop]],
        unassigned_ids: List[str],
        *,
        include_benchmarks: bool = True,
        spatial_time_budget_seconds: Optional[float] = None,
        audited_direct_trips: Optional[Dict[str, List[OptimizedRoute]]] = None,
        polish_checkpoint: Optional[Tuple[float, FleetOptimizationResponse]] = None,
        absolute_spatial_deadline: Optional[float] = None,
    ) -> FleetOptimizationResponse:
        optimized_routes: List[OptimizedRoute] = []
        total_dist_km = 0.0
        total_dur_min = 0.0
        total_cost_vnd = 0
        final_unassigned_ids = list(dict.fromkeys(unassigned_ids))
        diagnostics: List[str] = []
        salvage_budget_exhausted = False

        split_groups: Dict[str, Set[str]] = {}
        for o in self.orders:
            if o.split_group_id:
                split_groups.setdefault(o.split_group_id, set()).add(o.id)
        if split_groups:
            assigned_in_stops = {
                stop.allocation_id or stop.order_id
                for stops in routes_stops
                for stop in stops
                if stop.stop_type == "PICKUP" and (stop.allocation_id or stop.order_id)
            } - set(final_unassigned_ids)
            incomplete_split_ids: Set[str] = set()
            for group_ids in split_groups.values():
                if group_ids.intersection(assigned_in_stops) and not group_ids.issubset(
                    assigned_in_stops
                ):
                    incomplete_split_ids.update(group_ids)
            if incomplete_split_ids:
                routes_stops = [
                    [
                        st
                        for st in stops
                        if (st.allocation_id or st.order_id) not in incomplete_split_ids
                    ]
                    for stops in routes_stops
                ]
                for oid in incomplete_split_ids:
                    if oid not in final_unassigned_ids:
                        final_unassigned_ids.append(oid)
                diagnostics.append(
                    "Thu hồi phần đơn tách chưa được phân bổ đủ kiện (all-or-nothing split policy)."
                )

        order_by_id = self.order_by_id
        nodes = self._economic_nodes()

        spatial_deadline = (
            time.perf_counter() + spatial_time_budget_seconds
            if spatial_time_budget_seconds is not None
            else None
        )
        if polish_checkpoint is not None:
            spatial_deadline = polish_checkpoint[0]
        if absolute_spatial_deadline is not None:
            spatial_deadline = (
                min(spatial_deadline, absolute_spatial_deadline)
                if spatial_deadline is not None else absolute_spatial_deadline
            )
        has_multi_order_route = any(
            sum(1 for stop in stops if stop.stop_type == "PICKUP") >= 2
            for stops in routes_stops
            if stops
        )
        salvage_ratio = 0.25 if has_multi_order_route else 0.12
        salvage_reserve = (
            min(4.0, spatial_time_budget_seconds * salvage_ratio)
            if polish_checkpoint is None
            and spatial_time_budget_seconds is not None
            and spatial_time_budget_seconds >= 3.0
            else 0.0
        )
        route_audit_deadline = (
            spatial_deadline - salvage_reserve
            if spatial_deadline is not None
            else None
        )
        route_item_counts = {
            v_idx: sum(
                len(order_by_id[stop.allocation_id or stop.order_id].items)
                for stop in stops
                if stop.stop_type == "PICKUP"
                and (stop.allocation_id or stop.order_id) in order_by_id
            )
            for v_idx, stops in enumerate(routes_stops)
            if stops
        }
        remaining_route_items = dict(route_item_counts)

        for v_idx, stops in enumerate(routes_stops):
            if not stops:
                continue
            route_items = route_item_counts.get(v_idx, 0)
            if polish_checkpoint is not None and time.perf_counter() >= polish_checkpoint[0]:
                return polish_checkpoint[1]
            wrapped, failed_orders, fail_diag = self._prepare_scheduled_route_with_timeline(v_idx, stops)
            if wrapped is None:
                v = self.vehicles[v_idx]
                final_unassigned_ids.extend(failed_orders)
                remaining_route_items.pop(v_idx, None)
                if fail_diag:
                    diagnostics.append(fail_diag)
                continue
            prepared, timeline = wrapped
            (
                v,
                formatted_stops,
                stop_actions,
                route_start_sec,
                route_end_sec,
                route_dist_km,
                route_dur_min,
                return_travel_sec,
            ) = prepared

            # Spatial validation using production validator
            spatial_route_budget = None
            if route_audit_deadline is not None:
                remaining_seconds = max(
                    0.01, route_audit_deadline - time.perf_counter()
                )
                remaining_route_count = len(remaining_route_items)
                uniform_share = remaining_seconds / max(1, min(remaining_route_count, 8))
                weighted_share = 0.0
                if route_items >= 40:
                    remaining_heavy_items = sum(
                        cnt for cnt in remaining_route_items.values() if cnt >= 40
                    )
                    light_routes = sum(
                        1 for cnt in remaining_route_items.values() if cnt < 40
                    )
                    reserve_for_light = min(remaining_seconds * 0.20, light_routes * 0.03)
                    available_for_heavy = max(0.35, remaining_seconds - reserve_for_light)
                    weighted_share = available_for_heavy * (
                        route_items / max(1, remaining_heavy_items)
                    )
                elif route_items >= 20:
                    total_rem_items = sum(remaining_route_items.values())
                    weighted_share = remaining_seconds * (route_items / max(1, total_rem_items))
                max_route_cap = 3.0 if route_items >= 80 else (2.0 if route_items >= 40 else 1.2)
                spatial_route_budget = min(
                    max_route_cap,
                    max(0.35, uniform_share, weighted_share),
                )
            spatial_res = self._join_direct_cycles(audited_direct_trips.get(v.id, []), formatted_stops) if audited_direct_trips else None
            if spatial_res is None:
                if polish_checkpoint is not None:
                    remaining = spatial_deadline - time.perf_counter()
                    if remaining <= 0:
                        return polish_checkpoint[1]
                    spatial_route_budget = min(spatial_route_budget, remaining)
                if absolute_spatial_deadline is not None:
                    spatial_route_budget = min(
                        spatial_route_budget, max(0.0, route_audit_deadline - time.perf_counter())
                    )
                if spatial_route_budget == 0.0:
                    spatial_res = SpatialValidationResult(
                        is_valid=False, violation_code="PLACEMENT_SEARCH_LIMIT_REACHED",
                    )
                else:
                    spatial_res = self._validate_spatial_actions(
                        v_idx, stop_actions, max_time_seconds=spatial_route_budget,
                    )
            if polish_checkpoint is not None and time.perf_counter() >= polish_checkpoint[0]:
                return polish_checkpoint[1]
            if self.request.demo_stacking is not None:
                formatted_stops = sync_route_stacking_unloads(formatted_stops, spatial_res)
            remaining_route_items.pop(v_idx, None)
            if not spatial_res.is_valid:
                if polish_checkpoint is not None:
                    return polish_checkpoint[1]
                final_unassigned_ids.extend(
                    stop.allocation_id or stop.order_id
                    for stop in formatted_stops
                    if stop.stop_type == "PICKUP"
                    and (stop.allocation_id or stop.order_id)
                )
                diagnostics.append(
                    f"Bộ tìm kiếm loại tuyến {v.plate_number}: "
                    f"{spatial_res.error_message or spatial_res.violation_code or 'bố trí không hợp lệ'}."
                )
                continue

            opt_route = self._finalize_optimized_route(
                v,
                formatted_stops,
                route_start_sec,
                route_end_sec,
                route_dist_km,
                route_dur_min,
                return_travel_sec,
                spatial_res,
                nodes=nodes,
                timeline=timeline,
            )
            optimized_routes.append(opt_route)

            total_dist_km += route_dist_km
            total_dur_min += route_dur_min

        # 3.5. Salvage unassigned orders to available empty vehicles
        if polish_checkpoint is not None and final_unassigned_ids:
            return polish_checkpoint[1]
        if final_unassigned_ids:
            used_v_indices = {
                idx
                for idx, v in enumerate(self.vehicles)
                if any(r.route_id == v.id for r in optimized_routes)
            }
            unassigned_candidates = [
                oid for oid in final_unassigned_ids if oid in self.order_by_id
            ]
            unassigned_candidates.sort(
                key=lambda oid: (
                    sum(it.weight_kg for it in self.order_by_id[oid].items),
                    sum(it.length_cm * it.width_cm for it in self.order_by_id[oid].items),
                ),
                reverse=True,
            )
            salvaged_order_ids: Set[str] = set()

            # Không salvage đơn lẻ nếu nó thuộc về một split group không khả thi
            incomplete_split_groups: Set[str] = set()
            for gid, member_ids in split_groups.items():
                assigned_members = {
                    st.allocation_id or st.order_id
                    for r in optimized_routes
                    for st in r.stops
                    if st.stop_type == "PICKUP" and (st.allocation_id or st.order_id) in member_ids
                }
                unassigned_members = member_ids - assigned_members
                if unassigned_members and not unassigned_members.issubset(set(unassigned_candidates)):
                    incomplete_split_groups.add(gid)

            active_max_day = max(
                (self.vehicles[idx].service_day_index for idx in used_v_indices),
                default=0,
            )
            empty_vehicle_order = sorted(
                range(len(self.vehicles)),
                key=lambda idx: (
                    1 if self.vehicles[idx].service_day_index > active_max_day else 0,
                    self.vehicles[idx].service_day_index,
                    -self.vehicles[idx].payload_limit_kg,
                    -(
                        self.vehicles[idx].length_cm
                        * self.vehicles[idx].width_cm
                        * self.vehicles[idx].height_cm
                    ),
                ),
            )
            for empty_v_idx in empty_vehicle_order:
                v = self.vehicles[empty_v_idx]
                if spatial_deadline is not None and time.perf_counter() >= spatial_deadline:
                    salvage_budget_exhausted = True
                    break
                if empty_v_idx in used_v_indices or not self._vehicle_has_compatible_driver(v):
                    continue
                phys_id = v.source_vehicle_id or v.id
                rest_gap, _ = resolve_rest_policy_limits(
                    getattr(self.policy, "driving_rest_policy", None)
                )
                if any(
                    (
                        r.vehicle_id == phys_id
                        and (
                            r.service_day_index == v.service_day_index
                            or (
                                v.available_start_sec < r.end_time_sec + rest_gap
                                and r.start_time_sec < v.available_end_sec + rest_gap
                            )
                        )
                    )
                    for r in optimized_routes
                ):
                    continue
                max_routes = getattr(self.request.policy, "max_routes_per_day", None)
                if (
                    max_routes is not None
                    and sum(
                        1
                        for idx in used_v_indices
                        if self.vehicles[idx].service_day_index == v.service_day_index
                    )
                    >= max_routes
                ):
                    continue
                current_salvaged_stops: List[ScheduledStop] = []
                validated_schedule = None
                consecutive_failures = 0
                for oid in unassigned_candidates:
                    if spatial_deadline is not None and time.perf_counter() >= spatial_deadline:
                        salvage_budget_exhausted = True
                        break
                    if oid in salvaged_order_ids:
                        continue
                    order_obj = self.order_by_id[oid]
                    if order_obj.split_group_id and order_obj.split_group_id in incomplete_split_groups:
                        continue
                    if not self._order_allows_vehicle(order_obj, v):
                        continue
                    p_stop = ScheduledStop(
                        sequence=0,
                        stop_type="PICKUP",
                        location_id=order_obj.pickup_location.id,
                        location_name=order_obj.pickup_location.name or "Pickup",
                        order_id=order_obj.id,
                        allocation_id=order_obj.id,
                        latitude=order_obj.pickup_location.latitude,
                        longitude=order_obj.pickup_location.longitude,
                        arrival_time_sec=0,
                        departure_time_sec=0,
                        items_loaded=[it.id for it in order_obj.items],
                        items_unloaded=[],
                    )
                    d_stop = ScheduledStop(
                        sequence=0,
                        stop_type="DELIVERY",
                        location_id=order_obj.delivery_location.id,
                        location_name=order_obj.delivery_location.name or "Delivery",
                        order_id=order_obj.id,
                        allocation_id=order_obj.id,
                        latitude=order_obj.delivery_location.latitude,
                        longitude=order_obj.delivery_location.longitude,
                        arrival_time_sec=0,
                        departure_time_sec=0,
                        items_loaded=[],
                        items_unloaded=[it.id for it in order_obj.items],
                    )
                    test_stops = current_salvaged_stops + [p_stop, d_stop]
                    sched_test = self._schedule_stops(empty_v_idx, test_stops)
                    if sched_test is None:
                        continue
                    test_actions = []
                    for s_idx, st in enumerate(sched_test[0], start=1):
                        items_load = [
                            self._spatial_cargo_item(item_id)
                            for item_id in st.items_loaded
                            if item_id in self.cargo_by_id
                        ]
                        test_actions.append(
                            StopAction(
                                stop_id=st.location_id,
                                sequence=s_idx,
                                stop_type=st.stop_type,
                                address=st.location_name,
                                items_to_load=items_load,
                                items_to_unload=st.items_unloaded,
                            )
                        )
                    per_try_cap = 0.4 if current_salvaged_stops else 0.8
                    remaining = per_try_cap if spatial_deadline is None else min(per_try_cap, spatial_deadline - time.perf_counter())
                    if remaining <= 0:
                        salvage_budget_exhausted = True
                        break
                    sp_test = self._validate_spatial_actions(empty_v_idx, test_actions, max_time_seconds=remaining)
                    if sp_test.is_valid:
                        current_salvaged_stops = list(sched_test[0])
                        validated_schedule = (sched_test, sp_test)
                        salvaged_order_ids.add(oid)
                        consecutive_failures = 0
                    elif current_salvaged_stops:
                        consecutive_failures += 1
                        if consecutive_failures >= 2:
                            break

                if validated_schedule is not None:
                    wrapped_s, _, _ = self._prepare_scheduled_route_with_timeline(
                        empty_v_idx, current_salvaged_stops
                    )
                    if wrapped_s is None:
                        continue
                    prepared_s, timeline_s = wrapped_s
                    (
                        _v_s,
                        f_stops,
                        _actions_s,
                        r_start,
                        r_end,
                        r_dist,
                        r_dur,
                        r_ret,
                    ) = prepared_s
                    used_v_indices.add(empty_v_idx)
                    sp_final = validated_schedule[1]
                    if self.request.demo_stacking is not None:
                        f_stops = sync_route_stacking_unloads(f_stops, sp_final)
                    opt_r = self._finalize_optimized_route(
                        v,
                        f_stops,
                        r_start,
                        r_end,
                        r_dist,
                        r_dur,
                        r_ret,
                        sp_final,
                        nodes=nodes,
                        timeline=timeline_s,
                    )
                    optimized_routes.append(opt_r)
                    total_dist_km += r_dist
                    total_dur_min += r_dur
                    diagnostics.append(
                        f"Đã mở thêm xe trống {v.plate_number} cứu thành công {len(current_salvaged_stops)//2} đơn hàng."
                    )

            final_unassigned_ids = [oid for oid in final_unassigned_ids if oid not in salvaged_order_ids]

        # Phòng thủ trước split_groups: loại bỏ tuyến trùng lịch xe vật lý xuyên ngày / chưa đủ nghỉ giữa 2 chuyến
        if len(optimized_routes) > 1:
            rest_gap, max_weekly_driving = resolve_rest_policy_limits(
                getattr(self.policy, "driving_rest_policy", None)
            )
            vehicle_by_id_map = {v.id: v for v in self.vehicles}
            driver_by_id_map = {d.id: d for d in self.request.drivers}
            accepted_routes: List[OptimizedRoute] = []
            dropped_for_overlap = False
            for r in sorted(
                optimized_routes,
                key=lambda rt: (rt.service_day_index, rt.start_time_sec, rt.end_time_sec, rt.route_id or rt.vehicle_id),
            ):
                if check_cross_day_resource_conflicts(
                    accepted_routes + [r],
                    vehicle_by_id_map,
                    min_inter_trip_rest_sec=rest_gap,
                    max_weekly_driving_sec=max_weekly_driving,
                    driver_by_id=driver_by_id_map,
                ):
                    dropped_for_overlap = True
                    for st in r.stops:
                        oid = st.allocation_id or st.order_id
                        if st.stop_type == "PICKUP" and oid and oid not in final_unassigned_ids:
                            final_unassigned_ids.append(oid)
                else:
                    accepted_routes.append(r)
            if dropped_for_overlap:
                optimized_routes = accepted_routes
                total_dist_km = sum(r.total_distance_km for r in optimized_routes)
                total_dur_min = sum(r.total_duration_minutes for r in optimized_routes)
                diagnostics.append(
                    "Đã thu hồi tuyến trùng lịch xe vật lý xuyên ngày hoặc chưa đủ thời gian nghỉ giữa chuyến."
                )

        # Kiểm tra all-or-nothing cho split_groups trên toàn bộ optimized_routes
        if split_groups:
            assigned_members = {
                st.allocation_id or st.order_id
                for r in optimized_routes
                for st in r.stops
                if st.stop_type == "PICKUP"
            }
            broken_split_oids: Set[str] = set()
            for gid, member_ids in split_groups.items():
                m_served = member_ids.intersection(assigned_members)
                if m_served and len(m_served) < len(member_ids):
                    broken_split_oids.update(member_ids)

            if broken_split_oids:
                filtered_routes = []
                for r in optimized_routes:
                    route_oids = {
                        st.allocation_id or st.order_id
                        for st in r.stops
                        if st.stop_type == "PICKUP"
                    }
                    if route_oids.intersection(broken_split_oids):
                        for oid in route_oids:
                            if oid not in final_unassigned_ids:
                                final_unassigned_ids.append(oid)
                    else:
                        filtered_routes.append(r)
                optimized_routes = filtered_routes
                total_dist_km = sum(r.total_distance_km for r in optimized_routes)
                total_dur_min = sum(r.total_duration_minutes for r in optimized_routes)
                diagnostics.append(
                    "Đã hủy bỏ các tuyến chứa đơn tách chưa được giao đủ tất cả các phần (all-or-nothing split policy)."
                )

        # 4. Optimal Driver Assignment (Hungarian Algorithm < 1ms)
        driver_matcher = DriverMatcher(self.request)
        optimized_routes = driver_matcher.assign_drivers_to_routes(optimized_routes)

        for r in optimized_routes:
            if r.cost:
                total_cost_vnd += r.cost.total_cost_vnd

        final_unassigned_ids = list(dict.fromkeys(final_unassigned_ids))
        unassigned_objects: List[UnassignedOrder] = []
        seen_unassigned_sources: Set[str] = set()
        for oid in final_unassigned_ids:
            ord_obj = self.order_by_id.get(oid)
            source_id = (ord_obj.source_order_id or ord_obj.id) if ord_obj else oid
            if source_id in seen_unassigned_sources:
                continue
            seen_unassigned_sources.add(source_id)
            num_str = (
                (ord_obj.source_order_number or ord_obj.order_number)
                if ord_obj
                else oid
            )
            unassigned_objects.append(
                UnassignedOrder(
                    order_id=source_id,
                    order_number=num_str,
                    reason_code="UNASSIGNED",
                    reason_message=(
                        "Chưa có tuyến đã kiểm chứng cho đơn này. Lượt thử ghép các đơn còn lại đã hết thời gian."
                        if salvage_budget_exhausted
                        else "Chưa có tuyến đã kiểm chứng cho đơn này. Chưa xác định được ràng buộc cụ thể."
                    ),
                )
            )

        status_str = (
            "SUCCESS"
            if not unassigned_objects
            else "PARTIAL"
            if optimized_routes
            else "TIMEOUT"
            if salvage_budget_exhausted
            else "INFEASIBLE"
        )

        # 5. Compute Direct Dedicated Baseline Comparison
        benchmarks = None
        if include_benchmarks:
            try:
                calc = BaselineCostCalculator(self.request, nodes)
                benchmarks = calc.build_comparison(
                    optimized_routes,
                    total_cost_vnd,
                    round(total_dist_km, 2),
                    round(total_dur_min, 2),
                    ortools_is_feasible=(status_str == "SUCCESS"),
                )
            except Exception as error:
                diagnostics.append(f"Không tính được benchmark phương án: {error}")

        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status=status_str,
            routes=optimized_routes,
            unassigned_orders=unassigned_objects,
            total_distance_km=round(total_dist_km, 2),
            total_duration_minutes=round(total_dur_min, 2),
            total_cost_vnd=total_cost_vnd,
            benchmarks=benchmarks,
            diagnostics=diagnostics
            + [
                f"ALNS hoàn tất: {len(optimized_routes)} tuyến hợp lệ, "
                f"{len(unassigned_objects)} đơn chưa phân công."
            ],
        )
