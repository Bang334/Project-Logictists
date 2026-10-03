import itertools
import time
from typing import Dict, List, Set, Tuple, Optional

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .models import (
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    OptimizationRequest,
    OptimizationResponse,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    UnassignedOrder,
    can_driver_drive_vehicle,
)
from .spatial_validator import SpatialValidator
from .baseline_calculator import BaselineCostCalculator
from .route_costing import (
    build_route_cost_breakdown,
    calculate_driver_cost,
    calculate_route_economic_metrics,
    late_delivery_daily_penalty,
)


# OR-Tools routing costs are integers. Micro-VND preserves small marginal
# costs such as the fuel surcharge of carrying one kilogram for one metre.
OBJECTIVE_COST_SCALE = 1_000_000
WEIGHT_SCALE = 100


class FleetRoutingSolver:
    """Multi-vehicle pickup/delivery routing over a provider-supplied road matrix."""

    def __init__(self, request: FleetOptimizationRequest):
        self.request = request
        self.vehicle_count = len(request.vehicles)
        self.nodes = self._build_nodes()
        self.order_by_id = {order.id: order for order in request.orders}
        self.driver_safe_vehicle_indices = self._find_driver_safe_vehicle_indices()

    def _find_driver_safe_vehicle_indices(self) -> Set[int]:
        """Return a maximum vehicle subset with a one-to-one legal driver match."""
        driver_to_vehicle: Dict[int, int] = {}

        def assign(vehicle_index: int, seen_drivers: Set[int]) -> bool:
            vehicle = self.request.vehicles[vehicle_index]
            vehicle_type = vehicle.vehicle_type or vehicle.model or ""
            for driver_index, driver in enumerate(self.request.drivers):
                if driver_index in seen_drivers or not can_driver_drive_vehicle(
                    driver.license_class,
                    vehicle.payload_limit_kg,
                    vehicle_type,
                ):
                    continue
                if driver.service_day_index != vehicle.service_day_index:
                    continue
                seen_drivers.add(driver_index)
                previous_vehicle = driver_to_vehicle.get(driver_index)
                if previous_vehicle is None or assign(previous_vehicle, seen_drivers):
                    driver_to_vehicle[driver_index] = vehicle_index
                    return True
            return False

        for vehicle_index in range(len(self.request.vehicles)):
            assign(vehicle_index, set())
        return set(driver_to_vehicle.values())

    def _build_nodes(self) -> List[dict]:
        nodes: List[dict] = []
        for vehicle in self.request.vehicles:
            nodes.append(
                {
                    "id": vehicle.depot.id,
                    "name": vehicle.depot.name,
                    "lat": vehicle.depot.latitude,
                    "lon": vehicle.depot.longitude,
                    "type": "DEPOT",
                    "order": None,
                    "service_time_sec": 0,
                }
            )
        for order in self.request.orders:
            nodes.extend(
                [
                    {
                        "id": order.pickup_location.id,
                        "name": order.pickup_location.name,
                        "lat": order.pickup_location.latitude,
                        "lon": order.pickup_location.longitude,
                        "type": "PICKUP",
                        "order": order,
                        "service_time_sec": order.service_time_sec,
                    },
                    {
                        "id": order.delivery_location.id,
                        "name": order.delivery_location.name,
                        "lat": order.delivery_location.latitude,
                        "lon": order.delivery_location.longitude,
                        "type": "DELIVERY",
                        "order": order,
                        "service_time_sec": order.service_time_sec,
                    },
                ]
            )
        return nodes

    def solve(self) -> FleetOptimizationResponse:
        started_at = time.monotonic()
        if not self.driver_safe_vehicle_indices:
            return FleetOptimizationResponse(
                job_id=self.request.job_id,
                status="INFEASIBLE",
                unassigned_orders=[
                    UnassignedOrder(
                        order_id=order.id,
                        order_number=order.order_number,
                        reason_code="NO_COMPATIBLE_DRIVER",
                        reason_message=(
                            "Không có cặp xe–tài xế nào đáp ứng hạng bằng lái."
                        ),
                    )
                    for order in self.request.orders
                ],
                diagnostics=[
                    "Không chạy solver vì không có xe nào ghép được với tài xế đủ hạng bằng."
                ],
            )
        vehicle_count = self.vehicle_count
        starts = list(range(vehicle_count))
        ends = list(range(vehicle_count))
        manager = pywrapcp.RoutingIndexManager(len(self.nodes), vehicle_count, starts, ends)
        routing = pywrapcp.RoutingModel(manager)

        def distance_callback(from_index: int, to_index: int) -> int:
            return int(round(self.request.distance_matrix_meters[
                manager.IndexToNode(from_index)
            ][manager.IndexToNode(to_index)]))

        distance_callback_index = routing.RegisterTransitCallback(distance_callback)
        routing.AddDimension(distance_callback_index, 0, 2_000_000, True, "Distance")
        distance_dimension = routing.GetDimensionOrDie("Distance")

        average_driver_per_km_vnd = sum(
            driver.per_km_pay_vnd for driver in self.request.drivers
        ) / len(self.request.drivers)
        average_driver_trip_base_vnd = sum(
            driver.trip_base_pay_vnd for driver in self.request.drivers
        ) / len(self.request.drivers)
        average_driver_time_vnd_per_second = sum(
            driver.fixed_salary_monthly_vnd
            / self.request.policy.monthly_working_minutes
            / 60
            for driver in self.request.drivers
        ) / len(self.request.drivers)

        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            fuel_vnd_per_meter = (
                vehicle.fuel_consumption_liters_per_100_km
                * self.request.policy.fuel_price_per_liter_vnd
                / 100_000
            )
            driver_vnd_per_meter = average_driver_per_km_vnd / 1000
            financial_vnd_per_meter = fuel_vnd_per_meter + driver_vnd_per_meter

            if financial_vnd_per_meter <= 0:
                routing.SetArcCostEvaluatorOfVehicle(distance_callback_index, vehicle_index)
            else:
                def vehicle_cost(from_index: int, to_index: int, rate=financial_vnd_per_meter) -> int:
                    from_node = manager.IndexToNode(from_index)
                    to_node = manager.IndexToNode(to_index)
                    distance = self.request.distance_matrix_meters[from_node][to_node]
                    return max(0, int(round(distance * rate * OBJECTIVE_COST_SCALE)))

                cost_callback = routing.RegisterTransitCallback(vehicle_cost)
                routing.SetArcCostEvaluatorOfVehicle(cost_callback, vehicle_index)

            # Solver-only delay penalty: prefer the earliest service day and
            # spill into later days only when earlier daily slots are full.
            # This penalty is not reported as a financial operating cost.
            day_delay_penalty_vnd = (
                self.request.policy.unassigned_order_penalty_vnd
                // 1000
                * vehicle.service_day_index
            )
            routing.SetFixedCostOfVehicle(
                round(
                    (
                        vehicle.fixed_operating_cost_vnd
                        + average_driver_trip_base_vnd
                        + day_delay_penalty_vnd
                    )
                    * OBJECTIVE_COST_SCALE
                ),
                vehicle_index,
            )

        def time_callback(from_index: int, to_index: int) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            return int(round(
                self.request.duration_matrix_seconds[from_node][to_node]
                + self.nodes[from_node]["service_time_sec"]
            ))

        time_callback_index = routing.RegisterTransitCallback(time_callback)
        max_time_horizon = 30 * 86400  # 30 ngày = 2.592.000 giây
        routing.AddDimension(time_callback_index, max_time_horizon, max_time_horizon, False, "Time")
        time_dimension = routing.GetDimensionOrDie("Time")
        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            time_dimension.CumulVar(routing.Start(vehicle_index)).SetRange(
                vehicle.available_start_sec, vehicle.available_start_sec
            )
            time_dimension.CumulVar(routing.End(vehicle_index)).SetRange(
                vehicle.available_start_sec, vehicle.available_end_sec
            )
        driver_time_cost_coefficient = round(
            average_driver_time_vnd_per_second * OBJECTIVE_COST_SCALE
        )
        if driver_time_cost_coefficient > 0:
            time_dimension.SetSpanCostCoefficientForAllVehicles(driver_time_cost_coefficient)

        def demand_callback(from_index: int) -> int:
            node = self.nodes[manager.IndexToNode(from_index)]
            if node["order"] is None:
                return 0
            demand = sum(item.weight_kg for item in node["order"].items)
            return round(demand * WEIGHT_SCALE) * (1 if node["type"] == "PICKUP" else -1)

        demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
        routing.AddDimensionWithVehicleCapacity(
            demand_callback_index,
            0,
            [round(v.payload_limit_kg * WEIGHT_SCALE) for v in self.request.vehicles],
            True,
            "Weight",
        )

        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            extra_fuel_vnd_per_kg_meter = (
                vehicle.fuel_consumption_liters_per_100_km
                * (vehicle.load_fuel_surcharge_percent_at_full_payload / 100)
                * self.request.policy.fuel_price_per_liter_vnd
                / 100_000
                / vehicle.payload_limit_kg
            )
            load_energy_cost_coefficient = round(
                extra_fuel_vnd_per_kg_meter
                * OBJECTIVE_COST_SCALE
                / WEIGHT_SCALE
            )
            if load_energy_cost_coefficient > 0:
                # OR-Tools evaluates Weight.CumulVar(Next(node)) *
                # Distance.TransitVar(node), i.e. the load actually carried on
                # each road leg after applying pickup/delivery at the origin.
                routing.SetPathEnergyCostOfVehicle(
                    "Weight", "Distance", load_energy_cost_coefficient, vehicle_index
                )

        # Dimension 2: Floor Area (dm2 = 100 cm2)
        # Kiểm soát diện tích sàn xe thực tế, ngăn xe bị quá tải mặt sàn
        area_scale = 100
        def area_callback(from_index: int) -> int:
            node = self.nodes[manager.IndexToNode(from_index)]
            if node["order"] is None:
                return 0
            area = sum(item.length_cm * item.width_cm for item in node["order"].items)
            return round(area / area_scale) * (1 if node["type"] == "PICKUP" else -1)

        area_callback_index = routing.RegisterUnaryTransitCallback(area_callback)
        routing.AddDimensionWithVehicleCapacity(
            area_callback_index,
            0,
            [round((v.length_cm * v.width_cm) / area_scale) for v in self.request.vehicles],
            True,
            "Area",
        )

        pair_penalty = (
            self.request.policy.unassigned_order_penalty_vnd * OBJECTIVE_COST_SCALE
        )
        for order_index, order in enumerate(self.request.orders):
            pickup_node = vehicle_count + 2 * order_index
            delivery_node = pickup_node + 1
            pickup_index = manager.NodeToIndex(pickup_node)
            delivery_index = manager.NodeToIndex(delivery_node)

            routing.SetAllowedVehiclesForIndex(
                sorted(self.driver_safe_vehicle_indices), pickup_index
            )
            routing.SetAllowedVehiclesForIndex(
                sorted(self.driver_safe_vehicle_indices), delivery_index
            )

            routing.AddPickupAndDelivery(pickup_index, delivery_index)
            routing.solver().Add(
                routing.VehicleVar(pickup_index) == routing.VehicleVar(delivery_index)
            )
            routing.solver().Add(
                distance_dimension.CumulVar(pickup_index)
                <= distance_dimension.CumulVar(delivery_index)
            )
            routing.solver().Add(
                time_dimension.CumulVar(pickup_index) <= time_dimension.CumulVar(delivery_index)
            )
            routing.solver().Add(
                routing.ActiveVar(pickup_index) == routing.ActiveVar(delivery_index)
            )
            routing.AddDisjunction([pickup_index], pair_penalty // 2)
            routing.AddDisjunction([delivery_index], pair_penalty - pair_penalty // 2)

            time_dimension.CumulVar(pickup_index).SetRange(
                max(0, order.pickup_window_start_sec),
                min(max_time_horizon, order.pickup_window_end_sec),
            )
            time_dimension.CumulVar(delivery_index).SetRange(
                max(0, order.delivery_window_start_sec),
                min(max_time_horizon, order.delivery_window_end_sec),
            )

            daily_late_penalty = late_delivery_daily_penalty(
                order, self.request.policy
            )
            late_penalty_per_second = round(
                daily_late_penalty * OBJECTIVE_COST_SCALE / 86_400
            )
            if late_penalty_per_second > 0:
                grace_end_sec = max(
                    0,
                    order.ordered_at_sec
                    + self.request.policy.delivery_grace_days * 86_400,
                )
                time_dimension.SetCumulVarSoftUpperBound(
                    delivery_index, grace_end_sec, late_penalty_per_second
                )

            cargo_weight_kg = sum(item.weight_kg for item in order.items)
            cargo_holding_cost_coefficient = round(
                self.request.policy.cargo_holding_cost_vnd_per_ton_hour
                * cargo_weight_kg
                * OBJECTIVE_COST_SCALE
                / (1000 * 3600)
            )
            if cargo_holding_cost_coefficient > 0:
                # The two soft bounds add a route-independent constant plus
                # coefficient * (delivery_time - pickup_time). This includes
                # waiting imposed by time windows, unlike a plain arc callback.
                time_dimension.SetCumulVarSoftLowerBound(
                    pickup_index, max_time_horizon, cargo_holding_cost_coefficient
                )
                time_dimension.SetCumulVarSoftUpperBound(
                    delivery_index, 0, cargo_holding_cost_coefficient
                )

        search = pywrapcp.DefaultRoutingSearchParameters()
        search.first_solution_strategy = (
            routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
        )
        search.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        )
        search.time_limit.seconds = self.request.max_time_seconds
        solution = routing.SolveWithParameters(search)
        if solution is None:
            elapsed = time.monotonic() - started_at
            status = "TIMEOUT" if elapsed >= self.request.max_time_seconds * 0.9 else "INFEASIBLE"
            return FleetOptimizationResponse(
                job_id=self.request.job_id,
                status=status,
                diagnostics=[
                    "Không tìm được nghiệm trong ngân sách thời gian; chưa suy diễn timeout thành bất khả thi."
                    if status == "TIMEOUT"
                    else "Bài toán không có nghiệm với tải trọng, thời gian và cặp pickup-delivery đã cung cấp."
                ],
            )

        routes: List[OptimizedRoute] = []
        assigned_order_ids = set()
        rejected_reasons: Dict[str, Tuple[str, str]] = {}

        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            index = routing.Start(vehicle_index)
            route_start_seconds = solution.Value(time_dimension.CumulVar(index))
            route_distance_meters = 0
            scheduled_stops: List[ScheduledStop] = []
            stop_actions: List[StopAction] = []
            route_order_ids = set()
            current_weight = 0.0
            sequence = 1

            while not routing.IsEnd(index):
                next_index = solution.Value(routing.NextVar(index))
                from_node = manager.IndexToNode(index)
                to_node = manager.IndexToNode(next_index)
                route_distance_meters += self.request.distance_matrix_meters[from_node][to_node]
                if routing.IsEnd(next_index):
                    index = next_index
                    continue

                node = self.nodes[to_node]
                order = node["order"]
                if order is not None:
                    arrival = solution.Value(time_dimension.CumulVar(next_index))
                    items_to_load = order.items if node["type"] == "PICKUP" else []
                    items_to_unload = (
                        [item.id for item in order.items] if node["type"] == "DELIVERY" else []
                    )
                    delta = sum(item.weight_kg for item in order.items)
                    current_weight += delta if node["type"] == "PICKUP" else -delta
                    route_order_ids.add(order.id)
                    stop_actions.append(
                        StopAction(
                            stop_id=node["id"],
                            sequence=sequence,
                            stop_type=node["type"],
                            address=node["name"],
                            latitude=node["lat"],
                            longitude=node["lon"],
                            items_to_load=items_to_load,
                            items_to_unload=items_to_unload,
                        )
                    )
                    scheduled_stops.append(
                        ScheduledStop(
                            sequence=sequence,
                            location_id=node["id"],
                            location_name=node["name"],
                            stop_type=node["type"],
                            order_id=order.id,
                            latitude=node["lat"],
                            longitude=node["lon"],
                            arrival_time_sec=arrival,
                            departure_time_sec=arrival + order.service_time_sec,
                            items_loaded=[item.id for item in items_to_load],
                            items_unloaded=items_to_unload,
                            current_weight_kg=round(max(0.0, current_weight), 2),
                        )
                    )
                    sequence += 1
                index = next_index

            if not scheduled_stops:
                continue

            spatial = SpatialValidator(vehicle).validate_plan(stop_actions)
            if not spatial.is_valid:
                # Phối hợp định tuyến & bố trí hàng: tìm kiếm hoán vị chuỗi stop không bị chắn lối ra cửa (T24/T26)
                orders_on_route = [self.order_by_id[oid] for oid in route_order_ids if oid in self.order_by_id]
                reseq = self._resequence_stops_for_spatial_feasibility(
                    vehicle,
                    vehicle_index,
                    orders_on_route,
                )
                if reseq is not None:
                    scheduled_stops, stop_actions, route_distance_meters, route_end_seconds, spatial = reseq
                elif len(orders_on_route) > 1:
                    # Fallback thông minh: Thử loại bớt 1 đơn để xe vẫn phục vụ được các đơn còn lại
                    sub_reseq = None
                    dropped_order_id = None
                    for sub in itertools.combinations(orders_on_route, len(orders_on_route) - 1):
                        sub_attempt = self._resequence_stops_for_spatial_feasibility(
                            vehicle,
                            vehicle_index,
                            list(sub),
                        )
                        if sub_attempt is not None:
                            sub_reseq = sub_attempt
                            dropped_order_id = next(o.id for o in orders_on_route if o.id not in {x.id for x in sub})
                            break
                    if sub_reseq is not None:
                        scheduled_stops, stop_actions, route_distance_meters, route_end_seconds, spatial = sub_reseq
                        rejected_reasons[dropped_order_id] = (
                            "SPATIAL_ROUTE_CONFLICT",
                            "Đơn xung đột bố trí với tuyến ban đầu; sẽ thử tái phân công sang tuyến khác.",
                        )
                        route_order_ids = {s.order_id for s in scheduled_stops if s.order_id}
                    else:
                        for order_id in route_order_ids:
                            rejected_reasons[order_id] = self._spatial_rejection(spatial)
                        continue
                else:
                    for order_id in route_order_ids:
                        rejected_reasons[order_id] = self._spatial_rejection(spatial)
                    continue
            else:
                route_end_seconds = solution.Value(
                    time_dimension.CumulVar(routing.End(vehicle_index))
                )
            route_end_seconds = round(route_end_seconds)
            route_duration_seconds = route_end_seconds - route_start_seconds
            routes.append(
                OptimizedRoute(
                    route_id=vehicle.id,
                    vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                    service_day_index=vehicle.service_day_index,
                    start_time_sec=route_start_seconds,
                    end_time_sec=route_end_seconds,
                    plate_number=vehicle.plate_number,
                    vehicle_length_cm=vehicle.length_cm,
                    vehicle_width_cm=vehicle.width_cm,
                    total_distance_km=round(route_distance_meters / 1000, 2),
                    total_duration_minutes=round(route_duration_seconds / 60, 1),
                    stops=scheduled_stops,
                    spatial_validation=spatial,
                )
            )
            assigned_order_ids.update(route_order_ids)

        recovery_limit_reached = self._recover_unassigned_orders(
            routes,
            assigned_order_ids,
            rejected_reasons,
            deadline=time.monotonic() + max(5.0, self.request.max_time_seconds),
        )

        self._assign_drivers_and_costs(routes)

        unassigned: List[UnassignedOrder] = []
        for order in self.request.orders:
            if order.id in assigned_order_ids:
                continue
            rejected_reason = rejected_reasons.get(order.id)
            if recovery_limit_reached and (
                rejected_reason is None
                or rejected_reason[0] == "SPATIAL_ROUTE_CONFLICT"
            ):
                code = "RECOVERY_SEARCH_LIMIT_REACHED"
                message = "Hết ngân sách tìm kiếm tái phân công; chưa kết luận đơn bất khả thi."
            elif rejected_reason is not None:
                code, message = rejected_reason
            else:
                code, message = self._classify_unassigned_order(order)
            unassigned.append(
                UnassignedOrder(
                    order_id=order.id,
                    order_number=order.order_number,
                    reason_code=code,
                    reason_message=message,
                )
            )

        result_status = "SUCCESS" if routes and not unassigned else "PARTIAL" if routes else "INFEASIBLE"
        total_dist_km = round(sum(route.total_distance_km for route in routes), 2)
        total_dur_min = round(sum(route.total_duration_minutes for route in routes), 1)
        total_cost_vnd = sum(route.cost.total_cost_vnd for route in routes if route.cost)

        benchmarks = None
        benchmark_diagnostic = None
        try:
            baseline_calc = BaselineCostCalculator(self.request, self.nodes)
            benchmarks = baseline_calc.build_comparison(
                routes,
                total_cost_vnd,
                total_dist_km,
                total_dur_min,
                ortools_is_feasible=not unassigned and all(
                    route.spatial_validation.is_valid for route in routes
                ),
                ortools_violations=[
                    f"{order.order_number}: {order.reason_message}"
                    for order in unassigned
                ],
            )
        except Exception as error:
            # Benchmark là dữ liệu phụ, nhưng lỗi phải hiện trong diagnostics thay vì bị nuốt.
            benchmark_diagnostic = f"Không tính được benchmark: {error}"

        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status=result_status,
            routes=routes,
            unassigned_orders=unassigned,
            total_distance_km=total_dist_km,
            total_duration_minutes=total_dur_min,
            total_cost_vnd=total_cost_vnd,
            benchmarks=benchmarks,
            diagnostics=[
                "Mục tiêu OR-Tools gồm nhiên liệu nền, phụ trội nhiên liệu theo tải từng chặng, "
                "thời gian/km tài xế và thời gian hàng nằm trên xe.",
                "Chi phí tài xế dùng mức bình quân đội xe khi tạo tuyến; sau đó ghép tài xế và "
                "tính lại bảng chi phí theo đúng tài xế được chọn.",
                "Kết quả là nghiệm khả thi tốt nhất tìm thấy trong thời gian cho phép, không khẳng định tối ưu toàn cục.",
            ] + ([benchmark_diagnostic] if benchmark_diagnostic else []),
        )

    @staticmethod
    def _spatial_rejection(
        spatial: SpatialValidationResult,
    ) -> Tuple[str, str]:
        if spatial.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED":
            return (
                "SPATIAL_SEARCH_LIMIT_REACHED",
                spatial.error_message
                or "Hết ngân sách tìm bố trí; chưa kết luận chuyến bất khả thi.",
            )
        return (
            "SPATIAL_VALIDATION_FAILED",
            spatial.error_message or "Bố trí xếp/dỡ không hợp lệ.",
        )

    def _recover_unassigned_orders(
        self,
        routes: List[OptimizedRoute],
        assigned_order_ids: Set[str],
        rejected_reasons: Dict[str, Tuple[str, str]],
        *,
        deadline: float,
    ) -> bool:
        """Try every vehicle, including vehicles already used by another route.

        OR-Tools only models aggregate floor area. A route can therefore be
        rejected by the exact spatial validator after routing. Recovery must
        reinsert the dropped order across the whole fleet instead of looking
        only at idle vehicles.
        """
        vehicle_index_by_id = {
            vehicle.id: index for index, vehicle in enumerate(self.request.vehicles)
        }
        self._active_recovery_deadline = deadline
        limit_reached = False

        for order in self.request.orders:
            if order.id in assigned_order_ids:
                continue
            if time.monotonic() >= deadline:
                limit_reached = True
                break

            route_index_by_vehicle_id = {
                route.route_id or route.vehicle_id: index
                for index, route in enumerate(routes)
            }
            candidate_vehicle_slots = sorted(
                enumerate(self.request.vehicles),
                key=lambda item: (
                    item[1].id in route_index_by_vehicle_id,
                    item[1].service_day_index,
                    item[0],
                ),
            )
            best_candidate = None
            for vehicle_index, vehicle in candidate_vehicle_slots:
                if vehicle_index not in self.driver_safe_vehicle_indices:
                    continue
                if time.monotonic() >= deadline:
                    limit_reached = True
                    break
                if not self._order_physically_fits_vehicle(order, vehicle):
                    continue

                route_index = route_index_by_vehicle_id.get(vehicle.id)
                if (
                    best_candidate is not None
                    and best_candidate[1] is None
                    and (
                        route_index is not None
                        or vehicle.service_day_index
                        > best_candidate[2].service_day_index
                    )
                ):
                    break
                existing_order_ids: List[str] = []
                if route_index is not None:
                    for stop in routes[route_index].stops:
                        if (
                            stop.order_id
                            and stop.order_id not in existing_order_ids
                        ):
                            existing_order_ids.append(stop.order_id)

                candidate_orders = [
                    self.order_by_id[order_id]
                    for order_id in existing_order_ids
                    if order_id in self.order_by_id
                ] + [order]
                recovered = self._resequence_stops_for_spatial_feasibility(
                    vehicle,
                    vehicle_index,
                    candidate_orders,
                )
                if recovered is None:
                    continue

                scheduled, _, distance_meters, duration_seconds, spatial = recovered
                candidate_score = distance_meters
                if best_candidate is None or candidate_score < best_candidate[0]:
                    best_candidate = (
                        candidate_score,
                        route_index,
                        vehicle,
                        scheduled,
                        distance_meters,
                        duration_seconds,
                        spatial,
                    )

            if best_candidate is None:
                continue

            (
                _,
                route_index,
                vehicle,
                scheduled,
                distance_meters,
                duration_seconds,
                spatial,
            ) = best_candidate
            recovered_route = OptimizedRoute(
                route_id=vehicle.id,
                vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                service_day_index=vehicle.service_day_index,
                start_time_sec=vehicle.available_start_sec,
                end_time_sec=round(duration_seconds),
                plate_number=vehicle.plate_number,
                vehicle_length_cm=vehicle.length_cm,
                vehicle_width_cm=vehicle.width_cm,
                total_distance_km=round(distance_meters / 1000, 2),
                total_duration_minutes=round(
                    (duration_seconds - vehicle.available_start_sec) / 60, 1
                ),
                stops=scheduled,
                spatial_validation=spatial,
            )
            if route_index is None:
                routes.append(recovered_route)
            else:
                routes[route_index] = recovered_route
            assigned_order_ids.add(order.id)
            rejected_reasons.pop(order.id, None)

        # This lookup also guards against accidental route creation for an
        # unknown vehicle while the recovery code evolves.
        assert all((route.route_id or route.vehicle_id) in vehicle_index_by_id for route in routes)
        return limit_reached

    @staticmethod
    def _order_physically_fits_vehicle(
        order: OrderPair, vehicle: FleetVehicle
    ) -> bool:
        if sum(item.weight_kg for item in order.items) > vehicle.payload_limit_kg:
            return False
        if (
            sum(item.length_cm * item.width_cm for item in order.items)
            > vehicle.length_cm * vehicle.width_cm
        ):
            return False
        for item in order.items:
            orientations = [(item.length_cm, item.width_cm)]
            if item.can_rotate:
                orientations.append((item.width_cm, item.length_cm))
            if item.height_cm > vehicle.height_cm or not any(
                length <= vehicle.length_cm and width <= vehicle.width_cm
                for length, width in orientations
            ):
                return False
        return True

    def _classify_unassigned_order(self, order: OrderPair) -> Tuple[str, str]:
        weight_compatible = [
            vehicle
            for index, vehicle in enumerate(self.request.vehicles)
            if index in self.driver_safe_vehicle_indices
            if sum(item.weight_kg for item in order.items)
            <= vehicle.payload_limit_kg
        ]
        if not weight_compatible:
            return (
                "PAYLOAD_EXCEEDED",
                "Khối lượng đơn vượt tải trọng của mọi xe khả dụng.",
            )

        physical_compatible = [
            vehicle
            for vehicle in weight_compatible
            if self._order_physically_fits_vehicle(order, vehicle)
        ]
        if not physical_compatible:
            return (
                "FLOOR_CAPACITY_EXCEEDED",
                "Kiện hàng không vừa kích thước hoặc diện tích sàn của mọi xe khả dụng.",
            )

        return (
            "NO_FEASIBLE_ASSIGNMENT",
            "Chưa tìm được cách ghép đơn vào các tuyến hiện tại trong ngân sách tìm kiếm; không khẳng định bất khả thi.",
        )

    def _assign_drivers_and_costs(self, routes: List[OptimizedRoute]) -> None:
        if not routes:
            return
        drivers = self.request.drivers
        vehicle_by_id = {vehicle.id: vehicle for vehicle in self.request.vehicles}

        def driver_cost(route: OptimizedRoute, driver: DriverOption) -> Tuple[int, int, int]:
            return calculate_driver_cost(
                self.request,
                driver,
                route.total_duration_minutes,
                route.total_distance_km,
            )

        for service_day_index in sorted({route.service_day_index for route in routes}):
            day_routes = [
                route for route in routes if route.service_day_index == service_day_index
            ]
            day_drivers = [
                driver for driver in drivers if driver.service_day_index == service_day_index
            ]
            best_assignment = None
            best_cost = None

            for candidate in itertools.permutations(day_drivers, len(day_routes)):
                compatible = True
                for route, driver in zip(day_routes, candidate):
                    vehicle = vehicle_by_id[route.route_id or route.vehicle_id]
                    vehicle_type = vehicle.vehicle_type or vehicle.model or ""
                    if not can_driver_drive_vehicle(
                        driver.license_class, vehicle.payload_limit_kg, vehicle_type
                    ):
                        compatible = False
                        break
                if not compatible:
                    continue

                total = sum(
                    driver_cost(route, driver)[0]
                    for route, driver in zip(day_routes, candidate)
                )
                if best_cost is None or total < best_cost:
                    best_cost = total
                    best_assignment = candidate

            if best_assignment is None:
                raise ValueError(
                    "Không thể ghép tài xế có hạng bằng lái phù hợp cho tất cả tuyến."
                )

            for route, driver in zip(day_routes, best_assignment):
                vehicle = vehicle_by_id[route.route_id or route.vehicle_id]
                route.driver_id = driver.source_driver_id or driver.id
                route.driver_name = driver.full_name
                route.driver_license_class = driver.license_class
                route.cost = build_route_cost_breakdown(
                    self.request,
                    self.nodes,
                    self.order_by_id,
                    vehicle,
                    driver,
                    route.stops,
                    route.total_distance_km,
                    route.total_duration_minutes,
                )

    def _calculate_route_economic_metrics(
        self, vehicle: FleetVehicle, stops: List[ScheduledStop]
    ) -> Tuple[int, int, int, float, float]:
        return calculate_route_economic_metrics(
            self.request,
            self.nodes,
            self.order_by_id,
            vehicle,
            stops,
        )

    def _generate_lifo_sequences(self, orders: List[any]) -> List[List[Tuple[str, str, any]]]:
        """
        Sinh các chuỗi dừng thỏa mãn nguyên tắc LIFO (Last-In First-Out) tổng quát:
        Thao tác bốc hàng (Pickup) push vào stack, thao tác dỡ hàng (Delivery) pop phần tử đỉnh stack.
        Bảo đảm 100% không bao giờ có cặp A, B mà P(A) < P(B) < D(A) < D(B) (loại bỏ tận gốc vi phạm T24/T26).
        """
        n = len(orders)
        valid_sequences = []

        def backtrack(current_seq, stack, remaining_pickups):
            if len(current_seq) == 2 * n:
                valid_sequences.append(list(current_seq))
                return
            if len(valid_sequences) >= 600:
                return

            # 1. Có thể pickup thêm đơn hàng mới (nếu còn)
            for o in remaining_pickups:
                rem = [x for x in remaining_pickups if x.id != o.id]
                current_seq.append((o.id, "PICKUP", o))
                stack.append(o.id)
                backtrack(current_seq, stack, rem)
                stack.pop()
                current_seq.pop()

            # 2. Có thể delivery đơn hàng ở đỉnh ngăn xếp (LIFO chuẩn xác)
            if stack:
                top_order_id = stack[-1]
                top_order = next(o for o in orders if o.id == top_order_id)
                current_seq.append((top_order_id, "DELIVERY", top_order))
                stack.pop()
                backtrack(current_seq, stack, remaining_pickups)
                stack.append(top_order_id)
                current_seq.pop()

        backtrack([], [], list(orders))
        return valid_sequences

    def _resequence_stops_for_spatial_feasibility(
        self,
        vehicle: FleetVehicle,
        vehicle_index: int,
        orders: List[any],
        *,
        deadline: Optional[float] = None,
    ) -> Optional[Tuple[List[ScheduledStop], List[StopAction], float, float, any]]:
        """
        Phối hợp định tuyến và bố trí hàng động (Mục 10.5 KE_HOACH_TMS.md):
        Khi lộ trình ban đầu của OR-Tools gây xung đột chắn lối ra cửa thùng (T24/T26),
        thuật toán tự động tìm kiếm hoán vị chuỗi dừng theo nguyên tắc LIFO tổng quát
        sao cho tối thiểu hóa quãng đường và vượt qua 100% kiểm định hình học của SpatialValidator.
        """
        if not orders:
            return None

        node_id_to_idx = {node["id"]: idx for idx, node in enumerate(self.nodes)}

        lifo_sequences = self._generate_lifo_sequences(orders)

        candidates = []
        for seq in lifo_sequences:
            cand_actions = []
            for i, (oid, st_type, o) in enumerate(seq, 1):
                if st_type == "PICKUP":
                    cand_actions.append(
                        StopAction(
                            stop_id=o.pickup_location.id,
                            sequence=i,
                            stop_type="PICKUP",
                            address=o.pickup_location.name,
                            latitude=o.pickup_location.latitude,
                            longitude=o.pickup_location.longitude,
                            items_to_load=o.items,
                        )
                    )
                else:
                    cand_actions.append(
                        StopAction(
                            stop_id=o.delivery_location.id,
                            sequence=i,
                            stop_type="DELIVERY",
                            address=o.delivery_location.name,
                            latitude=o.delivery_location.latitude,
                            longitude=o.delivery_location.longitude,
                            items_to_unload=[it.id for it in o.items],
                        )
                    )

            evaluated = self._evaluate_resequence_candidate(
                vehicle, vehicle_index, cand_actions, node_id_to_idx
            )
            if evaluated is not None:
                candidates.append((evaluated[2], cand_actions, evaluated))

        # Sắp xếp các ứng viên khả thi theo chi phí tăng dần (ưu tiên chuỗi tối ưu nhất)
        candidates.sort(key=lambda c: c[0])

        # Khống chế tổng thời gian tìm kiếm hoán vị hình học tối đa 8 giây và thử tối đa 10 ứng viên tốt nhất
        effective_deadline = (
            deadline
            or getattr(self, "_active_recovery_deadline", None)
            or (time.monotonic() + 8.0)
        )

        # Recovery is bounded per vehicle so one difficult layout cannot starve
        # every later vehicle that may accept the order immediately.
        for score, cand_actions, evaluated in candidates[:3]:
            remaining_seconds = effective_deadline - time.monotonic()
            if remaining_seconds <= 0:
                break
            val = SpatialValidator(
                vehicle,
                max_time_seconds=min(0.8, remaining_seconds),
                max_search_nodes=5000,
            )
            sp = val.validate_plan(cand_actions)
            if sp.is_valid:
                best_schedule, best_dist, best_score, best_duration = evaluated
                return best_schedule, cand_actions, best_dist, best_duration, sp

        return None

    def _evaluate_resequence_candidate(
        self,
        vehicle: FleetVehicle,
        vehicle_index: int,
        actions: List[StopAction],
        node_id_to_idx: Dict[str, int],
    ) -> Optional[Tuple[List[ScheduledStop], float, float, float]]:
        """Build and economically score a spatial fallback within vehicle availability."""
        scheduled: List[ScheduledStop] = []
        current_weight = 0.0
        current_area = 0.0
        max_vehicle_area = vehicle.length_cm * vehicle.width_cm
        current_time = float(vehicle.available_start_sec)
        previous_index = vehicle_index
        total_distance = 0.0
        item_weight_by_id = {
            item.id: item.weight_kg
            for order in self.request.orders
            for item in order.items
        }
        item_area_by_id = {
            item.id: item.length_cm * item.width_cm
            for order in self.request.orders
            for item in order.items
        }

        for action in actions:
            node_index = node_id_to_idx.get(action.stop_id)
            if node_index is None:
                return None
            node = self.nodes[node_index]
            order = node["order"]
            if order is None:
                return None

            total_distance += self.request.distance_matrix_meters[previous_index][node_index]
            current_time += self.request.duration_matrix_seconds[previous_index][node_index]
            arrival = current_time
            if arrival > vehicle.available_end_sec:
                return None

            current_weight += sum(item.weight_kg for item in action.items_to_load)
            current_weight -= sum(
                item_weight_by_id.get(item_id, 0.0)
                for item_id in action.items_to_unload
            )
            if current_weight > vehicle.payload_limit_kg:
                return None

            current_area += sum(item.length_cm * item.width_cm for item in action.items_to_load)
            current_area -= sum(
                item_area_by_id.get(item_id, 0.0)
                for item_id in action.items_to_unload
            )
            if current_area > max_vehicle_area:
                return None

            departure = arrival + order.service_time_sec
            scheduled.append(
                ScheduledStop(
                    sequence=action.sequence,
                    location_id=action.stop_id,
                    location_name=action.address,
                    stop_type=action.stop_type,
                    order_id=order.id,
                    latitude=action.latitude,
                    longitude=action.longitude,
                    arrival_time_sec=round(arrival),
                    departure_time_sec=round(departure),
                    items_loaded=[item.id for item in action.items_to_load],
                    items_unloaded=action.items_to_unload,
                    current_weight_kg=round(max(0.0, current_weight), 2),
                )
            )
            current_time = departure
            previous_index = node_index

        total_distance += self.request.distance_matrix_meters[previous_index][vehicle_index]
        current_time += self.request.duration_matrix_seconds[previous_index][vehicle_index]
        if current_time > vehicle.available_end_sec:
            return None
        (
            base_fuel_cost,
            load_fuel_surcharge,
            cargo_holding_cost,
            _,
            _,
        ) = self._calculate_route_economic_metrics(vehicle, scheduled)
        average_driver_time_cost = sum(
            driver.fixed_salary_monthly_vnd
            * (current_time / 60)
            / self.request.policy.monthly_working_minutes
            for driver in self.request.drivers
        ) / len(self.request.drivers)
        average_driver_distance_cost = sum(
            driver.per_km_pay_vnd * (total_distance / 1000)
            for driver in self.request.drivers
        ) / len(self.request.drivers)
        economic_score = (
            base_fuel_cost
            + load_fuel_surcharge
            + cargo_holding_cost
            + average_driver_time_cost
            + average_driver_distance_cost
        )
        return scheduled, total_distance, economic_score, current_time


