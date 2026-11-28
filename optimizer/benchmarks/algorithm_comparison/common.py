"""Common data contracts, converters and validation helpers for algorithm comparison."""

from __future__ import annotations

import copy
from dataclasses import asdict, dataclass
import os
import sys
import time
from typing import Dict, List, Optional, Sequence, Set, Tuple

# Ensure optimizer directory is in python sys.path
current_dir = os.path.dirname(os.path.abspath(__file__))
optimizer_dir = os.path.abspath(os.path.join(current_dir, "..", ".."))
if optimizer_dir not in sys.path:
    sys.path.insert(0, optimizer_dir)

from app.models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle as ProdVehicle,
    OrderPair as ProdOrder,
    StopAction,
    VehicleFloor,
    can_driver_drive_vehicle,
)
from app.spatial_validator import SpatialValidator
from app.packing_rules import resolve_can_rotate
from app.hybrid_alns.models import (
    CargoItem as HybridCargo,
    CostPolicy as HybridPolicy,
    DriverOption as HybridDriver,
    FleetVehicle as HybridVehicle,
    LocationPoint as HybridLocation,
    OptimizationSolution as HybridSolution,
    OptimizedRoute as HybridRoute,
    OrderPair as HybridOrder,
    ScheduledStop as HybridStop,
)
from app.hybrid_alns.route_evaluator import schedule_and_evaluate_route
from app.planning_objective import apply_planning_objective


