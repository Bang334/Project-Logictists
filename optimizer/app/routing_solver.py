import itertools
import math
import time
from typing import Dict, List, Tuple, Optional

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
    RouteCostBreakdown,
    ScheduledStop,
    StopAction,
    UnassignedOrder,
    can_driver_drive_vehicle,
)
from .spatial_validator import SpatialValidator


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

            routing.SetFixedCostOfVehicle(
                round(
                    (vehicle.fixed_operating_cost_vnd + average_driver_trip_base_vnd)
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
        routing.AddDimension(time_callback_index, max_time_horizon, max_time_horizon, True, "Time")
        time_dimension = routing.GetDimensionOrDie("Time")
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
            [round((v.length_cm * v.width_cm * 0.75) / area_scale) for v in self.request.vehicles],
            True,
            "Area",
        )

        # Dimension 3: Cân bằng phân bổ đội xe (Fleet Balancing)
        # Khi có nhiều xe và nhiều đơn, phân bổ đồng đều giữa các xe thay vì dồn hết vào 1 xe nhỏ
        if vehicle_count > 1 and len(self.request.orders) > vehicle_count:
            max_orders_per_veh = int(math.ceil(len(self.request.orders) / vehicle_count)) + 1
            def count_callback(from_index: int) -> int:
                node = self.nodes[manager.IndexToNode(from_index)]
                return 1 if node["type"] == "PICKUP" else 0
            count_callback_index = routing.RegisterUnaryTransitCallback(count_callback)
            routing.AddDimensionWithVehicleCapacity(
                count_callback_index,
                0,
                [max_orders_per_veh] * vehicle_count,
                True,
                "OrderCount",
            )

        pair_penalty = (
            self.request.policy.unassigned_order_penalty_vnd * OBJECTIVE_COST_SCALE
        )
        for order_index, order in enumerate(self.request.orders):
            pickup_node = vehicle_count + 2 * order_index
            delivery_node = pickup_node + 1
            pickup_index = manager.NodeToIndex(pickup_node)
            delivery_index = manager.NodeToIndex(delivery_node)

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
                order.pickup_window_start_sec, order.pickup_window_end_sec
            )
            time_dimension.CumulVar(delivery_index).SetRange(
                order.delivery_window_start_sec, order.delivery_window_end_sec
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
        spatially_rejected: Dict[str, str] = {}

        for vehicle_index, vehicle in enumerate(self.request.vehicles):
            index = routing.Start(vehicle_index)
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
                reseq = self._resequence_stops_for_spatial_feasibility(
                    vehicle,
                    vehicle_index,
                    [self.order_by_id[oid] for oid in route_order_ids if oid in self.order_by_id],
                )
                if reseq is not None:
                    scheduled_stops, stop_actions, route_distance_meters, route_duration_seconds, spatial = reseq
                else:
                    for order_id in route_order_ids:
                        spatially_rejected[order_id] = spatial.error_message or "Bố trí xếp/dỡ không hợp lệ"
                    continue
            else:
                route_duration_seconds = solution.Value(
                    time_dimension.CumulVar(routing.End(vehicle_index))
                )
            routes.append(
                OptimizedRoute(
                    vehicle_id=vehicle.id,
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

        self._assign_drivers_and_costs(routes)

        unassigned: List[UnassignedOrder] = []
        for order in self.request.orders:
            if order.id in assigned_order_ids:
                continue
            if order.id in spatially_rejected:
                code = "SPATIAL_VALIDATION_FAILED"
                message = spatially_rejected[order.id]
            else:
                code = "NO_FEASIBLE_ASSIGNMENT"
                message = "Không còn xe/tài xế hoặc không thỏa tải trọng và time window."
            unassigned.append(
                UnassignedOrder(
                    order_id=order.id,
                    order_number=order.order_number,
                    reason_code=code,
                    reason_message=message,
                )
            )

        result_status = "SUCCESS" if routes and not unassigned else "PARTIAL" if routes else "INFEASIBLE"
        return FleetOptimizationResponse(
            job_id=self.request.job_id,
            status=result_status,
            routes=routes,
            unassigned_orders=unassigned,
            total_distance_km=round(sum(route.total_distance_km for route in routes), 2),
            total_duration_minutes=round(sum(route.total_duration_minutes for route in routes), 1),
            total_cost_vnd=sum(route.cost.total_cost_vnd for route in routes if route.cost),
            diagnostics=[
                "Mục tiêu OR-Tools gồm nhiên liệu nền, phụ trội nhiên liệu theo tải từng chặng, "
                "thời gian/km tài xế và thời gian hàng nằm trên xe.",
                "Chi phí tài xế dùng mức bình quân đội xe khi tạo tuyến; sau đó ghép tài xế và "
                "tính lại bảng chi phí theo đúng tài xế được chọn.",
                "Kết quả là nghiệm khả thi tốt nhất tìm thấy trong thời gian cho phép, không khẳng định tối ưu toàn cục.",
            ],
        )

    def _assign_drivers_and_costs(self, routes: List[OptimizedRoute]) -> None:
        if not routes:
            return
        drivers = self.request.drivers
        vehicle_by_id = {vehicle.id: vehicle for vehicle in self.request.vehicles}

        def driver_cost(route: OptimizedRoute, driver: DriverOption) -> Tuple[int, int, int]:
            fixed_allocation = round(
                driver.fixed_salary_monthly_vnd
                * route.total_duration_minutes
                / self.request.policy.monthly_working_minutes
            )
            trip_pay = driver.trip_base_pay_vnd + round(
                driver.per_km_pay_vnd * route.total_distance_km
            )
            return fixed_allocation + trip_pay, fixed_allocation, trip_pay

        best_assignment = None
        best_cost = None

        # 1. Lọc các hoán vị thỏa mãn 100% quy chuẩn Giấy phép lái xe (GPLX)
        for candidate in itertools.permutations(drivers, len(routes)):
            is_valid_licenses = True
            for route, driver in zip(routes, candidate):
                vehicle = vehicle_by_id[route.vehicle_id]
                v_type = getattr(vehicle, "vehicle_type", "") or getattr(vehicle, "model", "")
                if not can_driver_drive_vehicle(driver.license_class, vehicle.payload_limit_kg, v_type):
                    is_valid_licenses = False
                    break

            if not is_valid_licenses:
                continue

            total = sum(driver_cost(route, driver)[0] for route, driver in zip(routes, candidate))
            if best_cost is None or total < best_cost:
                best_cost = total
                best_assignment = candidate

        # 2. Fallback an toàn nếu đội ngũ tài xế không đủ hạng bằng đáp ứng
        if best_assignment is None:
            for candidate in itertools.permutations(drivers, len(routes)):
                total = sum(driver_cost(route, driver)[0] for route, driver in zip(routes, candidate))
                if best_cost is None or total < best_cost:
                    best_cost = total
                    best_assignment = candidate

        assert best_assignment is not None
        for route, driver in zip(routes, best_assignment):
            vehicle = vehicle_by_id[route.vehicle_id]
            _, fixed_allocation, trip_pay = driver_cost(route, driver)
            (
                base_fuel_cost,
                load_fuel_surcharge,
                cargo_holding_cost,
                cargo_distance_ton_km,
                cargo_time_ton_hours,
            ) = self._calculate_route_economic_metrics(vehicle, route.stops)
            fuel_cost = base_fuel_cost + load_fuel_surcharge
            total = (
                fuel_cost
                + vehicle.fixed_operating_cost_vnd
                + fixed_allocation
                + trip_pay
                + cargo_holding_cost
            )
            route.driver_id = driver.id
            route.driver_name = driver.full_name
            route.driver_license_class = driver.license_class
            route.cost = RouteCostBreakdown(
                base_fuel_cost_vnd=base_fuel_cost,
                load_fuel_surcharge_vnd=load_fuel_surcharge,
                fuel_cost_vnd=fuel_cost,
                cargo_holding_cost_vnd=cargo_holding_cost,
                cargo_distance_ton_km=cargo_distance_ton_km,
                cargo_time_ton_hours=cargo_time_ton_hours,
                vehicle_fixed_cost_vnd=vehicle.fixed_operating_cost_vnd,
                driver_fixed_salary_allocation_vnd=fixed_allocation,
                driver_trip_pay_vnd=trip_pay,
                total_cost_vnd=total,
            )

    def _calculate_route_economic_metrics(
        self, vehicle: FleetVehicle, stops: List[ScheduledStop]
    ) -> Tuple[int, int, int, float, float]:
        """Calculate traceable leg-level fuel and cargo carrying metrics."""
        node_index_by_id = {node["id"]: index for index, node in enumerate(self.nodes)}
        vehicle_index = next(
            index for index, candidate in enumerate(self.request.vehicles)
            if candidate.id == vehicle.id
        )
        previous_node = vehicle_index
        onboard_weight_kg = 0.0
        base_fuel_liters = 0.0
        load_fuel_surcharge_liters = 0.0
        cargo_distance_kg_m = 0.0

        for stop in stops:
            node_index = node_index_by_id[stop.location_id]
            distance_meters = self.request.distance_matrix_meters[previous_node][node_index]
            base_leg_liters = (
                distance_meters
                / 100_000
                * vehicle.fuel_consumption_liters_per_100_km
            )
            load_ratio = min(1.0, max(0.0, onboard_weight_kg / vehicle.payload_limit_kg))
            base_fuel_liters += base_leg_liters
            load_fuel_surcharge_liters += (
                base_leg_liters
                * vehicle.load_fuel_surcharge_percent_at_full_payload
                / 100
                * load_ratio
            )
            cargo_distance_kg_m += onboard_weight_kg * distance_meters
            onboard_weight_kg = stop.current_weight_kg
            previous_node = node_index

        return_distance_meters = self.request.distance_matrix_meters[previous_node][vehicle_index]
        return_base_liters = (
            return_distance_meters
            / 100_000
            * vehicle.fuel_consumption_liters_per_100_km
        )
        return_load_ratio = min(1.0, max(0.0, onboard_weight_kg / vehicle.payload_limit_kg))
        base_fuel_liters += return_base_liters
        load_fuel_surcharge_liters += (
            return_base_liters
            * vehicle.load_fuel_surcharge_percent_at_full_payload
            / 100
            * return_load_ratio
        )
        cargo_distance_kg_m += onboard_weight_kg * return_distance_meters

        pickup_by_order = {
            stop.order_id: stop for stop in stops
            if stop.order_id and stop.stop_type == "PICKUP"
        }
        delivery_by_order = {
            stop.order_id: stop for stop in stops
            if stop.order_id and stop.stop_type == "DELIVERY"
        }
        cargo_time_kg_seconds = 0.0
        for order_id, pickup in pickup_by_order.items():
            delivery = delivery_by_order.get(order_id)
            order = self.order_by_id.get(order_id)
            if delivery is None or order is None:
                continue
            order_weight_kg = sum(item.weight_kg for item in order.items)
            onboard_seconds = max(0, delivery.arrival_time_sec - pickup.departure_time_sec)
            cargo_time_kg_seconds += order_weight_kg * onboard_seconds

        fuel_price = self.request.policy.fuel_price_per_liter_vnd
        base_fuel_cost = round(base_fuel_liters * fuel_price)
        load_fuel_surcharge = round(load_fuel_surcharge_liters * fuel_price)
        cargo_time_ton_hours = cargo_time_kg_seconds / (1000 * 3600)
        cargo_holding_cost = round(
            cargo_time_ton_hours
            * self.request.policy.cargo_holding_cost_vnd_per_ton_hour
        )
        return (
            base_fuel_cost,
            load_fuel_surcharge,
            cargo_holding_cost,
            round(cargo_distance_kg_m / 1_000_000, 3),
            round(cargo_time_ton_hours, 3),
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
    ) -> Optional[Tuple[List[ScheduledStop], List[StopAction], float, float, any]]:
        """
        Phối hợp định tuyến và bố trí hàng động (Mục 10.5 KE_HOACH_TMS.md):
        Khi lộ trình ban đầu của OR-Tools gây xung đột chắn lối ra cửa thùng (T24/T26),
        thuật toán tự động tìm kiếm hoán vị chuỗi dừng theo nguyên tắc LIFO tổng quát
        sao cho tối thiểu hóa quãng đường và vượt qua 100% kiểm định hình học của SpatialValidator.
        """
        val = SpatialValidator(vehicle)
        if not orders:
            return None

        node_id_to_idx = {node["id"]: idx for idx, node in enumerate(self.nodes)}

        best_actions = None
        best_schedule = None
        best_dist = 0.0
        best_duration = 0.0
        best_score = float("inf")
        best_spatial = None

        lifo_sequences = self._generate_lifo_sequences(orders)

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
            if evaluated is not None and evaluated[2] < best_score:
                sp = val.validate_plan(cand_actions)
                if sp.is_valid:
                    best_schedule, best_dist, best_score, best_duration = evaluated
                    best_actions = cand_actions
                    best_spatial = sp

        if not best_actions or not best_schedule or not best_spatial:
            return None

        return best_schedule, best_actions, best_dist, best_duration, best_spatial

    def _evaluate_resequence_candidate(
        self,
        vehicle: FleetVehicle,
        vehicle_index: int,
        actions: List[StopAction],
        node_id_to_idx: Dict[str, int],
    ) -> Optional[Tuple[List[ScheduledStop], float, float, float]]:
        """Build and economically score a spatial fallback without bypassing windows."""
        scheduled: List[ScheduledStop] = []
        current_weight = 0.0
        current_time = 0.0
        previous_index = vehicle_index
        total_distance = 0.0
        item_weight_by_id = {
            item.id: item.weight_kg
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
            if action.stop_type == "PICKUP":
                window_start = order.pickup_window_start_sec
                window_end = order.pickup_window_end_sec
            else:
                window_start = order.delivery_window_start_sec
                window_end = order.delivery_window_end_sec
            arrival = max(current_time, window_start)
            if arrival > window_end:
                return None

            current_weight += sum(item.weight_kg for item in action.items_to_load)
            current_weight -= sum(
                item_weight_by_id.get(item_id, 0.0)
                for item_id in action.items_to_unload
            )
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
