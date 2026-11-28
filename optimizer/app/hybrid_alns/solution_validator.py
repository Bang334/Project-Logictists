"""Independent solution audit ported from algo_lab, using production SpatialValidator."""

import time
from dataclasses import dataclass, field
from itertools import permutations
from typing import Any, Dict, List, Optional, Set, Tuple

from .models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OrderPair,
    PlacedItem,
    ScheduledStop,
)
from .route_evaluator import schedule_and_evaluate_route
from ..models import (
    CargoItem as ProductionCargoItem,
    DemoStackingPolicy,
    StopAction,
    VehicleFloor,
)
from ..packing_rules import calculate_route_weight_balance_penalty_vnd, resolve_can_rotate
from ..stacking import enforce_spatial_weight_balance_if_needed, validate_stop_actions


@dataclass
class SolutionAudit:
    is_valid: bool
    is_contract_valid: bool
    is_temporally_valid: bool
    is_spatial_valid: bool
    served_order_count: int
    total_order_count: int
    issues: List[str] = field(default_factory=list)
    spatially_invalid_vehicle_ids: List[str] = field(default_factory=list)


def _validate_spatial_route(
    vehicle: FleetVehicle,
    stops: List[ScheduledStop],
    cargo_by_id: Dict[str, CargoItem],
    *,
    max_time_seconds: float,
    demo_stacking: DemoStackingPolicy | None = None,
    cost_policy: Optional[CostPolicy] = None,
    step_balances_out: Optional[List[Any]] = None,
) -> Tuple[bool, str, List[List[PlacedItem]], List[List[str]]]:
    floor = VehicleFloor(
        id=vehicle.id,
        plate_number=vehicle.plate_number,
        length_cm=vehicle.length_cm,
        width_cm=vehicle.width_cm,
        height_cm=vehicle.height_cm,
        payload_limit_kg=vehicle.payload_limit_kg,
        door_position="REAR",
    )

    actions: List[StopAction] = []
    for stop in stops:
        missing = [item_id for item_id in stop.items_loaded if item_id not in cargo_by_id]
        if missing:
            return False, f"Thiếu dữ liệu kiện: {', '.join(missing)}", [], []
        items_to_load = [
            ProductionCargoItem(
                id=cargo_by_id[item_id].id,
                order_id=cargo_by_id[item_id].order_id,
                customer_id=getattr(cargo_by_id[item_id], "customer_id", None),
                description=cargo_by_id[item_id].description,
                length_cm=cargo_by_id[item_id].length_cm,
                width_cm=cargo_by_id[item_id].width_cm,
                height_cm=cargo_by_id[item_id].height_cm,
                weight_kg=cargo_by_id[item_id].weight_kg,
                can_rotate=resolve_can_rotate(cargo_by_id[item_id]),
                allowed_orientations=getattr(cargo_by_id[item_id], "allowed_orientations", None),
                cargo_kind=getattr(cargo_by_id[item_id], "cargo_kind", "UNCLASSIFIED"),
                allow_upper_tier=bool(getattr(cargo_by_id[item_id], "allow_upper_tier", False)),
                no_top_load_requested=bool(getattr(cargo_by_id[item_id], "no_top_load_requested", False)),
                max_top_load_g=getattr(cargo_by_id[item_id], "max_top_load_g", None),
            )
            for item_id in stop.items_loaded
        ]
        actions.append(
            StopAction(
                stop_id=f"{stop.sequence}:{stop.location_id}:{stop.order_id}",
                sequence=stop.sequence,
                stop_type=stop.stop_type,
                items_to_load=items_to_load,
                items_to_unload=list(stop.items_unloaded),
            )
        )

    result = enforce_spatial_weight_balance_if_needed(
        demo_stacking,
        validate_stop_actions(
            demo_stacking,
            floor,
            actions,
            max_search_nodes=20_000,
            max_time_seconds=max_time_seconds,
        ),
        cost_policy=cost_policy,
    )
    layouts: List[List[PlacedItem]] = []
    unload_sequences: List[List[str]] = []
    for state in result.step_states:
        if step_balances_out is not None and state.weight_balance is not None:
            step_balances_out.append(state.weight_balance)
        unload_sequences.append(list(state.unload_sequence))
        layouts.append(
            [
                PlacedItem(
                    item_id=item.item_id,
                    order_id=item.order_id,
                    x=item.x,
                    y=item.y,
                    length_cm=item.length_cm,
                    width_cm=item.width_cm,
                )
                for item in state.placed_items
            ]
        )
    reason = result.error_message or result.violation_code or "Hợp lệ"
    return result.is_valid, reason, layouts, unload_sequences