@dataclass
class BenchmarkMetric:
    algorithm_name: str
    case_file: str
    status: str
    orders_served: int
    total_orders: int
    fulfillment_rate_pct: float
    vehicles_used: int
    total_cost_vnd: int
    selection_score_vnd: int
    total_distance_km: float
    runtime_sec: float
    spatial_audit_pass: bool
    diagnostic: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def convert_request_to_hybrid(
    request: FleetOptimizationRequest,
) -> Tuple[
    List[HybridVehicle],
    List[HybridDriver],
    List[HybridOrder],
    HybridPolicy,
    List[List[float]],
    List[List[float]],
    Dict[str, int],
]:
    """Convert production FleetOptimizationRequest into lightweight benchmark models."""
    node_id_to_index: Dict[str, int] = {}
    vehicles: List[HybridVehicle] = []
    drivers: List[HybridDriver] = []

    for v_idx, vehicle in enumerate(request.vehicles):
        depot_key = f"depot_{vehicle.id}"
        hybrid_end_depot = None
        if vehicle.end_depot is not None:
            end_key = f"end_depot_{vehicle.id}"
            from app.interprovincial import resolve_vehicle_end_node_index
            end_idx = resolve_vehicle_end_node_index(request.vehicles, request.orders, v_idx, vehicle)
            if end_idx is not None:
                node_id_to_index[end_key] = end_idx
            hybrid_end_depot = HybridLocation(
                id=end_key,
                source_location_id=vehicle.end_depot.source_location_id,
                name=vehicle.end_depot.name or "End Depot",
                latitude=float(vehicle.end_depot.latitude),
                longitude=float(vehicle.end_depot.longitude),
                province_code=vehicle.end_depot.province_code,
                province_name=vehicle.end_depot.province_name,
                warehouse_role=vehicle.end_depot.warehouse_role,
                docking_time_sec=int(vehicle.end_depot.docking_time_sec or 0),
                max_vehicle_payload_kg=vehicle.end_depot.max_vehicle_payload_kg,
                max_vehicle_length_cm=vehicle.end_depot.max_vehicle_length_cm,
                has_forklift=vehicle.end_depot.has_forklift,
                operating_windows=list(vehicle.end_depot.operating_windows or ()),
                handling_sec_per_ton=int(vehicle.end_depot.handling_sec_per_ton or 0),
                handling_sec_per_package=int(vehicle.end_depot.handling_sec_per_package or 0),
            )
        vehicles.append(
            HybridVehicle(
                id=vehicle.id,
                plate_number=vehicle.plate_number,
                length_cm=float(vehicle.length_cm),
                width_cm=float(vehicle.width_cm),
                height_cm=float(vehicle.height_cm),
                payload_limit_kg=float(vehicle.payload_limit_kg),
                depot=HybridLocation(
                    id=depot_key,
                    source_location_id=vehicle.depot.source_location_id,
                    name=vehicle.depot.name or "Depot",
                    latitude=float(vehicle.depot.latitude),
                    longitude=float(vehicle.depot.longitude),
                    province_code=vehicle.depot.province_code,
                    province_name=vehicle.depot.province_name,
                    warehouse_role=vehicle.depot.warehouse_role,
                    docking_time_sec=int(vehicle.depot.docking_time_sec or 0),
                    max_vehicle_payload_kg=vehicle.depot.max_vehicle_payload_kg,
                    max_vehicle_length_cm=vehicle.depot.max_vehicle_length_cm,
                    has_forklift=vehicle.depot.has_forklift,
                    operating_windows=list(vehicle.depot.operating_windows or ()),
                    handling_sec_per_ton=int(vehicle.depot.handling_sec_per_ton or 0),
                    handling_sec_per_package=int(vehicle.depot.handling_sec_per_package or 0),
                ),
                end_depot=hybrid_end_depot,
                return_to_depot=bool(vehicle.return_to_depot),
                door_position=vehicle.door_position,
                fuel_consumption_liters_per_100_km=float(
                    vehicle.fuel_consumption_liters_per_100_km
                ),
                load_fuel_surcharge_percent_at_full_payload=float(
                    vehicle.load_fuel_surcharge_percent_at_full_payload
                ),
                fixed_operating_cost_vnd=int(vehicle.fixed_operating_cost_vnd),
                source_vehicle_id=vehicle.source_vehicle_id,
                service_day_index=vehicle.service_day_index,
                available_start_sec=vehicle.available_start_sec,
                available_end_sec=vehicle.available_end_sec,
                vehicle_type=vehicle.vehicle_type,
                model=vehicle.model,
                temperature_mode=vehicle.temperature_mode,
                has_tail_lift=bool(vehicle.has_tail_lift),
                toll_factor=float(vehicle.toll_factor),
            )
        )
        # Pair with a distinct valid driver for vehicle service day and license (1-to-1 per day)
        from app.interprovincial import is_driver_compatible_with_vehicle
        used_driver_ids_on_day = {
            drv.id for drv in drivers if drv.service_day_index == vehicle.service_day_index
        }
        driver = next(
            (
                d for d in request.drivers
                if d.id not in used_driver_ids_on_day
                and is_driver_compatible_with_vehicle(d, vehicle)
            ),
            next(
                (
                    d for d in request.drivers
                    if is_driver_compatible_with_vehicle(d, vehicle)
                ),
                request.drivers[v_idx] if v_idx < len(request.drivers) else request.drivers[0],
            ),
        )
        drivers.append(
            HybridDriver(
                id=driver.id,
                full_name=driver.full_name,
                license_class=driver.license_class,
                fixed_salary_monthly_vnd=int(driver.fixed_salary_monthly_vnd),
                trip_base_pay_vnd=int(driver.trip_base_pay_vnd),
                per_km_pay_vnd=int(driver.per_km_pay_vnd),
                source_driver_id=driver.source_driver_id,
                service_day_index=driver.service_day_index,
                home_location_id=driver.home_location_id,
                home_province_code=driver.home_province_code,
                strict_home_location=bool(driver.strict_home_location),
            )
        )
        node_id_to_index[depot_key] = v_idx

    orders: List[HybridOrder] = []
    for order_idx, order in enumerate(request.orders):
        p_key = f"p_{order.id}"
        d_key = f"d_{order.id}"
        orders.append(
            HybridOrder(
                id=order.id,
                order_number=order.order_number,
                pickup_location=HybridLocation(
                    id=p_key,
                    source_location_id=order.pickup_location.source_location_id or order.pickup_location.id,
                    name=order.pickup_location.name or "Pickup",
                    latitude=float(order.pickup_location.latitude),
                    longitude=float(order.pickup_location.longitude),
                    province_code=order.pickup_location.province_code,
                    province_name=order.pickup_location.province_name,
                    warehouse_role=order.pickup_location.warehouse_role,
                    docking_time_sec=int(order.pickup_location.docking_time_sec or 0),
                    max_vehicle_payload_kg=order.pickup_location.max_vehicle_payload_kg,
                    max_vehicle_length_cm=order.pickup_location.max_vehicle_length_cm,
                    has_forklift=order.pickup_location.has_forklift,
                    operating_windows=list(order.pickup_location.operating_windows or ()),
                    handling_sec_per_ton=int(order.pickup_location.handling_sec_per_ton or 0),
                    handling_sec_per_package=int(order.pickup_location.handling_sec_per_package or 0),
                ),
                delivery_location=HybridLocation(
                    id=d_key,
                    source_location_id=order.delivery_location.source_location_id or order.delivery_location.id,
                    name=order.delivery_location.name or "Delivery",
                    latitude=float(order.delivery_location.latitude),
                    longitude=float(order.delivery_location.longitude),
                    province_code=order.delivery_location.province_code,
                    province_name=order.delivery_location.province_name,
                    warehouse_role=order.delivery_location.warehouse_role,
                    docking_time_sec=int(order.delivery_location.docking_time_sec or 0),
                    max_vehicle_payload_kg=order.delivery_location.max_vehicle_payload_kg,
                    max_vehicle_length_cm=order.delivery_location.max_vehicle_length_cm,
                    has_forklift=order.delivery_location.has_forklift,
                    operating_windows=list(order.delivery_location.operating_windows or ()),
                    handling_sec_per_ton=int(order.delivery_location.handling_sec_per_ton or 0),
                    handling_sec_per_package=int(order.delivery_location.handling_sec_per_package or 0),
                ),
                items=[
                    HybridCargo(
                        id=item.id,
                        order_id=order.id,
                        length_cm=float(item.length_cm),
                        width_cm=float(item.width_cm),
                        height_cm=float(item.height_cm),
                        weight_kg=float(item.weight_kg),
                        can_rotate=resolve_can_rotate(
                            item,
                            d11_default=True,
                        ),
                        allowed_orientations=getattr(item, "allowed_orientations", None),
                        description=item.description or "",
                        customer_id=getattr(item, "customer_id", None),
                        cargo_kind=getattr(item, "cargo_kind", "STANDARD"),
                        allow_upper_tier=bool(getattr(item, "allow_upper_tier", True)),
                        no_top_load_requested=bool(getattr(item, "no_top_load_requested", False)),
                        max_top_load_g=getattr(item, "max_top_load_g", None),
                        required_temperature=getattr(item, "required_temperature", None),
                        cargo_group=getattr(item, "cargo_group", None),
                        incompatible_cargo_groups=list(getattr(item, "incompatible_cargo_groups", ()) or ()),
                        requires_lift_equipment=bool(getattr(item, "requires_lift_equipment", False)),
                    )
                    for item in order.items
                ],
                service_time_sec=int(order.service_time_sec),
                pickup_window_start_sec=int(order.pickup_window_start_sec),
                pickup_window_end_sec=int(order.pickup_window_end_sec),
                delivery_window_start_sec=int(order.delivery_window_start_sec),
                delivery_window_end_sec=int(order.delivery_window_end_sec),
                ordered_at_sec=int(order.ordered_at_sec),
                order_value_vnd=int(order.order_value_vnd),
                allowed_source_vehicle_ids=list(order.allowed_source_vehicle_ids),
                source_order_id=order.source_order_id or order.id,
                split_group_id=order.split_group_id,
                pickup_service_time_sec=order.pickup_service_time_sec,
                delivery_service_time_sec=order.delivery_service_time_sec,
            )
        )
        node_id_to_index[p_key] = len(request.vehicles) + 2 * order_idx
        node_id_to_index[d_key] = len(request.vehicles) + 2 * order_idx + 1

    policy = HybridPolicy(
        delivery_grace_days=request.policy.delivery_grace_days,
        fuel_price_per_liter_vnd=int(request.policy.fuel_price_per_liter_vnd),
        monthly_working_minutes=int(request.policy.monthly_working_minutes),
        cargo_holding_cost_vnd_per_ton_hour=int(
            request.policy.cargo_holding_cost_vnd_per_ton_hour
        ),
        unassigned_order_penalty_vnd=int(request.policy.unassigned_order_penalty_vnd),
        late_delivery_penalty_mode=request.policy.late_delivery_penalty_mode,
        late_delivery_penalty_value=float(request.policy.late_delivery_penalty_value),
        demo_stacking=getattr(request, "demo_stacking", None),
        driving_rest_policy=getattr(request.policy, "driving_rest_policy", None),
        toll_matrix_vnd=getattr(request, "toll_matrix_vnd", None),
    )

    return (
        vehicles,
        drivers,
        orders,
        policy,
        request.distance_matrix_meters,
        request.duration_matrix_seconds,
        node_id_to_index,
    )


