"""Lossless reductions and geometric order splitting before routing search."""

from typing import Dict, List, Optional, Set, Tuple

from .models import (
    CargoItem,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    StopAction,
    VehicleFloor,
)
from .spatial_validator import SpatialValidator


_GEOMETRY_TOLERANCE = 0.01


def _can_serve_order_with_zero_travel_lower_bound(
    request: FleetOptimizationRequest,
    vehicle_index: int,
    order_index: int,
) -> bool:
    """Return whether the slot could serve the order even with zero travel.

    Using a zero-travel lower bound keeps the reduction safe even when a
    provider matrix is asymmetric or does not satisfy the triangle inequality.
    """
    vehicle: FleetVehicle = request.vehicles[vehicle_index]
    order: OrderPair = request.orders[order_index]
    pickup_arrival = max(
        float(vehicle.available_start_sec),
        float(order.pickup_window_start_sec),
    )
    if pickup_arrival > order.pickup_window_end_sec:
        return False

    delivery_arrival = max(
        pickup_arrival + order.service_seconds("PICKUP"),
        float(order.delivery_window_start_sec),
    )
    if delivery_arrival > order.delivery_window_end_sec:
        return False

    route_end = delivery_arrival + order.service_seconds("DELIVERY")
    return route_end <= vehicle.available_end_sec


def prune_unserviceable_virtual_resources(
    request: FleetOptimizationRequest,
) -> Tuple[FleetOptimizationRequest, int]:
    """Remove vehicle/day copies that cannot serve any order.

    Matrix rows and columns are sliced together so node indexes remain aligned.
    If every slot is rejected, the original request is retained; the solver can
    then return its existing evidence-based infeasibility/timeout diagnostics.
    """
    retained_vehicle_indices = [
        vehicle_index
        for vehicle_index in range(len(request.vehicles))
        if any(
            _can_serve_order_with_zero_travel_lower_bound(
                request, vehicle_index, order_index
            )
            for order_index in range(len(request.orders))
        )
    ]
    removed_count = len(request.vehicles) - len(retained_vehicle_indices)
    if removed_count == 0 or not retained_vehicle_indices:
        return request, 0

    retained_days = {
        request.vehicles[index].service_day_index
        for index in retained_vehicle_indices
    }
    retained_drivers = [
        driver
        for driver in request.drivers
        if driver.service_day_index in retained_days
    ]
    if len(retained_drivers) < len(retained_vehicle_indices):
        # Driver matching is checked precisely by FleetRoutingSolver. Avoid a
        # preprocessed request that would violate the public request contract.
        return request, 0

    old_vehicle_count = len(request.vehicles)
    retained_node_indices: List[int] = retained_vehicle_indices + list(
        range(old_vehicle_count, old_vehicle_count + 2 * len(request.orders))
    )

    def slice_matrix(matrix: List[List[float]]) -> List[List[float]]:
        return [
            [matrix[row_index][column_index] for column_index in retained_node_indices]
            for row_index in retained_node_indices
        ]

    payload = request.model_dump()
    payload.update(
        vehicles=[
            request.vehicles[index].model_dump()
            for index in retained_vehicle_indices
        ],
        drivers=[driver.model_dump() for driver in retained_drivers],
        distance_matrix_meters=slice_matrix(request.distance_matrix_meters),
        duration_matrix_seconds=slice_matrix(request.duration_matrix_seconds),
    )
    return FleetOptimizationRequest(**payload), removed_count


def _cargo_fits_vehicle(cargo: CargoItem, vehicle: FleetVehicle) -> bool:
    if cargo.weight_kg > vehicle.payload_limit_kg + _GEOMETRY_TOLERANCE:
        return False
    if cargo.height_cm > vehicle.height_cm + _GEOMETRY_TOLERANCE:
        return False
    orientations = [(cargo.length_cm, cargo.width_cm)]
    if cargo.can_rotate:
        orientations.append((cargo.width_cm, cargo.length_cm))
    return any(
        length <= vehicle.length_cm + _GEOMETRY_TOLERANCE
        and width <= vehicle.width_cm + _GEOMETRY_TOLERANCE
        for length, width in orientations
    )


