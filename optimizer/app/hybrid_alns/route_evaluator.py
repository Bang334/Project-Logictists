"""Shared route scheduling and economic evaluation for algorithm benchmarks."""

from copy import deepcopy
from dataclasses import dataclass
from typing import Dict, List, Optional

from .cost_evaluator import calculate_route_cost
from .models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
)
from .packing_checker import FastPackingChecker


@dataclass
class RouteEvaluation:
    feasible: bool
    stops: List[ScheduledStop]
    reason: str = ""
    cost: Optional[RouteCostBreakdown] = None
    distance_km: float = 0.0
    duration_minutes: float = 0.0


def _matrix_index(node_id_to_index: Dict[str, int], node_id: str) -> int:
    if node_id not in node_id_to_index:
        raise ValueError(f"Không tìm thấy node {node_id} trong ma trận")
    return node_id_to_index[node_id]


def schedule_and_evaluate_route(
    vehicle: FleetVehicle,
    driver: DriverOption,
    stops: List[ScheduledStop],
    order_by_id: Dict[str, OrderPair],
    cargo_by_id: Dict[str, CargoItem],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    use_fast_packing: bool = True,
) -> RouteEvaluation:
    """Schedule a fixed stop sequence with waiting and enforce hard constraints."""
    if not stops:
        return RouteEvaluation(feasible=True, stops=[])
    if driver.service_day_index != vehicle.service_day_index:
        return RouteEvaluation(
            False,
            deepcopy(stops),
            "Tài xế và xe không cùng ngày phục vụ",
        )

    scheduled = deepcopy(stops)
    depot_idx = _matrix_index(node_id_to_index, vehicle.depot.id)

    first = scheduled[0]
    first_order = order_by_id.get(first.order_id or "")
    if first_order is None:
        return RouteEvaluation(False, scheduled, f"Đơn {first.order_id} không tồn tại")
    first_idx = _matrix_index(node_id_to_index, first.location_id)
    first_transit = float(duration_matrix[depot_idx][first_idx])
    first_window_start = (
        first_order.pickup_window_start_sec
        if first.stop_type == "PICKUP"
        else first_order.delivery_window_start_sec
    )
    # The vehicle may leave the depot just in time for the first window, but
    # never before the production availability window starts.
    current_time = max(
        float(vehicle.available_start_sec),
        first_window_start - first_transit,
    )
    previous_idx = depot_idx
    onboard_weight = 0.0
    onboard_items = set()
    picked_orders = set()

    for sequence, stop in enumerate(scheduled, start=1):
        order = order_by_id.get(stop.order_id or "")
        if order is None:
            return RouteEvaluation(False, scheduled, f"Đơn {stop.order_id} không tồn tại")
        if stop.stop_type not in {"PICKUP", "DELIVERY"}:
            return RouteEvaluation(False, scheduled, f"Loại stop {stop.stop_type} không hợp lệ")

        physical_vehicle_id = vehicle.source_vehicle_id or vehicle.id
        if order.allowed_source_vehicle_ids and not (
            physical_vehicle_id in order.allowed_source_vehicle_ids
            or vehicle.id in order.allowed_source_vehicle_ids
        ):
            return RouteEvaluation(
                False,
                scheduled,
                f"Đơn {order.order_number} không cho phép xe {vehicle.plate_number}",
            )

        current_idx = _matrix_index(node_id_to_index, stop.location_id)
        transit = float(duration_matrix[previous_idx][current_idx])
        if transit < 0:
            return RouteEvaluation(False, scheduled, "Ma trận thời gian chứa giá trị âm")

        raw_arrival = current_time + transit
        if stop.stop_type == "PICKUP":
            window_start = order.pickup_window_start_sec
            window_end = order.pickup_window_end_sec
            expected_items = {item.id for item in order.items}
            if set(stop.items_loaded) != expected_items or stop.items_unloaded:
                return RouteEvaluation(
                    False,
                    scheduled,
                    f"Pickup của đơn {order.order_number} không khớp danh sách kiện",
                )
            if order.id in picked_orders:
                return RouteEvaluation(False, scheduled, f"Đơn {order.order_number} được pickup nhiều lần")
            picked_orders.add(order.id)
            onboard_weight += order.total_weight_kg
            onboard_items.update(expected_items)
        else:
            window_start = order.delivery_window_start_sec
            window_end = order.delivery_window_end_sec
            expected_items = {item.id for item in order.items}
            if order.id not in picked_orders:
                return RouteEvaluation(False, scheduled, f"Giao đơn {order.order_number} trước khi pickup")
            if set(stop.items_unloaded) != expected_items or stop.items_loaded:
                return RouteEvaluation(
                    False,
                    scheduled,
                    f"Delivery của đơn {order.order_number} không khớp danh sách kiện",
                )
            if not expected_items.issubset(onboard_items):
                return RouteEvaluation(False, scheduled, f"Thiếu kiện khi giao đơn {order.order_number}")
            onboard_weight -= order.total_weight_kg
            onboard_items.difference_update(expected_items)

        arrival = max(raw_arrival, float(window_start))
        if arrival > window_end + 0.01:
            return RouteEvaluation(
                False,
                scheduled,
                f"{stop.stop_type} đơn {order.order_number} trễ time window "
                f"({arrival:.0f} > {window_end})",
            )
        if onboard_weight < -0.01 or onboard_weight > vehicle.payload_limit_kg + 0.01:
            return RouteEvaluation(
                False,
                scheduled,
                f"Tải {onboard_weight:.2f} kg ngoài giới hạn xe {vehicle.plate_number}",
            )

        stop.sequence = sequence
        stop.arrival_time_sec = int(round(arrival))
        stop.departure_time_sec = stop.arrival_time_sec + order.service_time_sec
        if stop.departure_time_sec > vehicle.available_end_sec:
            return RouteEvaluation(
                False,
                scheduled,
                f"Xe {vehicle.plate_number} vượt thời gian sẵn sàng",
            )
        stop.current_weight_kg = max(0.0, onboard_weight)
        current_time = float(stop.departure_time_sec)
        previous_idx = current_idx

    if onboard_items or abs(onboard_weight) > 0.01:
        return RouteEvaluation(False, scheduled, "Kết thúc tuyến vẫn còn hàng trên xe")

    end_depot = vehicle.end_depot or vehicle.depot
    end_depot_idx = _matrix_index(node_id_to_index, end_depot.id)
    return_transit = float(duration_matrix[previous_idx][end_depot_idx])
    if return_transit < 0:
        return RouteEvaluation(False, scheduled, "Ma trận thời gian chứa giá trị âm")
    if current_time + return_transit > vehicle.available_end_sec:
        return RouteEvaluation(
            False,
            scheduled,
            f"Xe {vehicle.plate_number} không kịp về điểm kết thúc trong ca",
        )

    if use_fast_packing:
        packing_ok, packing_reason = FastPackingChecker(vehicle).validate_route_stops(
            scheduled, cargo_by_id
        )
        if not packing_ok:
            return RouteEvaluation(False, scheduled, packing_reason)

    cost, distance_km, duration_minutes = calculate_route_cost(
        vehicle,
        driver,
        scheduled,
        order_by_id,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
    )
    return RouteEvaluation(
        feasible=True,
        stops=scheduled,
        cost=cost,
        distance_km=distance_km,
        duration_minutes=duration_minutes,
    )
