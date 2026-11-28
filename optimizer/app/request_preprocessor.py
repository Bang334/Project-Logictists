"""Lossless reductions and geometric order splitting before routing search."""

import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from .interprovincial import (
    align_arrival_with_warehouse_hours,
    is_driver_compatible_with_vehicle,
    is_order_compatible_with_vehicle_and_warehouses,
    stop_effective_service_seconds,
)
from .models import (
    CargoItem,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    StopAction,
    VehicleFloor,
    advance_past_curfews,
)
from .spatial_validator import SpatialValidator
from .packing_rules import resolve_can_rotate
from .stacking import (
    effective_floor_capacity_cm2,
    enforce_spatial_weight_balance_if_needed,
    validate_stop_actions,
)


_GEOMETRY_TOLERANCE = 0.01
_MAX_LAYOUT_CHECK_SECONDS = 0.5
_MIN_LAYOUT_CHECK_SECONDS = 0.05


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
    if not is_order_compatible_with_vehicle_and_warehouses(order, vehicle):
        return False

    p_svc, p_key = stop_effective_service_seconds(order, "PICKUP", None)
    pickup_arrival = max(
        float(vehicle.available_start_sec),
        float(order.pickup_window_start_sec),
    )
    pickup_arrival = advance_past_curfews(
        pickup_arrival, p_svc, vehicle.payload_limit_kg, order.pickup_curfew_windows
    )
    pickup_arrival = align_arrival_with_warehouse_hours(
        pickup_arrival, p_svc, order.pickup_location.operating_windows
    )
    if pickup_arrival > order.pickup_window_end_sec:
        return False

    d_svc, _ = stop_effective_service_seconds(order, "DELIVERY", p_key)
    delivery_arrival = max(
        pickup_arrival + p_svc,
        float(order.delivery_window_start_sec),
    )
    delivery_arrival = advance_past_curfews(
        delivery_arrival, d_svc, vehicle.payload_limit_kg, order.delivery_curfew_windows
    )
    delivery_arrival = align_arrival_with_warehouse_hours(
        delivery_arrival, d_svc, order.delivery_location.operating_windows
    )
    if delivery_arrival > order.delivery_window_end_sec:
        return False

    route_end = delivery_arrival + d_svc
    return route_end <= vehicle.available_end_sec


def _drivers_can_cover_vehicles(
    vehicles: List[FleetVehicle], drivers: List
) -> bool:
    if len(drivers) < len(vehicles):
        return False
    adj: List[List[int]] = [
        [
            d_idx
            for d_idx, d in enumerate(drivers)
            if is_driver_compatible_with_vehicle(d, v)
        ]
        for v in vehicles
    ]
    if any(not choices for choices in adj):
        return False
    match_d: Dict[int, int] = {}

    def _dfs(v_idx: int, seen: Set[int]) -> bool:
        for d_idx in adj[v_idx]:
            if d_idx in seen:
                continue
            seen.add(d_idx)
            if d_idx not in match_d or _dfs(match_d[d_idx], seen):
                match_d[d_idx] = v_idx
                return True
        return False

    return all(_dfs(v_idx, set()) for v_idx in range(len(vehicles)))


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

    reduced = request_with_vehicle_slots(request, retained_vehicle_indices)
    return (reduced, removed_count) if reduced is not None else (request, 0)


def request_with_vehicle_slots(
    request: FleetOptimizationRequest, retained_vehicle_indices: List[int],
) -> Optional[FleetOptimizationRequest]:
    """Keep the matching shift days and the corresponding provider matrix nodes."""
    if not retained_vehicle_indices:
        return None
    retained_vehicles = [request.vehicles[index] for index in retained_vehicle_indices]
    retained_days = {vehicle.service_day_index for vehicle in retained_vehicles}
    retained_drivers = [
        driver
        for driver in request.drivers
        if driver.service_day_index in retained_days
    ]
    if not _drivers_can_cover_vehicles(retained_vehicles, retained_drivers):
        # Avoid creating a sliced snapshot where compatible drivers are missing.
        return None

    old_vehicle_count = len(request.vehicles)
    base_expected = old_vehicle_count + 2 * len(request.orders)
    extra_tail = list(range(base_expected, len(request.distance_matrix_meters)))
    retained_node_indices: List[int] = (
        retained_vehicle_indices
        + list(range(old_vehicle_count, base_expected))
        + extra_tail
    )

    def slice_matrix(matrix: List[List[float]]) -> List[List[float]]:
        return [
            [matrix[row_index][column_index] for column_index in retained_node_indices]
            for row_index in retained_node_indices
        ]

    payload = request.model_dump()
    payload.update(
        vehicles=[vehicle.model_dump() for vehicle in retained_vehicles],
        drivers=[driver.model_dump() for driver in retained_drivers],
        distance_matrix_meters=slice_matrix(request.distance_matrix_meters),
        duration_matrix_seconds=slice_matrix(request.duration_matrix_seconds),
        toll_matrix_vnd=(
            slice_matrix(request.toll_matrix_vnd)
            if request.toll_matrix_vnd is not None
            else None
        ),
    )
    return FleetOptimizationRequest(**payload)