def audit_solution(
    solution: OptimizationSolution,
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    spatial_time_limit_sec: float = 1.5,
) -> SolutionAudit:
    if spatial_time_limit_sec <= 0:
        raise ValueError("spatial_time_limit_sec must be greater than zero")
    spatial_remaining = spatial_time_limit_sec
    order_by_id = {order.id: order for order in orders}
    cargo_by_id = {item.id: item for order in orders for item in order.items}
    vehicle_by_id = {vehicle.id: vehicle for vehicle in vehicles}
    driver_by_id = {driver.id: driver for driver in drivers}
    order_number_to_id = {order.order_number: order.id for order in orders}

    issues: List[str] = []
    contract_valid = True
    temporal_valid = True
    spatial_valid = True
    spatially_invalid_vehicle_ids: List[str] = []
    used_vehicle_ids: Set[str] = set()
    order_route: Dict[str, str] = {}
    pickup_counts = {order.id: 0 for order in orders}
    delivery_counts = {order.id: 0 for order in orders}
    total_cost = 0
    total_distance = 0.0

    for route_index, route in enumerate(solution.routes):
        vehicle = vehicle_by_id.get(route.vehicle.id)
        if vehicle is None:
            contract_valid = False
            issues.append(f"Tuyến {route_index + 1}: xe {route.vehicle.id} không tồn tại")
            continue
        if vehicle.id in used_vehicle_ids:
            contract_valid = False
            issues.append(f"Xe {vehicle.plate_number} bị dùng cho nhiều tuyến")
        used_vehicle_ids.add(vehicle.id)

        driver = driver_by_id.get(route.driver.id)
        if driver is None:
            contract_valid = False
            issues.append(f"Tuyến {route_index + 1}: tài xế {route.driver.id} không tồn tại")
            continue

        for stop in route.stops:
            if stop.order_id not in order_by_id:
                contract_valid = False
                issues.append(f"Tuyến {route_index + 1}: đơn {stop.order_id} không tồn tại")
                continue
            if stop.stop_type == "PICKUP":
                pickup_counts[stop.order_id] += 1
                previous_route = order_route.setdefault(stop.order_id, vehicle.id)
                if previous_route != vehicle.id:
                    contract_valid = False
                    issues.append(f"Đơn {stop.order_id} bị pickup trên nhiều xe")
            elif stop.stop_type == "DELIVERY":
                delivery_counts[stop.order_id] += 1
                previous_route = order_route.setdefault(stop.order_id, vehicle.id)
                if previous_route != vehicle.id:
                    contract_valid = False
                    issues.append(f"Đơn {stop.order_id} giao bằng xe khác xe pickup")

        evaluation = schedule_and_evaluate_route(
            vehicle,
            driver,
            route.stops,
            order_by_id,
            cargo_by_id,
            policy,
            distance_matrix,
            duration_matrix,
            node_id_to_index,
            use_fast_packing=False,
        )
        if not evaluation.feasible:
            temporal_markers = ("time window", "trễ", "pickup", "Tải", "Kết thúc tuyến")
            if any(marker in evaluation.reason for marker in temporal_markers):
                temporal_valid = False
            else:
                contract_valid = False
            issues.append(f"Xe {vehicle.plate_number}: {evaluation.reason}")
            continue

        route.stops = evaluation.stops
        route.cost_breakdown = evaluation.cost
        route.total_distance_km = evaluation.distance_km
        route.total_duration_minutes = evaluation.duration_minutes
        if evaluation.cost is not None:
            total_cost += evaluation.cost.total_cost_vnd
        total_distance += evaluation.distance_km

        if spatial_remaining <= 0:
            route_spatial_valid = False
            reason = "Hết ngân sách kiểm tra bố trí cho toàn nghiệm"
            layouts = []
            unload_sequences = []
        else:
            spatial_started_at = time.monotonic()
            step_balances: List[Any] = []
            route_spatial_valid, reason, layouts, unload_sequences = _validate_spatial_route(
                vehicle,
                route.stops,
                cargo_by_id,
                max_time_seconds=spatial_remaining,
                demo_stacking=getattr(policy, "demo_stacking", None),
                cost_policy=policy,
                step_balances_out=step_balances,
            )
            spatial_remaining -= time.monotonic() - spatial_started_at
        if not route_spatial_valid:
            spatial_valid = False
            spatially_invalid_vehicle_ids.append(vehicle.id)
            issues.append(f"Xe {vehicle.plate_number}: {reason}")
        else:
            if len(layouts) == len(route.stops):
                for stop, layout, unload_sequence in zip(
                    route.stops, layouts, unload_sequences
                ):
                    stop.placed_items = layout
                    if stop.stop_type == "DELIVERY":
                        stop.items_unloaded = unload_sequence
            if (
                route.cost_breakdown is not None
                and int(getattr(policy, "weight_balance_penalty_vnd_per_percent", 0) or 0) > 0
            ):
                wb_pen = calculate_route_weight_balance_penalty_vnd(
                    step_balances, policy, getattr(policy, "demo_stacking", None)
                )
                delta = wb_pen - int(route.cost_breakdown.weight_balance_penalty_vnd or 0)
                if delta:
                    route.cost_breakdown.weight_balance_penalty_vnd = wb_pen
                    route.cost_breakdown.total_cost_vnd += delta
                    total_cost += delta

    served_ids = {
        order.id
        for order in orders
        if pickup_counts[order.id] == 1 and delivery_counts[order.id] == 1
    }
    for order in orders:
        if pickup_counts[order.id] not in {0, 1} or delivery_counts[order.id] not in {0, 1}:
            contract_valid = False
            issues.append(
                f"Đơn {order.order_number}: pickup={pickup_counts[order.id]}, "
                f"delivery={delivery_counts[order.id]}"
            )
        if (pickup_counts[order.id] == 0) != (delivery_counts[order.id] == 0):
            contract_valid = False
            issues.append(f"Đơn {order.order_number} chỉ có một đầu pickup/delivery")

    declared_unassigned_ids = {
        order_number_to_id.get(value, value) for value in solution.unassigned_orders
    }
    expected_unassigned_ids = set(order_by_id) - served_ids
    if declared_unassigned_ids != expected_unassigned_ids:
        contract_valid = False
        issues.append("Danh sách đơn chưa xếp không khớp các tuyến trả về")

    solution.real_economic_cost_vnd = total_cost
    solution.total_distance_km = round(total_distance, 2)
    solution.fulfillment_rate = round(
        len(served_ids) / max(1, len(orders)) * 100.0, 1
    )
    solution.penalized_objective_vnd = (
        total_cost + len(expected_unassigned_ids) * policy.unassigned_order_penalty_vnd
    )
    solution.is_contract_valid = contract_valid
    solution.is_temporally_valid = temporal_valid
    solution.is_spatial_valid = spatial_valid
    solution.spatial_notes = "Hợp lệ" if spatial_valid else "Không đạt validator độc lập"
    solution.validation_notes = issues
    solution.solution_audited = True

    return SolutionAudit(
        is_valid=contract_valid and temporal_valid and spatial_valid,
        is_contract_valid=contract_valid,
        is_temporally_valid=temporal_valid,
        is_spatial_valid=spatial_valid,
        served_order_count=len(served_ids),
        total_order_count=len(orders),
        issues=issues,
        spatially_invalid_vehicle_ids=spatially_invalid_vehicle_ids,
    )


