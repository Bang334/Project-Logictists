"""Shared route scheduling and economic evaluation for algorithm benchmarks."""

from dataclasses import dataclass, replace
from typing import Dict, List, Optional, Sequence, Tuple

from ..interprovincial import (
    _item_has_compat_rule,
    is_driver_compatible_with_vehicle,
    is_order_compatible_with_vehicle_and_warehouses,
    items_have_compatibility_conflict,
    resolve_vehicle_end_node_index,
    schedule_route_timeline,
)
from ..models import advance_past_curfews
from ..packing_rules import (
    calculate_route_weight_balance_penalty_vnd,
    resolve_weight_balance_thresholds,
)
from .cost_evaluator import calculate_route_cost
from .models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OrderPair,
    PlacedItem,
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
    total_driving_sec: int = 0


def clone_stops(stops: Sequence[ScheduledStop]) -> List[ScheduledStop]:
    return [
        ScheduledStop(
            sequence=s.sequence,
            stop_type=s.stop_type,
            location_id=s.location_id,
            location_name=s.location_name,
            order_id=s.order_id,
            order_number=s.order_number,
            arrival_time_sec=s.arrival_time_sec,
            departure_time_sec=s.departure_time_sec,
            current_weight_kg=s.current_weight_kg,
            items_loaded=list(s.items_loaded),
            items_unloaded=list(s.items_unloaded),
            placed_items=[
                PlacedItem(
                    item_id=p.item_id,
                    order_id=p.order_id,
                    x=p.x,
                    y=p.y,
                    length_cm=p.length_cm,
                    width_cm=p.width_cm,
                    weight_kg=p.weight_kg,
                    cargo_kind=p.cargo_kind,
                )
                for p in s.placed_items
            ]
            if s.placed_items
            else [],
        )
        for s in stops
    ]


def clone_route_evaluation(evaluation: RouteEvaluation) -> RouteEvaluation:
    return RouteEvaluation(
        feasible=evaluation.feasible,
        stops=clone_stops(evaluation.stops),
        reason=evaluation.reason,
        cost=replace(evaluation.cost) if evaluation.cost is not None else None,
        distance_km=evaluation.distance_km,
        duration_minutes=evaluation.duration_minutes,
    )


def _matrix_index(node_id_to_index: Dict[str, int], node_id: str) -> int:
    if node_id not in node_id_to_index:
        raise ValueError(f"Không tìm thấy node {node_id} trong ma trận")
    return node_id_to_index[node_id]


