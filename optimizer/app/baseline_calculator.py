from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .models import (
    BenchmarkComparisonResponse,
    BenchmarkMetric,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    OptimizedRoute,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    can_driver_drive_vehicle,
)
from .planning_objective import calendar_salary_for_span
from .route_costing import build_route_cost_breakdown
from .spatial_validator import SpatialValidator

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


class BaselineCostCalculator:
    """Build comparable baselines using the production feasibility rules."""

    def __init__(self, request: FleetOptimizationRequest, nodes: List[dict]):
        self.request = request
        self.nodes = nodes
        self.vehicles = request.vehicles
        self.drivers = request.drivers
        self.orders = request.orders
        self.order_by_id = {order.id: order for order in request.orders}
        self.node_idx_by_id = {node["id"]: idx for idx, node in enumerate(nodes)}
        self._spatial_cache: Dict[Tuple, SpatialValidationResult] = {}

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
        start_node_index: Optional[int] = None,
        start_time_sec: Optional[int] = None,
        return_to_depot: bool = True,
    ) -> _EvaluatedRoute:
        current_node = vehicle_index if start_node_index is None else start_node_index
        start_time = vehicle.available_start_sec if start_time_sec is None else start_time_sec
        current_time = start_time
        current_weight = 0.0
        total_distance = 0.0
        scheduled: List[ScheduledStop] = []
        violations: List[str] = []
        item_weight_by_id = {
            item.id: item.weight_kg
            for order in self.orders
            for item in order.items
        }

        for action in actions:
            node_index = self.node_idx_by_id[action.stop_id]
            order = self.nodes[node_index]["order"]
            travel_seconds = round(self.request.duration_matrix_seconds[current_node][node_index])
            leg_start = round(current_time)
            total_distance += self.request.distance_matrix_meters[current_node][node_index]
            physical_arrival = current_time + travel_seconds
            if action.stop_type == "PICKUP":
                window_start, window_end = order.pickup_window_start_sec, order.pickup_window_end_sec
            else:
                window_start, window_end = order.delivery_window_start_sec, order.delivery_window_end_sec
            arrival = max(physical_arrival, window_start)
            if arrival > window_end:
                violations.append(f"TIME_WINDOW:{order.order_number} vượt khung phục vụ tại điểm {action.stop_type}")
            if arrival > vehicle.available_end_sec:
                violations.append(
                    f"VEHICLE_AVAILABILITY:{vehicle.plate_number} vượt giờ khả dụng"
                )

            current_weight += sum(item.weight_kg for item in action.items_to_load)
            current_weight -= sum(
                item_weight_by_id.get(item_id, 0.0)
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
            service_time_sec = order.service_seconds(action.stop_type)
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

        if return_to_depot:
            total_distance += self.request.distance_matrix_meters[current_node][vehicle_index]
            current_time += round(self.request.duration_matrix_seconds[current_node][vehicle_index])
        if current_time > vehicle.available_end_sec and not violations:
            violations.append(f"VEHICLE_AVAILABILITY:{vehicle.plate_number} kết thúc chuyến sau giờ khả dụng")

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
            vehicle_floor_area = vehicle.length_cm * vehicle.width_cm
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
            )
            if cache_key not in self._spatial_cache:
                self._spatial_cache[cache_key] = SpatialValidator(vehicle, max_search_nodes=2000).validate_plan(actions)
            spatial = self._spatial_cache[cache_key]
            if not spatial.is_valid:
                violations.append(f"SPATIAL:{spatial.error_message or spatial.violation_code or 'Bố trí xếp/dỡ không hợp lệ'}")
        return _EvaluatedRoute(
            vehicle=vehicle,
            stops=scheduled,
            distance_meters=total_distance,
            duration_seconds=current_time - start_time,
            start_time_sec=start_time,
            spatial_validation=spatial,
            violations=violations,
        )

    @staticmethod
    def _is_driver_compatible(driver: DriverOption, vehicle: FleetVehicle) -> bool:
        vehicle_type = vehicle.vehicle_type or vehicle.model or ""
        return can_driver_drive_vehicle(
            driver.license_class, vehicle.payload_limit_kg, vehicle_type
        )

    def _route_cost(
        self, route: _EvaluatedRoute, driver: DriverOption,
        start_node_index: int, return_to_depot: bool,
    ) -> RouteCostBreakdown:
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

    def _solve_direct_schedule(
        self,
        paired_slots: List[Tuple[int, FleetVehicle, DriverOption]],
    ) -> Optional[List[OptimizedRoute]]:
        if not paired_slots:
            return None

        # Every pickup must be followed immediately by its own delivery. Between
        # orders, the empty vehicle drives directly to the next pickup.
        slot_count = len(paired_slots)
        matrix_nodes = [matrix_idx for matrix_idx, _, _ in paired_slots]
        service_seconds = [0] * slot_count
        order_actions = [self._actions_for_order(order) for order in self.orders]
        for order, actions in zip(self.orders, order_actions):
            matrix_nodes.extend(self.node_idx_by_id[action.stop_id] for action in actions)
            service_seconds.extend(order.service_seconds(action.stop_type) for action in actions)
        depot_nodes = list(range(slot_count))
        manager = pywrapcp.RoutingIndexManager(len(matrix_nodes), slot_count, depot_nodes, depot_nodes)
        routing = pywrapcp.RoutingModel(manager)
        durations = self.request.duration_matrix_seconds
        distances = self.request.distance_matrix_meters

        def travel(from_index: int, to_index: int) -> int:
            origin, destination = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
            return service_seconds[origin] + round(durations[matrix_nodes[origin]][matrix_nodes[destination]])

        horizon = max(vehicle.available_end_sec for _, vehicle, _ in paired_slots)
        time_index = routing.RegisterTransitCallback(travel)
        routing.AddDimension(time_index, horizon, horizon, False, "DirectShift")
        schedule = routing.GetDimensionOrDie("DirectShift")

        for slot, (_, vehicle, driver) in enumerate(paired_slots):
            fuel_per_km = vehicle.fuel_consumption_liters_per_100_km * self.request.policy.fuel_price_per_liter_vnd / 100
            per_km = fuel_per_km + driver.per_km_pay_vnd
            trip_cost = vehicle.fixed_operating_cost_vnd + driver.trip_base_pay_vnd

            def cost(from_index: int, to_index: int, rate: float = per_km, fixed: int = trip_cost) -> int:
                origin, destination = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
                meters = distances[matrix_nodes[origin]][matrix_nodes[destination]]
                # Retain distance as a tie-breaker when different legs round to the same VND.
                arc_cost = round(meters * (rate + 1))
                return arc_cost + (fixed * 1000 if origin >= slot_count and (origin - slot_count) % 2 == 0 else 0)

            routing.SetArcCostEvaluatorOfVehicle(routing.RegisterTransitCallback(cost), slot)
            start, end = routing.Start(slot), routing.End(slot)
            schedule.CumulVar(start).SetValue(vehicle.available_start_sec)
            schedule.CumulVar(end).SetRange(vehicle.available_start_sec, vehicle.available_end_sec)
            routing.AddVariableMinimizedByFinalizer(schedule.CumulVar(end))

        for order_index, (order, actions) in enumerate(zip(self.orders, order_actions)):
            pickup_node = slot_count + order_index * 2
            pickup = manager.NodeToIndex(pickup_node)
            delivery = manager.NodeToIndex(pickup_node + 1)
            allowed = []
            for slot, (matrix_idx, vehicle, _) in enumerate(paired_slots):
                vehicle_id = vehicle.source_vehicle_id or vehicle.id
                if order.allowed_source_vehicle_ids and vehicle_id not in order.allowed_source_vehicle_ids:
                    continue
                # Validate this load independently of the leg bringing the truck to its pickup.
                route = self._evaluate_actions(vehicle, matrix_idx, actions,
                                               start_node_index=matrix_nodes[pickup_node], return_to_depot=False)
                if not route.violations:
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
        params.time_limit.FromMilliseconds(1500)
        solution = routing.SolveWithParameters(params)
        if solution is None:
            return None

        routes: List[OptimizedRoute] = []
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
                trip = self._evaluate_actions(vehicle, matrix_idx, order_actions[order_index],
                                              start_node_index=start_node, start_time_sec=departure,
                                              return_to_depot=last_trip)
                spatial = trip.spatial_validation
                if trip.violations or spatial is None or not spatial.is_valid:
                    return None
                end_time = departure + round(trip.duration_seconds)
                routes.append(OptimizedRoute(
                    route_id=f"direct:{vehicle.id}:{order.id}",
                    vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                    service_day_index=vehicle.service_day_index,
                    start_time_sec=departure,
                    end_time_sec=end_time,
                    return_travel_time_sec=end_time - trip.stops[-1].departure_time_sec,
                    plate_number=vehicle.plate_number,
                    vehicle_length_cm=vehicle.length_cm,
                    vehicle_width_cm=vehicle.width_cm,
                    driver_id=driver.source_driver_id or driver.id,
                    driver_name=driver.full_name,
                    driver_license_class=driver.license_class,
                    total_distance_km=trip.distance_meters / 1000,
                    total_duration_minutes=trip.duration_seconds / 60,
                    depot=start_point,
                    end_location=vehicle.depot if last_trip else order.delivery_location,
                    stops=trip.stops,
                    spatial_validation=spatial,
                    cost=self._route_cost(trip, driver, start_node, last_trip),
                ))
                departure = end_time
                start_point = order.delivery_location
                start_node = matrix_nodes[pickup_node + 1]
        return routes

    def compute_direct_dedicated(self) -> BenchmarkMetric:
        """Schedule sequential single-order trips in the available truck and driver shifts."""
        if not self.orders or not self.vehicles or not self.drivers:
            return self._unavailable_direct("INPUT:Không có đủ đơn, xe hoặc tài xế để đối chuẩn")

        slots = self._pair_vehicles_with_drivers_by_day(list(enumerate(self.vehicles)), self.drivers)
        days = sorted({vehicle.service_day_index for _, vehicle, _ in slots})
        routes = None
        # Try the first shift day before widening the search to all supplied days.
        for day_limit in days[:2] + (days[-1:] if len(days) > 2 else []):
            routes = self._solve_direct_schedule([slot for slot in slots if slot[1].service_day_index <= day_limit])
            if routes:
                break
        if not routes:
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
        selection_score_vnd = total_route_cost_vnd + idle_salary_vnd

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
    ) -> BenchmarkComparisonResponse:
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