class OrToolsRoutingSolver:
    """Compatibility wrapper for the existing one-vehicle endpoint."""

    def __init__(self, request: OptimizationRequest):
        self.request = request

    def solve(self) -> OptimizationResponse:
        vehicle = FleetVehicle(
            **self.request.vehicle.model_dump(),
            depot=self.request.depot,
            fuel_consumption_liters_per_100_km=0,
            fixed_operating_cost_vnd=0,
        )
        fleet_request = FleetOptimizationRequest(
            job_id=self.request.job_id,
            vehicles=[vehicle],
            drivers=[
                DriverOption(
                    id="manual-driver-placeholder",
                    full_name="Điều phối thủ công",
                    fixed_salary_monthly_vnd=0,
                    trip_base_pay_vnd=0,
                    per_km_pay_vnd=0,
                )
            ],
            orders=self.request.orders,
            policy=CostPolicy(
                fuel_price_per_liter_vnd=1,
                monthly_working_minutes=1,
            ),
            max_time_seconds=self.request.max_time_seconds,
            distance_matrix_meters=self.request.distance_matrix_meters,
            duration_matrix_seconds=self.request.duration_matrix_seconds,
        )
        fleet_result = FleetRoutingSolver(fleet_request).solve()
        if fleet_result.routes:
            route = fleet_result.routes[0]
            return OptimizationResponse(
                job_id=self.request.job_id,
                status="SUCCESS" if fleet_result.status == "SUCCESS" else "PARTIAL",
                total_distance_km=route.total_distance_km,
                total_duration_minutes=route.total_duration_minutes,
                stops=route.stops,
                unassigned_order_ids=[item.order_id for item in fleet_result.unassigned_orders],
                spatial_validation=route.spatial_validation,
                diagnostics=fleet_result.diagnostics,
            )
        return OptimizationResponse(
            job_id=self.request.job_id,
            status="TIMEOUT" if fleet_result.status == "TIMEOUT" else "INFEASIBLE",
            unassigned_order_ids=[item.order_id for item in fleet_result.unassigned_orders],
            diagnostics=fleet_result.diagnostics,
        )
