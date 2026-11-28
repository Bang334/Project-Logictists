from collections import defaultdict
from dataclasses import dataclass, field
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .interprovincial import (
    estimate_driving_rest_lower_bound_sec,
    extract_province_hops,
    is_driver_compatible_with_vehicle,
    is_order_compatible_with_vehicle_and_warehouses,
    is_rest_policy_enabled,
    location_identity,
    needs_interprovincial_timeline,
    resolve_vehicle_end_location,
    resolve_vehicle_end_node_index,
    schedule_route_timeline,
    stop_effective_service_seconds,
)
from .models import (
    BenchmarkComparisonResponse,
    BenchmarkMetric,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    OptimizedRoute,
    OrderPair,
    RestBreakRecord,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    advance_past_curfews,
    can_driver_drive_vehicle,
)
from .packing_rules import resolve_can_rotate
from .planning_objective import calendar_salary_for_span, operational_late_penalty_for_stops
from .route_costing import build_route_cost_breakdown
from .spatial_validator import SpatialValidator
from .stacking import (
    effective_floor_capacity_cm2,
    enforce_spatial_weight_balance_if_needed,
    sync_route_stacking_unloads,
    validate_stop_actions,
)

DIRECT_DESCRIPTION = "Mỗi chuyến chở một đơn. Xe và tài xế có thể chạy nhiều chuyến nối tiếp trong ca."


@dataclass
class _EvaluatedRoute:
    vehicle: FleetVehicle
    stops: List[ScheduledStop]
    distance_meters: float
    duration_seconds: float
    start_time_sec: int
    spatial_validation: Optional[SpatialValidationResult] = None
    violations: List[str] = field(default_factory=list)
    return_travel_time_sec: int = 0
    return_waiting_time_sec: int = 0
    mandatory_rest_sec: int = 0
    total_driving_sec: int = 0
    rest_breaks: List[RestBreakRecord] = field(default_factory=list)
    province_hops: List[str] = field(default_factory=list)


class _DirectRoutingTimeout(TimeoutError):
    """The routing search used its slice before finding a first schedule."""