def _repair_spatial_routes(
    solution: OptimizationSolution,
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    spatial_time_limit_sec: float,
    repair_time_limit_sec: float,
    target_vehicle_ids: Set[str],
) -> None:
    deadline = time.monotonic() + max(0.0, repair_time_limit_sec)
    order_by_id = {order.id: order for order in orders}
    cargo_by_id = {item.id: item for order in orders for item in order.items}
    vehicle_by_id = {vehicle.id: vehicle for vehicle in vehicles}
    driver_by_id = {driver.id: driver for driver in drivers}

    for route in solution.routes:
        if time.monotonic() >= deadline:
            return
        if route.vehicle.id not in target_vehicle_ids:
            continue
        vehicle = vehicle_by_id.get(route.vehicle.id)
        driver = driver_by_id.get(route.driver.id)
        if vehicle is None or driver is None:
            continue

        stops_by_order: Dict[str, Dict[str, ScheduledStop]] = {}
        order_ids: List[str] = []
        malformed = False
        for stop in route.stops:
            if stop.order_id is None or stop.stop_type not in {"PICKUP", "DELIVERY"}:
                malformed = True
                break
            if stop.order_id not in stops_by_order:
                stops_by_order[stop.order_id] = {}
                order_ids.append(stop.order_id)
            by_type = stops_by_order[stop.order_id]
            if stop.stop_type in by_type:
                malformed = True
                break
            by_type[stop.stop_type] = stop
        if malformed or any(
            set(by_type) != {"PICKUP", "DELIVERY"}
            for by_type in stops_by_order.values()
        ):
            continue

        if len(order_ids) <= 7:
            orderings = permutations(order_ids)
        else:
            deadline_order = sorted(
                order_ids,
                key=lambda order_id: order_by_id[order_id].delivery_window_end_sec,
            )
            orderings = iter(
                (
                    tuple(order_ids),
                    tuple(deadline_order),
                    tuple(reversed(order_ids)),
                )
            )

        evaluated_candidates = []
        seen_orderings: Set[Tuple[str, ...]] = set()
        for ordering in orderings:
            ordering_tuple = tuple(ordering)
            if ordering_tuple in seen_orderings:
                continue
            seen_orderings.add(ordering_tuple)
            if time.monotonic() >= deadline:
                break
            candidate_stops: List[ScheduledStop] = []
            for order_id in ordering_tuple:
                candidate_stops.append(stops_by_order[order_id]["PICKUP"])
                candidate_stops.append(stops_by_order[order_id]["DELIVERY"])
            evaluation = schedule_and_evaluate_route(
                vehicle,
                driver,
                candidate_stops,
                order_by_id,
                cargo_by_id,
                policy,
                distance_matrix,
                duration_matrix,
                node_id_to_index,
                use_fast_packing=False,
            )
            if evaluation.feasible and evaluation.cost is not None:
                evaluated_candidates.append(evaluation)

        evaluated_candidates.sort(
            key=lambda evaluation: (
                evaluation.cost.total_cost_vnd,
                evaluation.distance_km,
            )
        )
        best = None
        for evaluation in evaluated_candidates:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            valid, _, _, _ = _validate_spatial_route(
                vehicle,
                evaluation.stops,
                cargo_by_id,
                max_time_seconds=min(spatial_time_limit_sec, remaining),
                demo_stacking=getattr(policy, "demo_stacking", None),
                cost_policy=policy,
            )
            if valid:
                best = evaluation
                break

        if best is not None and best.cost is not None:
            route.stops = best.stops
            route.cost_breakdown = best.cost
            route.total_distance_km = best.distance_km
            route.total_duration_minutes = best.duration_minutes


def repair_and_audit_solution(
    solution: OptimizationSolution,
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    *,
    spatial_time_limit_sec: float = 1.5,
    repair_time_limit_sec: float = 5.0,
) -> SolutionAudit:
    """Repair spatially unverified routes, then run the independent audit."""
    initial_audit = audit_solution(
        solution,
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        spatial_time_limit_sec=spatial_time_limit_sec,
    )
    if (
        initial_audit.is_valid
        or not initial_audit.is_contract_valid
        or not initial_audit.is_temporally_valid
        or not initial_audit.spatially_invalid_vehicle_ids
    ):
        return initial_audit

    _repair_spatial_routes(
        solution,
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        spatial_time_limit_sec=spatial_time_limit_sec,
        repair_time_limit_sec=repair_time_limit_sec,
        target_vehicle_ids=set(initial_audit.spatially_invalid_vehicle_ids),
    )
    return audit_solution(
        solution,
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        spatial_time_limit_sec=spatial_time_limit_sec,
    )
