import itertools
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .models import (
    BenchmarkComparisonResponse,
    BenchmarkMetric,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
    StopAction,
    can_driver_drive_vehicle,
)
from .route_costing import build_route_cost_breakdown
from .spatial_validator import SpatialValidator


@dataclass
class _EvaluatedRoute:
    vehicle: FleetVehicle
    stops: List[ScheduledStop]
    distance_meters: float
    duration_seconds: float
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
    ) -> _EvaluatedRoute:
        current_node = vehicle_index
        current_time = 0.0
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
            travel_seconds = self.request.duration_matrix_seconds[current_node][node_index]
            total_distance += self.request.distance_matrix_meters[current_node][node_index]
            arrival_without_wait = current_time + travel_seconds
            if action.stop_type == "PICKUP":
                window_start = order.pickup_window_start_sec
                window_end = order.pickup_window_end_sec
            else:
                window_start = order.delivery_window_start_sec
                window_end = order.delivery_window_end_sec
            arrival = max(arrival_without_wait, window_start)
            if arrival > window_end:
                late_minutes = round((arrival - window_end) / 60, 1)
                violations.append(
                    f"TIME_WINDOW:{order.order_number} {action.stop_type} trễ {late_minutes} phút"
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

            departure = arrival + order.service_time_sec
            scheduled.append(
                ScheduledStop(
                    sequence=len(scheduled) + 1,
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
            current_node = node_index

        total_distance += self.request.distance_matrix_meters[current_node][vehicle_index]
        current_time += self.request.duration_matrix_seconds[current_node][vehicle_index]

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
        if not violations:
            spatial = SpatialValidator(vehicle, max_search_nodes=2000).validate_plan(actions)
            if not spatial.is_valid:
                violations.append(
                    f"SPATIAL:{spatial.error_message or spatial.violation_code or 'Bố trí xếp/dỡ không hợp lệ'}"
                )
        return _EvaluatedRoute(
            vehicle=vehicle,
            stops=scheduled,
            distance_meters=total_distance,
            duration_seconds=current_time,
            violations=violations,
        )

    @staticmethod
    def _is_driver_compatible(driver: DriverOption, vehicle: FleetVehicle) -> bool:
        vehicle_type = vehicle.vehicle_type or vehicle.model or ""
        return can_driver_drive_vehicle(
            driver.license_class, vehicle.payload_limit_kg, vehicle_type
        )

    def _route_cost(self, route: _EvaluatedRoute, driver: DriverOption):
        return build_route_cost_breakdown(
            self.request,
            self.nodes,
            self.order_by_id,
            route.vehicle,
            driver,
            route.stops,
            route.distance_meters / 1000,
            route.duration_seconds / 60,
        )

    def _empty_metric(self, method_name: str, description: str) -> BenchmarkMetric:
        return BenchmarkMetric(
            method_name=method_name,
            description=description,
            total_cost_vnd=0,
            total_distance_km=0,
            total_duration_minutes=0,
            vehicles_used=0,
            fuel_cost_vnd=0,
            vehicle_fixed_cost_vnd=0,
            driver_cost_vnd=0,
            cargo_holding_cost_vnd=0,
            is_feasible=False,
            violations=["INPUT:Không có đủ đơn, xe hoặc tài xế để đối chuẩn"],
        )

    def compute_direct_dedicated(self) -> BenchmarkMetric:
        """Estimate one independent depot-pickup-delivery-depot trip per order."""
        if not self.orders or not self.vehicles or not self.drivers:
            return self._empty_metric(
                "Direct Dedicated (Đơn lẻ)",
                "Mỗi đơn dùng một lượt chuyến riêng, không ghép đơn",
            )

        chosen: List[Tuple[_EvaluatedRoute, DriverOption, object]] = []
        violations: List[str] = []
        for order in self.orders:
            candidates: List[Tuple[int, _EvaluatedRoute, DriverOption, object]] = []
            for vehicle_index, vehicle in enumerate(self.vehicles):
                route = self._evaluate_actions(
                    vehicle, vehicle_index, self._actions_for_order(order)
                )
                if route.violations:
                    continue
                for driver in self.drivers:
                    if not self._is_driver_compatible(driver, vehicle):
                        continue
                    cost = self._route_cost(route, driver)
                    candidates.append((cost.total_cost_vnd, route, driver, cost))
            if not candidates:
                violations.append(
                    f"NO_FEASIBLE_TRIP:{order.order_number} không có xe/tài xế và bố trí hợp lệ"
                )
                continue
            _, route, driver, cost = min(candidates, key=lambda candidate: candidate[0])
            chosen.append((route, driver, cost))

        fuel = sum(cost.fuel_cost_vnd for _, _, cost in chosen)
        fixed = sum(cost.vehicle_fixed_cost_vnd for _, _, cost in chosen)
        driver_cost = sum(
            cost.driver_fixed_salary_allocation_vnd + cost.driver_trip_pay_vnd
            for _, _, cost in chosen
        )
        holding = sum(cost.cargo_holding_cost_vnd for _, _, cost in chosen)
        return BenchmarkMetric(
            method_name="Direct Dedicated (Đơn lẻ)",
            description="Mỗi đơn dùng một lượt chuyến độc lập đã kiểm tra tải, giờ và xếp/dỡ",
            total_cost_vnd=fuel + fixed + driver_cost + holding,
            total_distance_km=round(
                sum(route.distance_meters for route, _, _ in chosen) / 1000, 2
            ),
            total_duration_minutes=round(
                sum(route.duration_seconds for route, _, _ in chosen) / 60, 1
            ),
            vehicles_used=len(chosen),
            fuel_cost_vnd=fuel,
            vehicle_fixed_cost_vnd=fixed,
            driver_cost_vnd=driver_cost,
            cargo_holding_cost_vnd=holding,
            is_feasible=not violations and len(chosen) == len(self.orders),
            violations=violations,
        )

    @staticmethod
    def _savings(
        baseline: BenchmarkMetric, optimized_cost: int
    ) -> Tuple[Optional[int], Optional[float]]:
        if not baseline.is_feasible or baseline.total_cost_vnd <= 0:
            return None, None
        difference = baseline.total_cost_vnd - optimized_cost
        return difference, round(difference / baseline.total_cost_vnd * 100, 1)

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
        ortools_driver = sum(
            route.cost.driver_fixed_salary_allocation_vnd
            + route.cost.driver_trip_pay_vnd
            for route in ortools_routes
            if route.cost
        )
        ortools_holding = sum(
            route.cost.cargo_holding_cost_vnd for route in ortools_routes if route.cost
        )
        ortools_metric = BenchmarkMetric(
            method_name="Google OR-Tools Metaheuristic",
            description="Nghiệm khả thi tốt nhất tìm thấy trong giới hạn thời gian",
            total_cost_vnd=ortools_total_cost_vnd,
            total_distance_km=ortools_total_distance_km,
            total_duration_minutes=ortools_total_duration_minutes,
            vehicles_used=len(ortools_routes),
            fuel_cost_vnd=ortools_fuel,
            vehicle_fixed_cost_vnd=ortools_fixed,
            driver_cost_vnd=ortools_driver,
            cargo_holding_cost_vnd=ortools_holding,
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