class BaselineCostCalculator:
    """Build comparable baselines using the production feasibility rules."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        nodes: List[dict],
        *,
        deadline: Optional[float] = None,
        cancel_event: Optional[Any] = None,
    ):
        self.deadline = deadline
        self.cancel_event = cancel_event
        self.request = request
        self.nodes = nodes
        self.vehicles = request.vehicles
        self.drivers = request.drivers
        self.orders = request.orders
        self.order_by_id = {order.id: order for order in request.orders}
        self.item_weight_by_id = {item.id: item.weight_kg for order in self.orders for item in order.items}
        self._spatial_cache: Dict[Tuple, SpatialValidationResult] = {}

    def _remaining_seconds(self) -> Optional[float]:
        if self.cancel_event is not None and self.cancel_event.is_set():
            raise TimeoutError("Job tối ưu đã bị hủy")
        if self.deadline is None:
            return None
        remaining = self.deadline - time.perf_counter()
        if remaining <= 0:
            raise TimeoutError("Hết thời gian tính phương án đối chuẩn")
        return remaining

    @staticmethod
    def _actions_for_order(order: OrderPair) -> List[StopAction]:
        return [
            StopAction(
                stop_id=order.pickup_location.id,
                sequence=1,
                stop_type="PICKUP",
                address=order.pickup_location.name,
                latitude=order.pickup_location.latitude,
                longitude=order.pickup_location.longitude,
                items_to_load=order.items,
            ),
            StopAction(
                stop_id=order.delivery_location.id,
                sequence=2,
                stop_type="DELIVERY",
                address=order.delivery_location.name,
                latitude=order.delivery_location.latitude,
                longitude=order.delivery_location.longitude,
                items_to_unload=[item.id for item in order.items],
            ),
        ]

    def _evaluate_actions(
        self,
        vehicle: FleetVehicle,
        vehicle_index: int,
        actions: List[StopAction],
        *,
        order_index: int,
        start_node_index: Optional[int] = None,
        start_time_sec: Optional[int] = None,
        return_to_depot: bool = True,
        spatial_time_limit_seconds: Optional[float] = None,
    ) -> _EvaluatedRoute:
        remaining = self._remaining_seconds()
        current_node = vehicle_index if start_node_index is None else start_node_index
        start_time = vehicle.available_start_sec if start_time_sec is None else start_time_sec
        current_time = start_time
        current_weight = 0.0
        total_distance = 0.0
        scheduled: List[ScheduledStop] = []
        violations: List[str] = []

        order = self.orders[order_index]
        if not is_order_compatible_with_vehicle_and_warehouses(order, vehicle):
            violations.append(
                f"COMPATIBILITY:{order.order_number} không tương thích xe hoặc kho"
            )
        pickup_index = len(self.vehicles) + 2 * order_index
        prev_loc_key: Optional[str] = None
        for action in actions:
            node_index = pickup_index if action.stop_type == "PICKUP" else pickup_index + 1
            travel_seconds = round(self.request.duration_matrix_seconds[current_node][node_index])
            leg_start = round(current_time)
            total_distance += self.request.distance_matrix_meters[current_node][node_index]
            physical_arrival = current_time + travel_seconds
            if action.stop_type == "PICKUP":
                window_start, window_end = order.pickup_window_start_sec, order.pickup_window_end_sec
                curfews = order.pickup_curfew_windows
            else:
                window_start, window_end = order.delivery_window_start_sec, order.delivery_window_end_sec
                curfews = order.delivery_curfew_windows
            loc_key_self = location_identity(
                order.pickup_location if action.stop_type == "PICKUP" else order.delivery_location
            )
            service_time_sec, prev_loc_key = stop_effective_service_seconds(
                order, action.stop_type, prev_loc_key or loc_key_self
            )
            arrival = advance_past_curfews(
                max(physical_arrival, float(window_start)),
                service_time_sec,
                vehicle.payload_limit_kg,
                curfews,
            )
            if arrival > window_end:
                violations.append(f"TIME_WINDOW:{order.order_number} vượt khung phục vụ tại điểm {action.stop_type}")
            if arrival > vehicle.available_end_sec:
                violations.append(
                    f"VEHICLE_AVAILABILITY:{vehicle.plate_number} vượt giờ khả dụng"
                )

            current_weight += sum(item.weight_kg for item in action.items_to_load)
            current_weight -= sum(
                self.item_weight_by_id.get(item_id, 0.0)
                for item_id in action.items_to_unload
            )
            if current_weight > vehicle.payload_limit_kg + 1e-6:
                violations.append(
                    f"PAYLOAD:{vehicle.plate_number} vượt tải trọng tại {order.order_number}"
                )
            if current_weight < -1e-6:
                violations.append(
                    f"LOAD_STATE:{order.order_number} dỡ kiện chưa có trên xe"
                )

            rounded_arrival = round(arrival)
            departure = rounded_arrival + service_time_sec
            scheduled.append(
                ScheduledStop(
                    sequence=len(scheduled) + 1,
                    location_id=action.stop_id,
                    location_name=action.address,
                    stop_type=action.stop_type,
                    order_id=order.source_order_id or order.id,
                    allocation_id=order.id,
                    order_stop_id=(order.pickup_location.source_location_id if action.stop_type == "PICKUP"
                                   else order.delivery_location.source_location_id) or action.stop_id,
                    latitude=action.latitude,
                    longitude=action.longitude,
                    arrival_time_sec=rounded_arrival,
                    departure_time_sec=departure,
                    travel_time_sec=max(0, round(physical_arrival) - leg_start),
                    waiting_time_sec=max(0, rounded_arrival - round(physical_arrival)),
                    service_time_sec=service_time_sec,
                    items_loaded=[item.id for item in action.items_to_load],
                    items_unloaded=action.items_to_unload,
                    current_weight_kg=round(max(0.0, current_weight), 3),
                )
            )
            current_time = departure
            current_node = node_index

        end_node_idx: Optional[int] = None
        return_travel = 0
        return_waiting = 0
        mandatory_rest_sec = 0
        total_driving_sec = 0
        rest_breaks: List[RestBreakRecord] = []
        if return_to_depot:
            end_node_idx = resolve_vehicle_end_node_index(
                self.vehicles, self.orders, vehicle_index, vehicle
            )
            if end_node_idx is not None:
                total_distance += self.request.distance_matrix_meters[current_node][end_node_idx]
                return_travel = round(self.request.duration_matrix_seconds[current_node][end_node_idx])
                current_time += return_travel
        total_driving_sec = (
            sum(int(getattr(st, "travel_time_sec", 0) or 0) for st in scheduled)
            + int(return_travel or 0)
        )
        if current_time > vehicle.available_end_sec and not violations:
            violations.append(f"VEHICLE_AVAILABILITY:{vehicle.plate_number} kết thúc chuyến sau giờ khả dụng")

        if not violations:
            rest_policy = getattr(self.request.policy, "driving_rest_policy", None)
            if needs_interprovincial_timeline(self.request, vehicle):
                timeline = schedule_route_timeline(
                    vehicle=vehicle,
                    vehicle_index=vehicle_index if start_node_index is None else start_node_index,
                    stops=scheduled,
                    order_by_id=self.order_by_id,
                    distance_matrix=self.request.distance_matrix_meters,
                    duration_matrix=self.request.duration_matrix_seconds,
                    stop_node_resolver=lambda s: (
                        pickup_index if s.stop_type == "PICKUP" else pickup_index + 1
                    ),
                    end_node_index=end_node_idx if return_to_depot else None,
                    rest_policy=rest_policy,
                    apply_jit_start=False,
                    initial_start_sec=start_time,
                )
                if not timeline.feasible:
                    violations.append(f"VEHICLE_AVAILABILITY:{timeline.reason}")
                else:
                    for idx_s, t_stop in enumerate(timeline.scheduled_stops):
                        scheduled[idx_s] = t_stop.model_copy(
                            update={"current_weight_kg": scheduled[idx_s].current_weight_kg}
                        )
                    current_time = timeline.route_end_sec
                    total_distance = timeline.total_distance_meters
                    return_travel = timeline.return_travel_time_sec
                    return_waiting = timeline.return_waiting_time_sec
                    mandatory_rest_sec = timeline.mandatory_rest_sec
                    total_driving_sec = timeline.total_driving_sec
                    rest_breaks = timeline.rest_breaks

        # Fast checks: Nếu đã vi phạm tải trọng, trạng thái dỡ hoặc thời gian, bỏ qua xếp dỡ hình học nặng
        if not violations:
            vehicle_floor_area = vehicle.length_cm * vehicle.width_cm
            # 1. Kiểm tra kích thước từng kiện so với thùng xe
            for action in actions:
                for item in action.items_to_load:
                    if item.height_cm > vehicle.height_cm + 1e-6:
                        violations.append(
                            f"SPATIAL:ITEM_EXCEEDS_VEHICLE_DIMENSIONS: Kiện [{item.id}] cao hơn chiều cao thùng xe"
                        )
                        break
                    min_item_dim = min(item.length_cm, item.width_cm)
                    max_item_dim = max(item.length_cm, item.width_cm)
                    if min_item_dim > max(vehicle.length_cm, vehicle.width_cm) + 1e-6 or max_item_dim > max(vehicle.length_cm, vehicle.width_cm) + 1e-6:
                        violations.append(
                            f"SPATIAL:ITEM_EXCEEDS_VEHICLE_DIMENSIONS: Kiện [{item.id}] có kích thước vượt sàn xe"
                        )
                        break
                if violations:
                    break

        if not violations:
            # 2. Kiểm tra diện tích chiếm dụng đồng thời tại các điểm dừng
            current_area = 0.0
            item_area_by_id = {
                item.id: item.length_cm * item.width_cm
                for action in actions
                for item in action.items_to_load
            }
            vehicle_floor_area = effective_floor_capacity_cm2(vehicle, self.request.demo_stacking)
            for action in actions:
                current_area += sum(item.length_cm * item.width_cm for item in action.items_to_load)
                current_area -= sum(item_area_by_id.get(item_id, 0.0) for item_id in action.items_to_unload)
                if current_area > vehicle_floor_area + 1e-6:
                    violations.append(
                        f"SPATIAL:FLOOR_AREA_EXCEEDED: Tổng diện tích hàng ({current_area:.0f}cm2) vượt diện tích sàn xe ({vehicle_floor_area:.0f}cm2)"
                    )
                    break

        # 3. Thẩm định hình học chi tiết (chỉ chạy khi chưa có vi phạm nào và giới hạn budget 2,000 nodes cho baseline)
        spatial = None
        if not violations:
            cache_key = (
                tuple(
                    (
                        a.stop_id,
                        a.stop_type,
                        tuple(item.id for item in a.items_to_load),
                        tuple(a.items_to_unload),
                    )
                    for a in actions
                ),
                vehicle.length_cm,
                vehicle.width_cm,
                vehicle.height_cm,
                vehicle.door_position,
                vehicle.door_width_cm,
                vehicle.payload_limit_kg,
            )
            if cache_key not in self._spatial_cache:
                time_limit = remaining
                if spatial_time_limit_seconds is not None:
                    time_limit = min(time_limit, spatial_time_limit_seconds) if time_limit is not None else spatial_time_limit_seconds
                raw_spatial = validate_stop_actions(
                    self.request.demo_stacking,
                    vehicle,
                    actions,
                    max_search_nodes=2000,
                    max_time_seconds=time_limit,
                )
                self._spatial_cache[cache_key] = enforce_spatial_weight_balance_if_needed(
                    self.request.demo_stacking,
                    raw_spatial,
                    cost_policy=self.request.policy,
                )
            spatial = self._spatial_cache[cache_key]
            if self.request.demo_stacking is not None:
                scheduled = sync_route_stacking_unloads(scheduled, spatial)
            if not spatial.is_valid:
                violations.append(f"SPATIAL:{spatial.error_message or spatial.violation_code or 'Bố trí xếp/dỡ không hợp lệ'}")
        resolved_end_loc = (
            resolve_vehicle_end_location(vehicle, scheduled, self.order_by_id)
            if return_to_depot
            else order.delivery_location
        )
        province_hops = extract_province_hops(
            vehicle, scheduled, self.order_by_id, resolved_end_loc
        )
        return _EvaluatedRoute(
            vehicle=vehicle,
            stops=scheduled,
            distance_meters=total_distance,
            duration_seconds=current_time - start_time,
            start_time_sec=start_time,
            spatial_validation=spatial,
            violations=violations,
            return_travel_time_sec=return_travel,
            return_waiting_time_sec=return_waiting,
            mandatory_rest_sec=mandatory_rest_sec,
            total_driving_sec=total_driving_sec,
            rest_breaks=rest_breaks,
            province_hops=province_hops,
        )

    @staticmethod
    def _is_driver_compatible(driver: DriverOption, vehicle: FleetVehicle) -> bool:
        return is_driver_compatible_with_vehicle(
            driver,
            vehicle.model_copy(update={"service_day_index": driver.service_day_index}),
        )

    def _route_cost(
        self, route: _EvaluatedRoute, driver: DriverOption,
        start_node_index: int, return_to_depot: bool,
    ) -> RouteCostBreakdown:
        step_balances = [
            st.weight_balance
            for st in (
                route.spatial_validation.step_states
                if route.spatial_validation is not None
                else ()
            )
            if getattr(st, "weight_balance", None) is not None
        ]
        return build_route_cost_breakdown(
            self.request,
            self.nodes,
            self.order_by_id,
            route.vehicle,
            driver,
            route.stops,
            route.distance_meters / 1000,
            route.duration_seconds / 60,
            start_node_index=start_node_index,
            return_to_depot=return_to_depot,
            rest_breaks=route.rest_breaks,
            step_balances=step_balances,
        )

    def _unavailable_direct(self, reason: str) -> BenchmarkMetric:
        return BenchmarkMetric(
            method_name="Direct Dedicated (Đơn lẻ)",
            description=DIRECT_DESCRIPTION,
            total_cost_vnd=0,
            total_distance_km=0,
            total_duration_minutes=0,
            vehicles_used=0,
            fuel_cost_vnd=0,
            vehicle_fixed_cost_vnd=0,
            driver_cost_vnd=0,
            cargo_holding_cost_vnd=0,
            late_delivery_penalty_vnd=0,
            is_feasible=False,
            violations=[reason],
        )

    def _calendar_salary_for_direct_span(
        self,
        planning_span_days: int,
        active_salary_vnd: int,
    ) -> int:
        if planning_span_days <= 0:
            return 0
        existing_max_day = max(
            (v.service_day_index for v in self.vehicles),
            default=0,
        )
        existing_span = existing_max_day + 1
        if planning_span_days <= existing_span:
            return max(
                active_salary_vnd,
                calendar_salary_for_span(self.request, planning_span_days),
            )
        base_cal = calendar_salary_for_span(self.request, existing_span)
        if base_cal <= 0:
            return active_salary_vnd
        prev_cal = (
            calendar_salary_for_span(self.request, existing_span - 1)
            if existing_span > 1
            else 0
        )
        daily_rate = max(0, base_cal - prev_cal) or round(base_cal / existing_span)
        extra_days = planning_span_days - existing_span
        return max(active_salary_vnd, base_cal + extra_days * daily_rate)

    def _pair_vehicles_with_drivers_by_day(
        self,
        vehicle_slots: List[Tuple[int, FleetVehicle]],
        driver_slots: List[DriverOption],
    ) -> List[Tuple[int, FleetVehicle, DriverOption]]:
        drivers_by_day: Dict[int, List[DriverOption]] = defaultdict(list)
        for driver in driver_slots:
            drivers_by_day[driver.service_day_index].append(driver)

        vehicles_by_day: Dict[int, List[Tuple[int, FleetVehicle]]] = defaultdict(list)
        for matrix_v_idx, vehicle in vehicle_slots:
            vehicles_by_day[vehicle.service_day_index].append((matrix_v_idx, vehicle))

        paired_slots: List[Tuple[int, FleetVehicle, DriverOption]] = []
        for day_idx, day_vehicles in sorted(vehicles_by_day.items()):
            day_drivers = drivers_by_day.get(day_idx, [])
            if not day_drivers:
                continue
            # Sort vehicles by most restrictive compatibility first (fewest compatible drivers, then largest payload)
            compat_drivers_map: Dict[str, List[DriverOption]] = {}
            for _, v in day_vehicles:
                compat = [
                    d for d in day_drivers if self._is_driver_compatible(d, v)
                ]
                compat.sort(
                    key=lambda d: (
                        d.fixed_salary_monthly_vnd,
                        d.trip_base_pay_vnd,
                        d.per_km_pay_vnd,
                        d.id,
                    )
                )
                compat_drivers_map[v.id] = compat

            ordered_vehicles = sorted(
                day_vehicles,
                key=lambda item: (
                    len(compat_drivers_map[item[1].id]),
                    -item[1].payload_limit_kg,
                    item[1].id,
                ),
            )
            used_driver_ids = set()
            used_vehicle_ids = set()
            for matrix_v_idx, v in ordered_vehicles:
                vehicle_id = v.source_vehicle_id or v.id
                if vehicle_id in used_vehicle_ids:
                    continue
                chosen_driver = next(
                    (
                        d
                        for d in compat_drivers_map[v.id]
                        if (d.source_driver_id or d.id) not in used_driver_ids
                    ),
                    None,
                )
                if chosen_driver is not None:
                    used_vehicle_ids.add(vehicle_id)
                    used_driver_ids.add(
                        chosen_driver.source_driver_id or chosen_driver.id
                    )
                    paired_slots.append((matrix_v_idx, v, chosen_driver))

        # A truck or driver with overlapping service slots cannot be assigned twice.
        next_vehicle_start: Dict[str, int] = {}
        next_driver_start: Dict[str, int] = {}
        non_overlapping = []
        for matrix_idx, vehicle, driver in sorted(paired_slots, key=lambda slot: slot[1].available_start_sec, reverse=True):
            vehicle_id = vehicle.source_vehicle_id or vehicle.id
            driver_id = driver.source_driver_id or driver.id
            end = min(vehicle.available_end_sec,
                      next_vehicle_start.get(vehicle_id, vehicle.available_end_sec),
                      next_driver_start.get(driver_id, vehicle.available_end_sec))
            if vehicle.available_start_sec < end:
                non_overlapping.append((matrix_idx, vehicle.model_copy(update={"available_end_sec": end}), driver))
                next_vehicle_start[vehicle_id] = vehicle.available_start_sec
                next_driver_start[driver_id] = vehicle.available_start_sec
        return list(reversed(non_overlapping))

    @staticmethod
    def _floor_profile(vehicle: FleetVehicle) -> Tuple:
        return (
            vehicle.length_cm, vehicle.width_cm, vehicle.height_cm, vehicle.payload_limit_kg,
            vehicle.door_position, vehicle.door_width_cm,
        )

    def _passes_direct_load_bounds(self, order: OrderPair, vehicle: FleetVehicle) -> bool:
        if sum(item.weight_kg for item in order.items) > vehicle.payload_limit_kg + 1e-6:
            return False
        if sum(item.length_cm * item.width_cm for item in order.items) > effective_floor_capacity_cm2(vehicle, self.request.demo_stacking) + 1e-6:
            return False
        return all(
            item.height_cm <= vehicle.height_cm + 1e-6
            and (
                (item.length_cm <= vehicle.length_cm + 1e-6 and item.width_cm <= vehicle.width_cm + 1e-6)
                or (
                    resolve_can_rotate(item)
                    and item.width_cm <= vehicle.length_cm + 1e-6
                    and item.length_cm <= vehicle.width_cm + 1e-6
                )
            )
            for item in order.items
        )

    def _solve_direct_schedule(
        self,
        paired_slots: List[Tuple[int, FleetVehicle, DriverOption]],
        rejected_loads: Set[Tuple[str, Tuple]],
        routing_budget_ms: int,
    ) -> Optional[List[OptimizedRoute]]:
        if not paired_slots:
            return None

        # Every pickup must be followed immediately by its own delivery. Between
        # orders, the empty vehicle drives directly to the next pickup.
        rest_policy = getattr(self.request.policy, "driving_rest_policy", None)
        rest_enabled = is_rest_policy_enabled(rest_policy)
        slot_count = len(paired_slots)
        matrix_nodes = [matrix_idx for matrix_idx, _, _ in paired_slots]
        service_seconds = [0] * slot_count
        order_actions = [self._actions_for_order(order) for order in self.orders]
        for order_index, (order, actions) in enumerate(zip(self.orders, order_actions)):
            pickup_index = len(self.vehicles) + 2 * order_index
            matrix_nodes.extend((pickup_index, pickup_index + 1))
            p_svc, p_key = stop_effective_service_seconds(order, actions[0].stop_type, None)
            d_svc, _ = stop_effective_service_seconds(order, actions[1].stop_type, p_key)
            service_seconds.append(p_svc)
            service_seconds.append(d_svc)
        order_node_end = len(matrix_nodes)

        def _order_transit(origin_node: int, dest_node: int) -> int:
            drive = round(self.request.duration_matrix_seconds[matrix_nodes[origin_node]][matrix_nodes[dest_node]])
            return drive + (estimate_driving_rest_lower_bound_sec(drive, rest_policy) if rest_enabled else 0)

        minimum_work = sum(
            service_seconds[node] + service_seconds[node + 1] + _order_transit(node, node + 1)
            for node in range(slot_count, order_node_end, 2)
        )
        if minimum_work > sum(vehicle.available_end_sec - vehicle.available_start_sec for _, vehicle, _ in paired_slots):
            return None

        start_nodes = list(range(slot_count))
        end_nodes: List[int] = []
        dummy_end_solver_node: Optional[int] = None
        for slot, (matrix_idx, vehicle, _) in enumerate(paired_slots):
            end_matrix_idx = resolve_vehicle_end_node_index(
                self.vehicles, self.orders, matrix_idx, vehicle
            )
            if end_matrix_idx is None:
                if dummy_end_solver_node is None:
                    dummy_end_solver_node = len(matrix_nodes)
                    matrix_nodes.append(-1)
                    service_seconds.append(0)
                end_nodes.append(dummy_end_solver_node)
            elif end_matrix_idx == matrix_idx:
                end_nodes.append(slot)
            else:
                solver_end = len(matrix_nodes)
                matrix_nodes.append(end_matrix_idx)
                service_seconds.append(0)
                end_nodes.append(solver_end)

        manager = pywrapcp.RoutingIndexManager(len(matrix_nodes), slot_count, start_nodes, end_nodes)
        routing = pywrapcp.RoutingModel(manager)
        durations = self.request.duration_matrix_seconds
        distances = self.request.distance_matrix_meters

        def travel(from_index: int, to_index: int) -> int:
            origin, destination = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
            if dummy_end_solver_node is not None and (destination == dummy_end_solver_node or origin == dummy_end_solver_node):
                return 0
            drive = round(durations[matrix_nodes[origin]][matrix_nodes[destination]])
            rest_lb = estimate_driving_rest_lower_bound_sec(drive, rest_policy) if rest_enabled else 0
            return service_seconds[origin] + drive + rest_lb

        horizon = max(vehicle.available_end_sec for _, vehicle, _ in paired_slots)
        time_index = routing.RegisterTransitCallback(travel)
        routing.AddDimension(time_index, horizon, horizon, False, "DirectShift")
        schedule = routing.GetDimensionOrDie("DirectShift")

        toll_matrix = getattr(self.request, "toll_matrix_vnd", None)
        for slot, (_, vehicle, driver) in enumerate(paired_slots):
            fuel_per_km = vehicle.fuel_consumption_liters_per_100_km * self.request.policy.fuel_price_per_liter_vnd / 100
            per_km = fuel_per_km + driver.per_km_pay_vnd
            trip_cost = vehicle.fixed_operating_cost_vnd + driver.trip_base_pay_vnd
            toll_factor = float(getattr(vehicle, "toll_factor", 1.0) or 1.0)

            def cost(
                from_index: int,
                to_index: int,
                rate: float = per_km,
                fixed: int = trip_cost,
                t_factor: float = toll_factor,
            ) -> int:
                origin, destination = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
                if dummy_end_solver_node is not None and (destination == dummy_end_solver_node or origin == dummy_end_solver_node):
                    return 0
                m_from = matrix_nodes[origin]
                m_to = matrix_nodes[destination]
                meters = distances[m_from][m_to]
                # Retain distance as a tie-breaker when different legs round to the same VND.
                arc_cost = round(meters * (rate + 1))
                if (
                    toll_matrix is not None
                    and m_from < len(toll_matrix)
                    and m_to < len(toll_matrix[m_from])
                ):
                    arc_cost += round(float(toll_matrix[m_from][m_to]) * t_factor * 1000)
                is_pickup = slot_count <= origin < order_node_end and (origin - slot_count) % 2 == 0
                return arc_cost + (fixed * 1000 if is_pickup else 0)

            routing.SetArcCostEvaluatorOfVehicle(routing.RegisterTransitCallback(cost), slot)
            day_penalty_vnd = max(
                5_000_000,
                min(50_000_000, self.request.policy.unassigned_order_penalty_vnd),
            )
            excess_day = max(0, vehicle.service_day_index - getattr(self, "_min_required_day", 0))
            day_delay_scaled = day_penalty_vnd * excess_day * 1000
            if day_delay_scaled > 0:
                routing.SetFixedCostOfVehicle(day_delay_scaled, slot)
            start, end = routing.Start(slot), routing.End(slot)
            schedule.CumulVar(start).SetValue(vehicle.available_start_sec)
            schedule.CumulVar(end).SetRange(vehicle.available_start_sec, vehicle.available_end_sec)
            routing.AddVariableMinimizedByFinalizer(schedule.CumulVar(end))

        for order_index, order in enumerate(self.orders):
            self._remaining_seconds()
            pickup_node = slot_count + order_index * 2
            pickup = manager.NodeToIndex(pickup_node)
            delivery = manager.NodeToIndex(pickup_node + 1)
            allowed = []
            profile_eligibility = {}
            pickup_service = service_seconds[pickup_node]
            delivery_service = service_seconds[pickup_node + 1]
            loaded_travel = round(durations[matrix_nodes[pickup_node]][matrix_nodes[pickup_node + 1]])
            loaded_rest = estimate_driving_rest_lower_bound_sec(loaded_travel, rest_policy) if rest_enabled else 0
            for slot, (_, vehicle, _) in enumerate(paired_slots):
                if not is_order_compatible_with_vehicle_and_warehouses(order, vehicle):
                    continue
                earliest_pickup = max(order.pickup_window_start_sec, vehicle.available_start_sec)
                earliest_delivery = max(
                    order.delivery_window_start_sec,
                    earliest_pickup + pickup_service + loaded_travel + loaded_rest,
                )
                if (earliest_pickup > order.pickup_window_end_sec
                    or earliest_delivery > order.delivery_window_end_sec
                    or earliest_delivery + delivery_service > vehicle.available_end_sec):
                    continue
                profile = self._floor_profile(vehicle)
                if (order.id, profile) in rejected_loads:
                    continue
                if profile not in profile_eligibility:
                    profile_eligibility[profile] = self._passes_direct_load_bounds(order, vehicle)
                if profile_eligibility[profile]:
                    allowed.append(slot)
            if not allowed or order.pickup_window_start_sec > horizon or order.delivery_window_start_sec > horizon:
                return None
            schedule.CumulVar(pickup).SetRange(order.pickup_window_start_sec, min(horizon, order.pickup_window_end_sec))
            schedule.CumulVar(delivery).SetRange(order.delivery_window_start_sec, min(horizon, order.delivery_window_end_sec))
            routing.VehicleVar(pickup).SetValues(allowed)
            routing.VehicleVar(delivery).SetValues(allowed)
            routing.AddPickupAndDelivery(pickup, delivery)
            routing.solver().Add(routing.NextVar(pickup) == delivery)

        params = pywrapcp.DefaultRoutingSearchParameters()
        params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
        params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        params.solution_limit = 20 if len(self.orders) >= 20 else 30
        remaining = self._remaining_seconds()
        params.time_limit.FromMilliseconds(routing_budget_ms if remaining is None else max(1, min(routing_budget_ms, int(remaining * 1000))))
        solution = routing.SolveWithParameters(params)
        if solution is None:
            if routing.status() == routing_enums_pb2.RoutingSearchStatus.ROUTING_FAIL_TIMEOUT:
                raise _DirectRoutingTimeout
            return None

        routes: List[OptimizedRoute] = []
        has_invalid_load = False
        for slot, (matrix_idx, vehicle, driver) in enumerate(paired_slots):
            index = solution.Value(routing.NextVar(routing.Start(slot)))
            departure = vehicle.available_start_sec
            start_point = vehicle.depot
            start_node = matrix_idx
            while not routing.IsEnd(index):
                pickup_node = manager.IndexToNode(index)
                order_index = (pickup_node - slot_count) // 2
                order = self.orders[order_index]
                delivery_index = solution.Value(routing.NextVar(index))
                index = solution.Value(routing.NextVar(delivery_index))
                last_trip = routing.IsEnd(index)
                should_return = last_trip and (
                    getattr(vehicle, "return_to_depot", True)
                    or vehicle.end_depot is not None
                )
                trip = self._evaluate_actions(vehicle, matrix_idx, order_actions[order_index], order_index=order_index,
                                              start_node_index=start_node, start_time_sec=departure,
                                              return_to_depot=should_return, spatial_time_limit_seconds=1.5)
                spatial = trip.spatial_validation
                if trip.violations or spatial is None or not spatial.is_valid:
                    if not trip.violations or not all(reason.startswith("SPATIAL:") for reason in trip.violations):
                        return None
                    rejected_loads.add((order.id, self._floor_profile(vehicle)))
                    has_invalid_load = True
                    departure += round(trip.duration_seconds)
                    start_point = order.delivery_location
                    start_node = matrix_nodes[pickup_node + 1]
                    continue
                end_time = departure + round(trip.duration_seconds)
                end_loc = (
                    resolve_vehicle_end_location(vehicle, trip.stops, self.order_by_id)
                    if last_trip
                    else order.delivery_location
                )
                routes.append(OptimizedRoute(
                    route_id=f"direct:{vehicle.id}:{order.id}",
                    vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                    service_day_index=vehicle.service_day_index,
                    start_time_sec=departure,
                    end_time_sec=end_time,
                    return_travel_time_sec=trip.return_travel_time_sec,
                    return_waiting_time_sec=trip.return_waiting_time_sec,
                    mandatory_rest_sec=trip.mandatory_rest_sec,
                    total_driving_sec=trip.total_driving_sec,
                    rest_breaks=trip.rest_breaks,
                    province_hops=trip.province_hops,
                    plate_number=vehicle.plate_number,
                    vehicle_length_cm=vehicle.length_cm,
                    vehicle_width_cm=vehicle.width_cm,
                    vehicle_height_cm=vehicle.height_cm,
                    driver_id=driver.source_driver_id or driver.id,
                    driver_name=driver.full_name,
                    driver_license_class=driver.license_class,
                    total_distance_km=trip.distance_meters / 1000,
                    total_duration_minutes=trip.duration_seconds / 60,
                    depot=start_point,
                    end_location=end_loc,
                    stops=trip.stops,
                    spatial_validation=spatial,
                    cost=self._route_cost(trip, driver, start_node, should_return),
                ))
                departure = end_time
                start_point = order.delivery_location
                start_node = matrix_nodes[pickup_node + 1]
        return None if has_invalid_load else routes

    def compute_direct_dedicated(self) -> BenchmarkMetric:
        """Schedule sequential single-order trips in the available truck and driver shifts."""
        if not self.orders or not self.vehicles or not self.drivers:
            return self._unavailable_direct("INPUT:Không có đủ đơn, xe hoặc tài xế để đối chuẩn")

        slots = self._pair_vehicles_with_drivers_by_day(list(enumerate(self.vehicles)), self.drivers)
        days = sorted({vehicle.service_day_index for _, vehicle, _ in slots})
        routes = None
        rejected_loads: Set[Tuple[str, Tuple]] = set()
        # Try up to 2 days first, add a midpoint horizon for 4+ day spans so
        # multi-week fleets do not jump straight to the full planning tail.
        if len(days) > 3:
            horizons = list(dict.fromkeys([*days[:2], days[len(days) // 2], days[-1]]))
        else:
            horizons = days[:2] + (days[-1:] if len(days) > 2 else [])
        search_timed_out = False
        self._min_required_day = 0
        try:
            for index, day_limit in enumerate(horizons):
                try:
                    self._remaining_seconds()
                    day_slots = [slot for slot in slots if slot[1].service_day_index <= day_limit]
                    is_last_horizon = index == len(horizons) - 1
                    while True:
                        prior_rejections = len(rejected_loads)
                        remaining = self._remaining_seconds()
                        budget_ms = 4500 if len(self.orders) >= 80 else 1500
                        full_budget_ms = budget_ms
                        if remaining is not None and len(self.orders) >= 80 and index > 0:
                            # Share the remaining time with later horizons and the cargo audit,
                            # capping only the final horizon's fast GLS polish (~6-11s) with retry fallback.
                            full_budget_ms = max(
                                1, int(remaining * 800 / (len(horizons) - index))
                            )
                            if is_last_horizon:
                                fast_cap_ms = max(
                                    6000, min(11_000, len(self.orders) * 60)
                                )
                                budget_ms = min(full_budget_ms, fast_cap_ms)
                            else:
                                budget_ms = full_budget_ms
                        try:
                            routes = self._solve_direct_schedule(day_slots, rejected_loads, budget_ms)
                        except _DirectRoutingTimeout:
                            if not (
                                len(self.orders) >= 80
                                and is_last_horizon
                                and budget_ms < full_budget_ms
                            ):
                                raise
                            retry_remaining = self._remaining_seconds()
                            if retry_remaining < 2.0:
                                raise
                            retry_budget_ms = max(1, int(retry_remaining * 800))
                            routes = self._solve_direct_schedule(day_slots, rejected_loads, retry_budget_ms)
                        if routes or len(rejected_loads) == prior_rejections:
                            break
                    self._remaining_seconds()
                except _DirectRoutingTimeout:
                    search_timed_out = True
                    self._min_required_day = day_limit + 1
                    continue
                except TimeoutError:
                    return self._unavailable_direct("TIMEOUT:Hết thời gian tính phương án đối chuẩn.")
                if routes:
                    break
                self._min_required_day = day_limit + 1
        finally:
            self._min_required_day = 0
        if not routes:
            if search_timed_out:
                return self._unavailable_direct("TIMEOUT:Chưa tìm được lịch đơn lẻ trong thời gian tìm kiếm.")
            return self._unavailable_direct("ASSIGNMENT_UNAVAILABLE:Chưa tìm được lịch chuyến đơn lẻ giao đủ trong các ca khả dụng.")

        costs = [route.cost for route in routes if route.cost is not None]
        fuel = sum(cost.fuel_cost_vnd for cost in costs)
        fixed = sum(cost.vehicle_fixed_cost_vnd for cost in costs)
        active_driver_salary = sum(
            cost.driver_fixed_salary_allocation_vnd for cost in costs
        )
        driver_trip_pay = sum(cost.driver_trip_pay_vnd for cost in costs)
        driver_cost = active_driver_salary + driver_trip_pay
        holding = sum(cost.cargo_holding_cost_vnd for cost in costs)
        late_penalty = sum(
            cost.late_delivery_penalty_vnd for cost in costs
        )
        total_route_cost_vnd = fuel + fixed + driver_cost + holding + late_penalty
        planning_span_days = (
            max((route.service_day_index for route in routes), default=0)
            + 1
        )
        physical_vehicle_count = len({route.vehicle_id for route in routes})
        calendar_salary_vnd = self._calendar_salary_for_direct_span(
            planning_span_days,
            active_driver_salary,
        )
        idle_salary_vnd = max(0, calendar_salary_vnd - active_driver_salary)
        operational_late_penalty_vnd = operational_late_penalty_for_stops(
            self.request,
            [route.stops for route in routes],
            order_by_id=self.order_by_id,
        )
        selection_score_vnd = (
            total_route_cost_vnd + idle_salary_vnd + operational_late_penalty_vnd
        )

        return BenchmarkMetric(
            method_name="Direct Dedicated (Đơn lẻ)",
            description=DIRECT_DESCRIPTION,
            total_cost_vnd=total_route_cost_vnd,
            total_distance_km=round(
                sum(route.total_distance_km for route in routes), 2
            ),
            total_duration_minutes=round(
                sum(route.total_duration_minutes for route in routes), 2
            ),
            vehicles_used=len(routes),
            fuel_cost_vnd=fuel,
            vehicle_fixed_cost_vnd=fixed,
            driver_cost_vnd=driver_cost,
            cargo_holding_cost_vnd=holding,
            late_delivery_penalty_vnd=late_penalty,
            planning_span_days=planning_span_days,
            physical_vehicle_count=physical_vehicle_count,
            driver_calendar_salary_vnd=calendar_salary_vnd,
            driver_idle_salary_allocation_vnd=idle_salary_vnd,
            operational_late_penalty_vnd=operational_late_penalty_vnd,
            selection_score_vnd=selection_score_vnd,
            is_feasible=True,
            violations=[],
            routes=routes,
        )

    @staticmethod
    def _savings(
        baseline: BenchmarkMetric, optimized_cost: int
    ) -> Tuple[Optional[int], Optional[float]]:
        if not baseline.is_feasible or baseline.total_cost_vnd <= 0:
            return None, None
        difference = baseline.total_cost_vnd - optimized_cost
        return difference, round(difference / baseline.total_cost_vnd * 100, 2)

    def build_comparison(
        self,
        ortools_routes: List[OptimizedRoute],
        ortools_total_cost_vnd: int,
        ortools_total_distance_km: float,
        ortools_total_duration_minutes: float,
        ortools_is_feasible: bool = True,
        ortools_violations: Optional[List[str]] = None,
        *,
        direct_metric: Optional[BenchmarkMetric] = None,
    ) -> BenchmarkComparisonResponse:
        if direct_metric is None:
            direct_metric = self.compute_direct_dedicated()
        ortools_fuel = sum(route.cost.fuel_cost_vnd for route in ortools_routes if route.cost)
        ortools_fixed = sum(
            route.cost.vehicle_fixed_cost_vnd for route in ortools_routes if route.cost
        )
        ortools_active_driver_salary = sum(
            route.cost.driver_fixed_salary_allocation_vnd
            for route in ortools_routes
            if route.cost
        )
        ortools_driver = sum(
            route.cost.driver_fixed_salary_allocation_vnd
            + route.cost.driver_trip_pay_vnd
            for route in ortools_routes
            if route.cost
        )
        ortools_holding = sum(
            route.cost.cargo_holding_cost_vnd for route in ortools_routes if route.cost
        )
        ortools_late_penalty = sum(
            route.cost.late_delivery_penalty_vnd
            for route in ortools_routes
            if route.cost
        )
        ortools_span_days = (
            max((route.service_day_index for route in ortools_routes), default=0) + 1
            if ortools_routes
            else 0
        )
        vehicle_by_id = {v.id: v for v in self.vehicles}
        ortools_phys_vehicles = len(
            {
                (
                    vehicle_by_id[route.vehicle_id].source_vehicle_id
                    or route.vehicle_id
                )
                if route.vehicle_id in vehicle_by_id
                else route.vehicle_id.split("::day:")[0]
                for route in ortools_routes
            }
        )
        ortools_calendar_salary = (
            self._calendar_salary_for_direct_span(
                ortools_span_days,
                ortools_active_driver_salary,
            )
            if ortools_routes
            else 0
        )
        ortools_idle_salary = max(
            0, ortools_calendar_salary - ortools_active_driver_salary
        )
        ortools_selection_score = ortools_total_cost_vnd + ortools_idle_salary

        ortools_metric = BenchmarkMetric(
            method_name="Google OR-Tools Metaheuristic",
            description="Nghiệm khả thi tốt nhất tìm thấy trong giới hạn thời gian",
            total_cost_vnd=ortools_total_cost_vnd,
            total_distance_km=round(ortools_total_distance_km, 2),
            total_duration_minutes=round(ortools_total_duration_minutes, 2),
            vehicles_used=len(ortools_routes),
            fuel_cost_vnd=ortools_fuel,
            vehicle_fixed_cost_vnd=ortools_fixed,
            driver_cost_vnd=ortools_driver,
            cargo_holding_cost_vnd=ortools_holding,
            late_delivery_penalty_vnd=ortools_late_penalty,
            planning_span_days=ortools_span_days,
            physical_vehicle_count=ortools_phys_vehicles,
            driver_calendar_salary_vnd=ortools_calendar_salary,
            driver_idle_salary_allocation_vnd=ortools_idle_salary,
            selection_score_vnd=ortools_selection_score,
            is_feasible=ortools_is_feasible,
            violations=ortools_violations or [],
        )
        direct_saving, direct_percent = self._savings(
            direct_metric, ortools_total_cost_vnd
        )
        return BenchmarkComparisonResponse(
            or_tools=ortools_metric,
            direct_dedicated=direct_metric,
            savings_vs_direct_vnd=direct_saving,
            savings_vs_direct_percent=direct_percent,
        )