def _minimum_bin_count_for_total(required: float, capacities: List[float]) -> int:
    accumulated = 0.0
    for idx, cap in enumerate(sorted(capacities, reverse=True)):
        accumulated += cap
        if accumulated + _GEOMETRY_TOLERANCE >= required:
            return idx + 1
    return len(capacities) + 1


def _allocate_cargo_to_vehicles(
    items: List[CargoItem],
    physical_vehicles: List[FleetVehicle],
    fits_set_fn,
    min_bins_override: int = 1,
) -> Optional[List[Tuple[FleetVehicle, List[CargoItem]]]]:
    bins: List[Tuple[FleetVehicle, List[CargoItem]]] = sorted(
        [(v, []) for v in physical_vehicles],
        key=lambda pair: (
            -(pair[0].length_cm * pair[0].width_cm),
            -pair[0].payload_limit_kg,
        ),
    )
    if not bins:
        return None

    sorted_cargo = sorted(
        items,
        key=lambda c: (
            sum(1 for v in physical_vehicles if _cargo_fits_vehicle(c, v)),
            -(c.length_cm * c.width_cm),
            -c.weight_kg,
            c.id,
        ),
    )
    total_weight = sum(c.weight_kg for c in sorted_cargo)
    total_area = sum(c.length_cm * c.width_cm for c in sorted_cargo)
    if (
        total_weight > sum(v.payload_limit_kg for v, _ in bins) + _GEOMETRY_TOLERANCE
        or total_area
        > sum(v.length_cm * v.width_cm for v, _ in bins) + _GEOMETRY_TOLERANCE
    ):
        return None

    min_vehicles = max(
        min_bins_override,
        _minimum_bin_count_for_total(
            total_weight, [v.payload_limit_kg for v, _ in bins]
        ),
        _minimum_bin_count_for_total(
            total_area, [v.length_cm * v.width_cm for v, _ in bins]
        ),
    )
    if min_vehicles > len(bins):
        return None

    visited = 0
    max_states = 50_000

    for vehicle_limit in range(min_vehicles, len(bins) + 1):
        for _, bin_items in bins:
            bin_items.clear()

        def search(cargo_idx: int) -> bool:
            nonlocal visited
            if cargo_idx >= len(sorted_cargo):
                used = sum(1 for _, b_items in bins if b_items)
                return used >= min_bins_override
            visited += 1
            if visited > max_states:
                return False

            cargo = sorted_cargo[cargo_idx]
            used_count = sum(1 for _, b_items in bins if b_items)
            remaining_items = len(sorted_cargo) - cargo_idx
            need_new_bins = max(0, min_bins_override - used_count)

            candidates: List[int] = []
            for idx, (veh, b_items) in enumerate(bins):
                is_open = len(b_items) > 0
                if not is_open and used_count >= vehicle_limit:
                    continue
                if is_open and remaining_items <= need_new_bins:
                    continue
                if fits_set_fn(b_items + [cargo], veh):
                    candidates.append(idx)

            def candidate_sort_key(idx: int) -> Tuple[int, float, float]:
                veh, b_items = bins[idx]
                is_open = len(b_items) > 0
                if not is_open:
                    return (
                        1,
                        -(veh.length_cm * veh.width_cm),
                        -veh.payload_limit_kg,
                    )
                rem_area = veh.length_cm * veh.width_cm - sum(
                    it.length_cm * it.width_cm for it in (b_items + [cargo])
                )
                rem_weight = veh.payload_limit_kg - sum(
                    it.weight_kg for it in (b_items + [cargo])
                )
                return (0, rem_area, rem_weight)

            candidates.sort(key=candidate_sort_key)
            tried_signatures: Set[Tuple[object, ...]] = set()
            for idx in candidates:
                veh, b_items = bins[idx]
                sig = (
                    round(veh.length_cm, 2),
                    round(veh.width_cm, 2),
                    round(veh.height_cm, 2),
                    round(veh.payload_limit_kg, 2),
                    tuple(
                        (round(it.length_cm, 2), round(it.width_cm, 2), round(it.weight_kg, 2))
                        for it in b_items
                    ),
                )
                if sig in tried_signatures:
                    continue
                tried_signatures.add(sig)

                b_items.append(cargo)
                if search(cargo_idx + 1):
                    return True
                b_items.pop()
                if visited > max_states:
                    return False
            return False

        if search(0):
            return [(v, list(b_items)) for v, b_items in bins if b_items]
        if visited > max_states:
            return None

    return None