def _cargo_fits_vehicle(
    cargo: CargoItem,
    vehicle: FleetVehicle,
    demo_stacking: Optional[object] = None,
) -> bool:
    if cargo.weight_kg > vehicle.payload_limit_kg + _GEOMETRY_TOLERANCE:
        return False
    if cargo.height_cm > vehicle.height_cm + _GEOMETRY_TOLERANCE:
        return False
    orientations = [(cargo.length_cm, cargo.width_cm)]
    if resolve_can_rotate(cargo, d11_default=True):
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
    demo_stacking: Optional[object] = None,
) -> Optional[List[Tuple[FleetVehicle, List[CargoItem]]]]:
    bins: List[Tuple[FleetVehicle, List[CargoItem]]] = sorted(
        [(v, []) for v in physical_vehicles],
        key=lambda pair: (
            -effective_floor_capacity_cm2(pair[0], demo_stacking),
            -pair[0].payload_limit_kg,
        ),
    )
    if not bins:
        return None

    sorted_cargo = sorted(
        items,
        key=lambda c: (
            sum(1 for v in physical_vehicles if _cargo_fits_vehicle(c, v, demo_stacking)),
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
        > sum(effective_floor_capacity_cm2(v, demo_stacking) for v, _ in bins) + _GEOMETRY_TOLERANCE
    ):
        return None

    min_vehicles = max(
        min_bins_override,
        _minimum_bin_count_for_total(
            total_weight, [v.payload_limit_kg for v, _ in bins]
        ),
        _minimum_bin_count_for_total(
            total_area, [effective_floor_capacity_cm2(v, demo_stacking) for v, _ in bins]
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


@dataclass(frozen=True)
class OrderSplitOutcome:
    request: FleetOptimizationRequest
    split_order_count: int
    unchecked_order_count: int


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
    outcome = split_orders_within_deadline(request, force_split_order_ids)
    return outcome.request, outcome.split_order_count


def split_orders_within_deadline(
    request: FleetOptimizationRequest,
    force_split_order_ids: Optional[Set[str]] = None,
    deadline: Optional[float] = None,
) -> OrderSplitOutcome:
    """Same reduction as ``split_infeasible_orders_across_fleet`` with a time cap.

    ``deadline`` is a ``time.perf_counter()`` instant. Once it passes, the
    remaining orders are kept unsplit (feasibility unknown) instead of being
    validated, because each layout check can cost hundreds of milliseconds and
    must not consume the whole optimization budget.
    """
    physical_by_source: Dict[str, FleetVehicle] = {}
    for vehicle in request.vehicles:
        key = vehicle.source_vehicle_id or vehicle.id
        if key not in physical_by_source:
            physical_by_source[key] = vehicle
    # Largest floors first: the first fitting vehicle ends the any() check, so
    # orders that fit somewhere need a single layout validation in most cases.
    all_physical_vehicles = sorted(
        physical_by_source.values(),
        key=lambda v: (
            -effective_floor_capacity_cm2(v, request.demo_stacking),
            -v.payload_limit_kg,
        ),
    )
    if len(all_physical_vehicles) <= 1:
        return OrderSplitOutcome(request, 0, 0)

    fit_cache: Dict[Tuple[object, ...], Optional[bool]] = {}
    is_deadline_hit_for_order = False

    def remaining_seconds() -> Optional[float]:
        return None if deadline is None else deadline - time.perf_counter()

    def cargo_set_fits_vehicle(items: List[CargoItem], vehicle: FleetVehicle) -> Optional[bool]:
        nonlocal is_deadline_hit_for_order
        if not items:
            return True
        if not all(_cargo_fits_vehicle(item, vehicle, request.demo_stacking) for item in items):
            return False
        total_weight = sum(item.weight_kg for item in items)
        if total_weight > vehicle.payload_limit_kg + _GEOMETRY_TOLERANCE:
            return False
        total_area = sum(item.length_cm * item.width_cm for item in items)
        if (
            total_area
            > effective_floor_capacity_cm2(vehicle, request.demo_stacking) + _GEOMETRY_TOLERANCE
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
                        tuple(it.allowed_orientations) if it.allowed_orientations is not None else None,
                        it.cargo_kind,
                        it.allow_upper_tier,
                        it.no_top_load_requested,
                        it.max_top_load_g,
                        it.customer_id or it.order_id,
                    )
                    for it in items
                )
            ),
            request.demo_stacking.model_dump_json() if request.demo_stacking else None,
        )
        if cache_key in fit_cache:
            return fit_cache[cache_key]
        remaining = remaining_seconds()
        if remaining is not None and remaining <= _MIN_LAYOUT_CHECK_SECONDS:
            # Unknown because of the time cap; never cached so it cannot be
            # mistaken for a geometric result.
            is_deadline_hit_for_order = True
            return None

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
        result = enforce_spatial_weight_balance_if_needed(
            request.demo_stacking,
            validate_stop_actions(
                request.demo_stacking,
                vehicle,
                stops,
                max_search_nodes=2_500,
                max_time_seconds=(
                    _MAX_LAYOUT_CHECK_SECONDS
                    if remaining is None
                    else min(_MAX_LAYOUT_CHECK_SECONDS, remaining)
                ),
            ),
            cost_policy=request.policy,
        )
        # A search limit leaves feasibility unknown. It must neither force an
        # extra order trip nor count as a verified packing for a split bin.
        fit = None if result.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED" else result.is_valid
        fit_cache[cache_key] = fit
        return fit

    new_orders: List[OrderPair] = []
    order_origin_indices: List[int] = []
    split_count = 0
    unchecked_order_count = 0

    for order_idx, order in enumerate(request.orders):
        if is_deadline_hit_for_order:
            unchecked_order_count += 1
            is_deadline_hit_for_order = False
        candidate_vehicles = [
            v
            for v in all_physical_vehicles
            if is_order_compatible_with_vehicle_and_warehouses(order, v)
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
            not any(_cargo_fits_vehicle(item, vehicle, request.demo_stacking) for vehicle in candidate_vehicles)
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
            demo_stacking=request.demo_stacking,
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
                pickup_location=order.pickup_location.model_copy(
                    update={
                        "id": f"{order.pickup_location.id}::split:{part_idx}",
                        "source_location_id": base_pickup_id,
                    }
                ).model_dump(),
                delivery_location=order.delivery_location.model_copy(
                    update={
                        "id": f"{order.delivery_location.id}::split:{part_idx}",
                        "source_location_id": base_delivery_id,
                    }
                ).model_dump(),
                items=[item.model_dump() for item in bin_items],
                order_value_vnd=round(order.order_value_vnd * share),
            )
            new_orders.append(OrderPair(**part_payload))
            order_origin_indices.append(order_idx)

    if is_deadline_hit_for_order:
        unchecked_order_count += 1

    if split_count == 0:
        return OrderSplitOutcome(request, 0, unchecked_order_count)

    vehicle_count = len(request.vehicles)
    base_expected = vehicle_count + 2 * len(request.orders)
    expanded_node_indices: List[int] = list(range(vehicle_count))
    for origin_idx in order_origin_indices:
        expanded_node_indices.append(vehicle_count + 2 * origin_idx)
        expanded_node_indices.append(vehicle_count + 2 * origin_idx + 1)
    expanded_node_indices.extend(range(base_expected, len(request.distance_matrix_meters)))

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
        toll_matrix_vnd=(
            expand_matrix(request.toll_matrix_vnd)
            if request.toll_matrix_vnd is not None
            else None
        ),
    )
    return OrderSplitOutcome(
        FleetOptimizationRequest(**payload), split_count, unchecked_order_count
    )