def _validate_route_packing_cached(
    vehicle: FleetVehicle,
    scheduled: List[ScheduledStop],
    cargo_by_id: Dict[str, CargoItem],
    policy: CostPolicy,
    *,
    allow_layout_search: bool,
    packing_cache: Optional[Dict[Tuple[object, ...], Tuple[bool, str, int]]],
) -> Tuple[bool, str, int]:
    demo_stacking = getattr(policy, "demo_stacking", None)
    enforce_wb, max_lat_wb, max_lon_wb = resolve_weight_balance_thresholds(demo_stacking, policy)
    wb_rate = int(getattr(policy, "weight_balance_penalty_vnd_per_percent", 0) or 0)
    packing_key: Optional[Tuple[object, ...]] = None
    if packing_cache is not None:
        stacking_key = (
            None
            if demo_stacking is None
            else (
                demo_stacking.max_tiers,
                demo_stacking.lift_clearance_cm,
                demo_stacking.owner_mode,
                getattr(demo_stacking, "max_top_load_percent", 30),
            )
        )
        packing_key = (
            float(vehicle.length_cm),
            float(vehicle.width_cm),
            float(vehicle.height_cm),
            float(vehicle.payload_limit_kg),
            vehicle.door_position,
            getattr(vehicle, "door_width_cm", None),
            stacking_key,
            enforce_wb,
            max_lat_wb,
            max_lon_wb,
            wb_rate,
            allow_layout_search,
            tuple(
                (
                    stop.stop_type,
                    stop.order_id or "",
                    tuple(stop.items_loaded),
                    tuple(stop.items_unloaded),
                )
                for stop in scheduled
            ),
        )
        cached = packing_cache.get(packing_key)
        if cached is not None:
            if len(cached) == 2:
                return cached[0], cached[1], 0
            return cached
    checker = FastPackingChecker(
        vehicle,
        allow_layout_search=allow_layout_search,
        demo_stacking=demo_stacking,
        cost_policy=policy,
    )
    if wb_rate > 0:
        ok, reason, step_balances = checker.validate_route_stops_with_balances(scheduled, cargo_by_id)
        wb_penalty = (
            calculate_route_weight_balance_penalty_vnd(step_balances, policy, demo_stacking)
            if ok
            else 0
        )
        result: Tuple[bool, str, int] = (ok, reason, wb_penalty)
    else:
        ok, reason = checker.validate_route_stops(scheduled, cargo_by_id)
        result = (ok, reason, 0)
    if packing_cache is not None and packing_key is not None:
        packing_cache[packing_key] = result
    return result


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
    allow_layout_search: bool = True,
    packing_cache: Optional[Dict[Tuple[object, ...], Tuple[bool, str]]] = None,
) -> RouteEvaluation:
    """Schedule a fixed stop sequence with waiting and enforce hard constraints."""
    if not stops:
        return RouteEvaluation(feasible=True, stops=[])
    if not is_driver_compatible_with_vehicle(driver, vehicle):
        return RouteEvaluation(
            False,
            clone_stops(stops),
            "Tài xế không tương thích với xe, ngày phục vụ hoặc kho/tỉnh xuất phát",
        )

    scheduled = clone_stops(stops)
    depot_idx = _matrix_index(node_id_to_index, vehicle.depot.id)

    onboard_weight = 0.0
    onboard_items = set()
    onboard_cargo_objs: Dict[str, CargoItem] = {}
    picked_orders = set()
    delivered_split_groups = set()
    physical_vehicle_id = vehicle.source_vehicle_id or vehicle.id
    stop_weights: List[float] = []

    for stop in scheduled:
        order = order_by_id.get(stop.order_id or "")
        if order is None:
            return RouteEvaluation(False, scheduled, f"Đơn {stop.order_id} không tồn tại")
        if stop.stop_type not in {"PICKUP", "DELIVERY"}:
            return RouteEvaluation(False, scheduled, f"Loại stop {stop.stop_type} không hợp lệ")

        if not is_order_compatible_with_vehicle_and_warehouses(order, vehicle):
            return RouteEvaluation(
                False,
                scheduled,
                f"Đơn {order.order_number} không tương thích với xe {vehicle.plate_number} hoặc hạ tầng kho",
            )

        _matrix_index(node_id_to_index, stop.location_id)
        expected_items = {item.id for item in order.items}
        if stop.stop_type == "PICKUP":
            if order.split_group_id and order.split_group_id in delivered_split_groups:
                return RouteEvaluation(
                    False,
                    scheduled,
                    "Không lấy thêm phần của cùng yêu cầu sau khi đã bắt đầu giao",
                )
            if set(stop.items_loaded) != expected_items or stop.items_unloaded:
                return RouteEvaluation(
                    False,
                    scheduled,
                    f"Pickup của đơn {order.order_number} không khớp danh sách kiện",
                )
            if order.id in picked_orders:
                return RouteEvaluation(
                    False, scheduled, f"Đơn {order.order_number} được pickup nhiều lần"
                )
            if onboard_cargo_objs and items_have_compatibility_conflict(
                list(onboard_cargo_objs.values()), order.items
            ):
                return RouteEvaluation(
                    False,
                    scheduled,
                    f"Đơn {order.order_number} xung đột nhóm hàng hoặc nhiệt độ với hàng đang trên xe",
                )
            picked_orders.add(order.id)
            onboard_weight += order.total_weight_kg
            onboard_items.update(expected_items)
            for item in order.items:
                if _item_has_compat_rule(item):
                    onboard_cargo_objs[item.id] = item
        else:
            if order.id not in picked_orders:
                return RouteEvaluation(
                    False, scheduled, f"Giao đơn {order.order_number} trước khi pickup"
                )
            if set(stop.items_unloaded) != expected_items or stop.items_loaded:
                return RouteEvaluation(
                    False,
                    scheduled,
                    f"Delivery của đơn {order.order_number} không khớp danh sách kiện",
                )
            if not expected_items.issubset(onboard_items):
                return RouteEvaluation(
                    False, scheduled, f"Thiếu kiện khi giao đơn {order.order_number}"
                )
            onboard_weight -= order.total_weight_kg
            onboard_items.difference_update(expected_items)
            for item in order.items:
                onboard_cargo_objs.pop(item.id, None)
            if order.split_group_id:
                delivered_split_groups.add(order.split_group_id)

        if onboard_weight < -0.01 or onboard_weight > vehicle.payload_limit_kg + 0.01:
            return RouteEvaluation(
                False,
                scheduled,
                f"Tải {onboard_weight:.2f} kg ngoài giới hạn xe {vehicle.plate_number}",
            )
        stop_weights.append(max(0.0, onboard_weight))

    if onboard_items or abs(onboard_weight) > 0.01:
        return RouteEvaluation(False, scheduled, "Kết thúc tuyến vẫn còn hàng trên xe")

    end_depot = getattr(vehicle, "end_depot", None)
    if end_depot is not None:
        end_depot_idx: Optional[int] = _matrix_index(node_id_to_index, end_depot.id)
    elif not getattr(vehicle, "return_to_depot", True):
        end_depot_idx = None
    else:
        end_depot_idx = depot_idx

    timeline = schedule_route_timeline(
        vehicle=vehicle,
        vehicle_index=depot_idx,
        stops=scheduled,
        order_by_id=order_by_id,
        distance_matrix=distance_matrix,
        duration_matrix=duration_matrix,
        stop_node_resolver=lambda s: node_id_to_index.get(s.location_id),
        end_node_index=end_depot_idx,
        rest_policy=getattr(policy, "driving_rest_policy", None),
        apply_jit_start=True,
    )
    if not timeline.feasible:
        return RouteEvaluation(False, scheduled, timeline.reason)

    scheduled = list(timeline.scheduled_stops)
    for st, weight in zip(scheduled, stop_weights):
        st.current_weight_kg = weight

    wb_penalty_vnd = 0
    if use_fast_packing:
        packing_ok, packing_reason, wb_penalty_vnd = _validate_route_packing_cached(
            vehicle,
            scheduled,
            cargo_by_id,
            policy,
            allow_layout_search=allow_layout_search,
            packing_cache=packing_cache,
        )
        if not packing_ok:
            return RouteEvaluation(False, scheduled, packing_reason)

    duration_override = round(
        max(0, timeline.route_end_sec - timeline.route_start_sec) / 60.0, 1
    )
    cost, distance_km, duration_minutes = calculate_route_cost(
        vehicle,
        driver,
        scheduled,
        order_by_id,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        route_duration_minutes_override=duration_override,
        end_node_index_override=end_depot_idx,
        rest_breaks=timeline.rest_breaks,
        weight_balance_penalty_vnd=wb_penalty_vnd,
    )
    return RouteEvaluation(
        feasible=True,
        stops=scheduled,
        cost=cost,
        distance_km=distance_km,
        duration_minutes=duration_minutes,
        total_driving_sec=timeline.total_driving_sec,
    )