def split_infeasible_orders_across_fleet(
    request: FleetOptimizationRequest,
    force_split_order_ids: Optional[Set[str]] = None,
) -> Tuple[FleetOptimizationRequest, int]:
    """Split multi-package orders that cannot fit onto any single vehicle.

    Uses weight/area bounds and bounded 2D floor validation. Search-limit
    results keep the original order for the solver to validate; they do not
    prove a split is required. Negative checks such as two 60x60 packages on
    a 100x100 floor (GK05) still permit geometrically checked split bins.
    """
    physical_by_source: Dict[str, FleetVehicle] = {}
    for vehicle in request.vehicles:
        key = vehicle.source_vehicle_id or vehicle.id
        if key not in physical_by_source:
            physical_by_source[key] = vehicle
    all_physical_vehicles = list(physical_by_source.values())
    if len(all_physical_vehicles) <= 1:
        return request, 0

    fit_cache: Dict[Tuple[object, ...], Optional[bool]] = {}

    def cargo_set_fits_vehicle(items: List[CargoItem], vehicle: FleetVehicle) -> Optional[bool]:
        if not items:
            return True
        if not all(_cargo_fits_vehicle(item, vehicle) for item in items):
            return False
        total_weight = sum(item.weight_kg for item in items)
        if total_weight > vehicle.payload_limit_kg + _GEOMETRY_TOLERANCE:
            return False
        total_area = sum(item.length_cm * item.width_cm for item in items)
        if (
            total_area
            > vehicle.length_cm * vehicle.width_cm + _GEOMETRY_TOLERANCE
        ):
            return False
        if len(items) == 1:
            return True

        cache_key = (
            round(vehicle.length_cm, 2),
            round(vehicle.width_cm, 2),
            round(vehicle.height_cm, 2),
            round(vehicle.payload_limit_kg, 2),
            vehicle.door_position,
            tuple(
                sorted(
                    (
                        round(it.length_cm, 2),
                        round(it.width_cm, 2),
                        round(it.height_cm, 2),
                        round(it.weight_kg, 2),
                        it.can_rotate,
                    )
                    for it in items
                )
            ),
        )
        if cache_key in fit_cache:
            return fit_cache[cache_key]

        validator = SpatialValidator(
            VehicleFloor(
                id=vehicle.id,
                plate_number=vehicle.plate_number,
                length_cm=vehicle.length_cm,
                width_cm=vehicle.width_cm,
                height_cm=vehicle.height_cm,
                payload_limit_kg=vehicle.payload_limit_kg,
                door_position=vehicle.door_position,
            ),
            max_search_nodes=2_500,
            max_time_seconds=0.5,
        )
        stops = [
            StopAction(
                stop_id="pickup",
                sequence=1,
                stop_type="PICKUP",
                address="Pickup",
                latitude=0.0,
                longitude=0.0,
                items_to_load=items,
                items_to_unload=[],
            ),
            StopAction(
                stop_id="delivery",
                sequence=2,
                stop_type="DELIVERY",
                address="Delivery",
                latitude=0.0,
                longitude=0.0,
                items_to_load=[],
                items_to_unload=[item.id for item in items],
            ),
        ]
        result = validator.validate_plan(stops)
        # A search limit leaves feasibility unknown. It must neither force an
        # extra order trip nor count as a verified packing for a split bin.
        fit = None if result.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED" else result.is_valid
        fit_cache[cache_key] = fit
        return fit

    new_orders: List[OrderPair] = []
    order_origin_indices: List[int] = []
    split_count = 0

    for order_idx, order in enumerate(request.orders):
        allowed_ids = set(order.allowed_source_vehicle_ids or [])
        candidate_vehicles = [
            v
            for v in all_physical_vehicles
            if not allowed_ids or (v.source_vehicle_id or v.id) in allowed_ids
        ]
        force_split = bool(
            force_split_order_ids
            and (
                order.id in force_split_order_ids
                or (order.source_order_id and order.source_order_id in force_split_order_ids)
            )
        )

        if (
            len(order.items) <= 1
            or "::split:" in order.id
            or (
                not force_split
                and any(
                    cargo_set_fits_vehicle(order.items, vehicle) is not False
                    for vehicle in candidate_vehicles
                )
            )
        ):
            new_orders.append(order)
            order_origin_indices.append(order_idx)
            continue

        if any(
            not any(_cargo_fits_vehicle(item, vehicle) for vehicle in candidate_vehicles)
            for item in order.items
        ):
            new_orders.append(order)
            order_origin_indices.append(order_idx)
            continue

        used_bins = _allocate_cargo_to_vehicles(
            order.items,
            candidate_vehicles,
            lambda items, vehicle: cargo_set_fits_vehicle(items, vehicle) is True,
            min_bins_override=2 if force_split else 1,
        )
        if not used_bins or len(used_bins) <= 1:
            new_orders.append(order)
            order_origin_indices.append(order_idx)
            continue

        split_count += 1
        source_order_id = order.source_order_id or order.id
        source_order_number = order.source_order_number or order.order_number
        split_group_id = order.split_group_id or source_order_id
        base_pickup_id = (
            order.pickup_location.source_location_id or order.pickup_location.id
        )
        base_delivery_id = (
            order.delivery_location.source_location_id or order.delivery_location.id
        )

        for part_idx, (bin_vehicle, bin_items) in enumerate(used_bins, start=1):
            primary_source_id = bin_vehicle.source_vehicle_id or bin_vehicle.id
            compatible_source_ids = [primary_source_id]
            for veh in candidate_vehicles:
                vid = veh.source_vehicle_id or veh.id
                if vid not in compatible_source_ids and cargo_set_fits_vehicle(
                    bin_items, veh
                ):
                    compatible_source_ids.append(vid)

            share = len(bin_items) / len(order.items)
            part_payload = order.model_dump()
            part_payload.update(
                id=f"{order.id}::split:{part_idx}",
                source_order_id=source_order_id,
                source_order_number=source_order_number,
                split_group_id=split_group_id,
                allowed_source_vehicle_ids=compatible_source_ids,
                order_number=f"{order.order_number} ({part_idx}/{len(used_bins)})",
                pickup_location=LocationPoint(
                    id=f"{order.pickup_location.id}::split:{part_idx}",
                    source_location_id=base_pickup_id,
                    name=order.pickup_location.name,
                    latitude=order.pickup_location.latitude,
                    longitude=order.pickup_location.longitude,
                ).model_dump(),
                delivery_location=LocationPoint(
                    id=f"{order.delivery_location.id}::split:{part_idx}",
                    source_location_id=base_delivery_id,
                    name=order.delivery_location.name,
                    latitude=order.delivery_location.latitude,
                    longitude=order.delivery_location.longitude,
                ).model_dump(),
                items=[item.model_dump() for item in bin_items],
                order_value_vnd=round(order.order_value_vnd * share),
            )
            new_orders.append(OrderPair(**part_payload))
            order_origin_indices.append(order_idx)

    if split_count == 0:
        return request, 0

    vehicle_count = len(request.vehicles)
    expanded_node_indices: List[int] = list(range(vehicle_count))
    for origin_idx in order_origin_indices:
        expanded_node_indices.append(vehicle_count + 2 * origin_idx)
        expanded_node_indices.append(vehicle_count + 2 * origin_idx + 1)

    def expand_matrix(matrix: List[List[float]]) -> List[List[float]]:
        return [
            [matrix[row_idx][col_idx] for col_idx in expanded_node_indices]
            for row_idx in expanded_node_indices
        ]

    payload = request.model_dump()
    payload.update(
        orders=[o.model_dump() for o in new_orders],
        distance_matrix_meters=expand_matrix(request.distance_matrix_meters),
        duration_matrix_seconds=expand_matrix(request.duration_matrix_seconds),
    )
    return FleetOptimizationRequest(**payload), split_count