def audit_with_spatial_validator(
    vehicle: ProdVehicle,
    stops: List[HybridStop],
    order_by_id: Dict[str, ProdOrder],
    max_time_seconds: float = 3.0,
) -> Tuple[bool, str]:
    """Execute complete T21-T27 validation using production SpatialValidator."""
    if not stops:
        return True, "Tuyến trống (Hợp lệ)"

    vehicle_floor = VehicleFloor(
        id=vehicle.id,
        plate_number=vehicle.plate_number,
        length_cm=vehicle.length_cm,
        width_cm=vehicle.width_cm,
        height_cm=vehicle.height_cm,
        payload_limit_kg=vehicle.payload_limit_kg,
        door_position=vehicle.door_position,
    )
    validator = SpatialValidator(vehicle_floor, max_time_seconds=max_time_seconds)

    stop_actions: List[StopAction] = []
    for seq, stop in enumerate(stops, start=1):
        order = order_by_id.get(stop.order_id or "")
        items_to_load = []
        items_to_unload = []
        if stop.stop_type == "PICKUP" and order:
            items_to_load = [item.model_copy(update={"can_rotate": True}) for item in order.items]
        elif stop.stop_type == "DELIVERY" and order:
            items_to_unload = [item.id for item in order.items]

        stop_actions.append(
            StopAction(
                stop_id=f"stop_{seq}",
                sequence=seq,
                stop_type=stop.stop_type,
                items_to_load=items_to_load,
                items_to_unload=items_to_unload,
            )
        )

    result = validator.validate_plan(stop_actions)
    if result.is_valid:
        return True, "Hợp lệ (Pass SpatialValidator)"
    return False, f"Vi phạm hình học: {result.violation_scenario or result.violation_code} - {result.error_message}"
