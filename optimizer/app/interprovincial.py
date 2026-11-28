"""Shared inter-provincial warehouse-to-warehouse scheduling, end-depot & driving-rest rules."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .models import (
    LocationPoint,
    RestBreakRecord,
    ScheduledStop,
    advance_past_curfews,
    can_driver_drive_vehicle,
)


def location_identity(location: Any) -> str:
    """Return canonical warehouse/location key across split orders and stops."""
    if location is None:
        return ""
    if isinstance(location, Mapping):
        return str(location.get("source_location_id") or location.get("id") or "")
    src = getattr(location, "source_location_id", None)
    return str(src or getattr(location, "id", "") or "")


def _coord_key(location: Any) -> Tuple[float, float]:
    return (
        round(float(getattr(location, "latitude", 0.0)), 6),
        round(float(getattr(location, "longitude", 0.0)), 6),
    )


def _locations_match(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return False
    a_id = getattr(a, "id", None)
    b_id = getattr(b, "id", None)
    if a_id and b_id and a_id == b_id:
        return True
    a_src = location_identity(a)
    b_src = location_identity(b)
    if a_src and b_src and a_src == b_src:
        return True
    return _coord_key(a) == _coord_key(b)


def is_driver_compatible_with_vehicle(
    driver: Any,
    vehicle: Any,
    *,
    license_checker: Any = None,
) -> bool:
    """Check shift day, license class, and warehouse/province home scope."""
    if getattr(driver, "service_day_index", 0) != getattr(vehicle, "service_day_index", 0):
        return False
    vehicle_type = getattr(vehicle, "vehicle_type", None) or getattr(vehicle, "model", None) or ""
    checker = can_driver_drive_vehicle if license_checker is None else license_checker
    if not checker(
        getattr(driver, "license_class", "C"),
        float(getattr(vehicle, "payload_limit_kg", 0.0)),
        vehicle_type,
    ):
        return False

    depot = getattr(vehicle, "depot", None)
    if depot is None:
        return True

    v_loc_id = location_identity(depot)
    v_prov = getattr(depot, "province_code", None)
    d_loc_id = getattr(driver, "home_location_id", None)
    d_prov = getattr(driver, "home_province_code", None)
    strict_home = bool(getattr(driver, "strict_home_location", False))

    if strict_home and d_loc_id:
        return d_loc_id == v_loc_id
    if d_prov and v_prov:
        return d_prov == v_prov
    if d_loc_id and not d_prov:
        return d_loc_id == v_loc_id
    return True


def _item_has_compat_rule(item: Any) -> bool:
    temp = getattr(item, "required_temperature", "ANY")
    return bool(
        getattr(item, "cargo_group", None)
        or getattr(item, "incompatible_cargo_groups", None)
        or (temp and str(temp).strip().upper() != "ANY")
    )


def _normalize_cargo_group(group: Optional[str]) -> Optional[str]:
    if group is None:
        return None
    cleaned = group.strip().upper()
    return cleaned or None


def is_temperature_compatible(
    required_temperature: Optional[str], vehicle_temperature_mode: Optional[str]
) -> bool:
    """Validate cold-chain/dry thermal compatibility between cargo and truck."""
    if not required_temperature:
        return True
    req = required_temperature.strip().upper()
    v_mode = (vehicle_temperature_mode or "DRY").strip().upper()
    if req == "FROZEN":
        return v_mode == "FROZEN"
    if req == "CHILLED":
        return v_mode == "CHILLED"
    if req == "DRY":
        return v_mode in ("DRY", "ISOTHERMAL")
    return True


def is_location_accessible_for_vehicle(
    location: Any, vehicle: Any, *, requires_lift: bool = False
) -> bool:
    """Check warehouse physical access restrictions and handling equipment."""
    if location is None:
        return True
    max_payload = getattr(location, "max_vehicle_payload_kg", None)
    if (
        max_payload is not None
        and float(getattr(vehicle, "payload_limit_kg", 0.0)) > float(max_payload) + 1e-6
    ):
        return False
    max_length = getattr(location, "max_vehicle_length_cm", None)
    if (
        max_length is not None
        and float(getattr(vehicle, "length_cm", 0.0)) > float(max_length) + 1e-6
    ):
        return False
    if requires_lift:
        has_tail_lift = bool(getattr(vehicle, "has_tail_lift", False))
        has_forklift = getattr(location, "has_forklift", None) is True
        if not (has_tail_lift or has_forklift):
            return False
    return True


def items_have_compatibility_conflict(
    items_a: Sequence[Any], items_b: Sequence[Any]
) -> bool:
    """Return True if two item sets cannot share a vehicle compartment simultaneously."""
    if not items_a or not items_b:
        return False
    if not any(_item_has_compat_rule(it) for it in items_a) and not any(
        _item_has_compat_rule(it) for it in items_b
    ):
        return False
    for a in items_a:
        grp_a = _normalize_cargo_group(getattr(a, "cargo_group", None))
        raw_incompat_a = getattr(a, "incompatible_cargo_groups", None)
        incompat_a = (
            {g for raw in raw_incompat_a if (g := _normalize_cargo_group(raw)) is not None}
            if raw_incompat_a
            else ()
        )
        temp_a = (getattr(a, "required_temperature", None) or "").strip().upper()
        temp_a_spec = temp_a not in ("", "ANY")
        for b in items_b:
            grp_b = _normalize_cargo_group(getattr(b, "cargo_group", None))
            raw_incompat_b = getattr(b, "incompatible_cargo_groups", None)
            incompat_b = (
                {g for raw in raw_incompat_b if (g := _normalize_cargo_group(raw)) is not None}
                if raw_incompat_b
                else ()
            )
            if (grp_a and grp_a in incompat_b) or (grp_b and grp_b in incompat_a):
                return True
            if temp_a_spec:
                temp_b = (getattr(b, "required_temperature", None) or "").strip().upper()
                if temp_b not in ("", "ANY") and temp_a != temp_b:
                    return True
    return False


def is_order_compatible_with_vehicle_and_warehouses(
    order: Any, vehicle: Any
) -> bool:
    """Enforce order-vehicle allowlist, thermal mode, warehouse truck limits & lift gear."""
    allowed = getattr(order, "allowed_source_vehicle_ids", None) or ()
    if allowed:
        v_phys = getattr(vehicle, "source_vehicle_id", None) or vehicle.id
        if v_phys not in allowed and vehicle.id not in allowed:
            return False

    items = getattr(order, "items", None) or ()
    v_temp = getattr(vehicle, "temperature_mode", "DRY")
    requires_lift = False
    for item in items:
        if not is_temperature_compatible(
            getattr(item, "required_temperature", None), v_temp
        ):
            return False
        if bool(getattr(item, "requires_lift_equipment", False)):
            requires_lift = True

    if items_have_compatibility_conflict(items, items):
        return False

    for loc in (
        getattr(order, "pickup_location", None),
        getattr(order, "delivery_location", None),
    ):
        if not is_location_accessible_for_vehicle(
            loc, vehicle, requires_lift=requires_lift
        ):
            return False
    return True


def route_stops_have_cargo_conflict(
    stops: Sequence[Any], order_by_id: Mapping[str, Any]
) -> bool:
    """Simulate onboard cargo across a stop sequence to detect co-loading conflicts."""
    if len(stops) <= 2:
        return False
    has_any_rule = False
    for stop in stops:
        oid = getattr(stop, "allocation_id", None) or getattr(stop, "order_id", "") or ""
        order = order_by_id.get(oid)
        if order is not None and any(_item_has_compat_rule(it) for it in (getattr(order, "items", None) or ())):
            has_any_rule = True
            break
    if not has_any_rule:
        return False
    onboard_items: Dict[str, Any] = {}
    for stop in stops:
        oid = getattr(stop, "allocation_id", None) or getattr(stop, "order_id", "") or ""
        order = order_by_id.get(oid)
        if order is None:
            continue
        order_items = list(getattr(order, "items", None) or ())
        if getattr(stop, "stop_type", "") == "PICKUP":
            if onboard_items and items_have_compatibility_conflict(
                list(onboard_items.values()), order_items
            ):
                return True
            for it in order_items:
                if _item_has_compat_rule(it):
                    onboard_items[it.id] = it
        else:
            for it in order_items:
                onboard_items.pop(it.id, None)
    return False


def align_arrival_with_warehouse_hours(
    arrival_sec: float,
    service_sec: int,
    operating_windows: Sequence[Any],
) -> float:
    """Shift arrival forward to the next warehouse shift that fits service_sec."""
    if not operating_windows:
        return arrival_sec
    windows = sorted(
        (int(getattr(w, "start_sec", 0)), int(getattr(w, "end_sec", 86400)))
        for w in operating_windows
    )
    if not windows:
        return arrival_sec
    t = max(0.0, float(arrival_sec))
    svc = max(0, int(service_sec))
    start_day = int(t // 86400)
    for day_offset in range(31):
        day_base = (start_day + day_offset) * 86400
        for w_start, w_end in windows:
            cand = max(t, float(day_base + w_start))
            if svc > 0 and (w_end - w_start) >= svc:
                if cand + svc <= day_base + w_end + 1e-6:
                    return cand
            elif cand < day_base + w_end - 1e-6:
                return cand
    return t


def resolve_vehicle_end_location(
    vehicle: Any,
    stops: Optional[Sequence[ScheduledStop]] = None,
    order_by_id: Optional[Mapping[str, Any]] = None,
) -> Optional[LocationPoint]:
    """Resolve the physical end location of a route (home depot, custom end_depot, or open-route)."""
    end_depot = getattr(vehicle, "end_depot", None)
    if end_depot is not None:
        if isinstance(end_depot, LocationPoint):
            return end_depot
        return LocationPoint(
            id=str(getattr(end_depot, "id", "")),
            source_location_id=getattr(end_depot, "source_location_id", None),
            name=str(getattr(end_depot, "name", "") or "End Depot"),
            latitude=float(getattr(end_depot, "latitude", 0.0)),
            longitude=float(getattr(end_depot, "longitude", 0.0)),
            province_code=getattr(end_depot, "province_code", None),
            province_name=getattr(end_depot, "province_name", None),
            warehouse_role=getattr(end_depot, "warehouse_role", None),
            docking_time_sec=int(getattr(end_depot, "docking_time_sec", 0) or 0),
        )

    if not getattr(vehicle, "return_to_depot", True):
        if stops:
            last_stop = stops[-1]
            fallback_lat = float(getattr(last_stop, "latitude", 0.0) or 0.0)
            fallback_lon = float(getattr(last_stop, "longitude", 0.0) or 0.0)
            if order_by_id:
                order = order_by_id.get(
                    getattr(last_stop, "allocation_id", None)
                    or getattr(last_stop, "order_id", "")
                    or ""
                )
                if order is not None:
                    loc = (
                        order.pickup_location
                        if last_stop.stop_type == "PICKUP"
                        else order.delivery_location
                    )
                    if isinstance(loc, LocationPoint):
                        return loc
                    return LocationPoint(
                        id=str(getattr(loc, "id", last_stop.location_id)),
                        source_location_id=getattr(loc, "source_location_id", None),
                        name=str(getattr(loc, "name", last_stop.location_name)),
                        latitude=float(getattr(loc, "latitude", fallback_lat)),
                        longitude=float(getattr(loc, "longitude", fallback_lon)),
                        province_code=getattr(loc, "province_code", None),
                        province_name=getattr(loc, "province_name", None),
                        warehouse_role=getattr(loc, "warehouse_role", None),
                        docking_time_sec=int(getattr(loc, "docking_time_sec", 0) or 0),
                    )
            return LocationPoint(
                id=str(last_stop.location_id),
                name=str(last_stop.location_name),
                latitude=fallback_lat,
                longitude=fallback_lon,
            )
        return None

    depot = getattr(vehicle, "depot", None)
    if depot is None or isinstance(depot, LocationPoint):
        return depot
    return LocationPoint(
        id=str(getattr(depot, "id", "")),
        source_location_id=getattr(depot, "source_location_id", None),
        name=str(getattr(depot, "name", "") or "Depot"),
        latitude=float(getattr(depot, "latitude", 0.0)),
        longitude=float(getattr(depot, "longitude", 0.0)),
        province_code=getattr(depot, "province_code", None),
        province_name=getattr(depot, "province_name", None),
        warehouse_role=getattr(depot, "warehouse_role", None),
        docking_time_sec=int(getattr(depot, "docking_time_sec", 0) or 0),
    )


def resolve_vehicle_end_node_index(
    vehicles: Sequence[Any],
    orders: Sequence[Any],
    vehicle_idx: int,
    vehicle: Any,
    node_id_to_index: Optional[Mapping[str, int]] = None,
) -> Optional[int]:
    """Return matrix index of the vehicle's end location, or None for open routes."""
    end_depot = getattr(vehicle, "end_depot", None)
    if end_depot is None:
        if not getattr(vehicle, "return_to_depot", True):
            return None
        if node_id_to_index is not None:
            return node_id_to_index.get(vehicle.depot.id, vehicle_idx)
        return vehicle_idx

    if node_id_to_index is not None and end_depot.id in node_id_to_index:
        return node_id_to_index[end_depot.id]

    if _locations_match(end_depot, vehicle.depot):
        if node_id_to_index is not None:
            return node_id_to_index.get(vehicle.depot.id, vehicle_idx)
        return vehicle_idx

    # Match against existing vehicle depots
    for v_i, cand_v in enumerate(vehicles):
        if _locations_match(end_depot, cand_v.depot):
            if node_id_to_index is not None:
                return node_id_to_index.get(cand_v.depot.id, v_i)
            return v_i

    # Match against order pickup/delivery locations
    base_offset = len(vehicles)
    for o_i, order in enumerate(orders):
        for offset, loc in enumerate((order.pickup_location, order.delivery_location)):
            if _locations_match(end_depot, loc):
                if node_id_to_index is not None:
                    return node_id_to_index.get(loc.id, base_offset + 2 * o_i + offset)
                return base_offset + 2 * o_i + offset

    # Unmapped extra end depot appended after vehicles + 2 * orders
    extra_start = len(vehicles) + 2 * len(orders)
    extra_keys: List[str] = []
    for cand_v in vehicles:
        cand_end = getattr(cand_v, "end_depot", None)
        if cand_end is None:
            continue
        key = location_identity(cand_end)
        if key not in extra_keys:
            extra_keys.append(key)
    target_key = location_identity(end_depot)
    if target_key in extra_keys:
        return extra_start + extra_keys.index(target_key)
    return vehicle_idx


@dataclass
class DriverRestState:
    continuous_driving_sec: int = 0
    daily_driving_sec: int = 0
    total_driving_sec: int = 0


def is_rest_policy_enabled(rest_policy: Any) -> bool:
    return rest_policy is not None and bool(getattr(rest_policy, "enabled", True))


def estimate_driving_rest_lower_bound_sec(transit_sec: float, rest_policy: Any) -> int:
    """Conservative lower bound on mandatory rest breaks needed for a single leg."""
    if not is_rest_policy_enabled(rest_policy):
        return 0
    drive = max(0, round(transit_sec))
    if drive <= 0:
        return 0
    max_cont = int(rest_policy.max_continuous_driving_sec)
    short_rest = int(rest_policy.short_rest_duration_sec)
    max_daily = int(rest_policy.max_daily_driving_sec)
    daily_rest = int(rest_policy.daily_rest_duration_sec)

    daily_breaks = max(0, (drive - 1) // max_daily) if max_daily > 0 else 0
    if max_cont <= 0:
        short_breaks = 0
    else:
        total_breaks = max(0, (drive - 1) // max_cont)
        short_breaks = max(0, total_breaks - daily_breaks)
    return daily_breaks * daily_rest + short_breaks * short_rest


def simulate_driving_leg(
    depart_sec: float,
    transit_sec: float,
    state: DriverRestState,
    rest_policy: Any,
    leg_after_sequence: int,
) -> Tuple[float, int, List[RestBreakRecord], DriverRestState, Optional[str]]:
    """Simulate driving a single leg with mandatory continuous and daily rest breaks."""
    if not is_rest_policy_enabled(rest_policy):
        return (
            depart_sec + transit_sec,
            0,
            [],
            DriverRestState(
                continuous_driving_sec=state.continuous_driving_sec,
                daily_driving_sec=state.daily_driving_sec,
                total_driving_sec=state.total_driving_sec,
            ),
            None,
        )

    drive_sec = max(0, round(transit_sec))
    new_state = DriverRestState(
        continuous_driving_sec=state.continuous_driving_sec,
        daily_driving_sec=state.daily_driving_sec,
        total_driving_sec=state.total_driving_sec,
    )
    max_weekly = getattr(rest_policy, "max_weekly_driving_sec", None)
    if max_weekly is not None and new_state.total_driving_sec + drive_sec > int(max_weekly):
        return (
            depart_sec,
            0,
            [],
            new_state,
            "Vượt giới hạn tổng thời gian lái trong kỳ theo chính sách nghỉ lái.",
        )

    max_cont = int(rest_policy.max_continuous_driving_sec)
    short_rest = int(rest_policy.short_rest_duration_sec)
    max_daily = int(rest_policy.max_daily_driving_sec)
    daily_rest = int(rest_policy.daily_rest_duration_sec)

    current_t = int(round(depart_sec))
    remaining = drive_sec
    total_rest_sec = 0
    breaks: List[RestBreakRecord] = []

    while remaining > 0:
        if new_state.daily_driving_sec >= max_daily:
            if daily_rest > 0:
                breaks.append(
                    RestBreakRecord(
                        leg_after_sequence=leg_after_sequence,
                        reason="DAILY_LIMIT",
                        start_time_sec=current_t,
                        end_time_sec=current_t + daily_rest,
                        duration_sec=daily_rest,
                    )
                )
                current_t += daily_rest
                total_rest_sec += daily_rest
            new_state.daily_driving_sec = 0
            new_state.continuous_driving_sec = 0

        if new_state.continuous_driving_sec >= max_cont:
            if short_rest > 0:
                breaks.append(
                    RestBreakRecord(
                        leg_after_sequence=leg_after_sequence,
                        reason="CONTINUOUS_DRIVING",
                        start_time_sec=current_t,
                        end_time_sec=current_t + short_rest,
                        duration_sec=short_rest,
                    )
                )
                current_t += short_rest
                total_rest_sec += short_rest
            new_state.continuous_driving_sec = 0

        avail_cont = max_cont - new_state.continuous_driving_sec
        avail_daily = max_daily - new_state.daily_driving_sec
        step = min(remaining, avail_cont, avail_daily)
        if step <= 0:
            break
        current_t += step
        remaining -= step
        new_state.continuous_driving_sec += step
        new_state.daily_driving_sec += step
        new_state.total_driving_sec += step

        if remaining > 0:
            if new_state.daily_driving_sec >= max_daily:
                if daily_rest > 0:
                    breaks.append(
                        RestBreakRecord(
                            leg_after_sequence=leg_after_sequence,
                            reason="DAILY_LIMIT",
                            start_time_sec=current_t,
                            end_time_sec=current_t + daily_rest,
                            duration_sec=daily_rest,
                        )
                    )
                    current_t += daily_rest
                    total_rest_sec += daily_rest
                new_state.daily_driving_sec = 0
                new_state.continuous_driving_sec = 0
            elif new_state.continuous_driving_sec >= max_cont:
                if short_rest > 0:
                    breaks.append(
                        RestBreakRecord(
                            leg_after_sequence=leg_after_sequence,
                            reason="CONTINUOUS_DRIVING",
                            start_time_sec=current_t,
                            end_time_sec=current_t + short_rest,
                            duration_sec=short_rest,
                        )
                    )
                    current_t += short_rest
                    total_rest_sec += short_rest
                new_state.continuous_driving_sec = 0

    return float(current_t), total_rest_sec, breaks, new_state, None


def _apply_stop_rest_credit(
    state: DriverRestState,
    stop_wait_sec: int,
    service_sec: int,
    rest_policy: Any,
) -> None:
    if not is_rest_policy_enabled(rest_policy):
        return
    allowance = service_sec if getattr(rest_policy, "rest_allowance_during_service", True) else 0
    rest_credit = max(0, stop_wait_sec) + max(0, allowance)
    daily_rest = int(rest_policy.daily_rest_duration_sec)
    short_rest = int(rest_policy.short_rest_duration_sec)
    if daily_rest > 0 and rest_credit >= daily_rest:
        state.daily_driving_sec = 0
        state.continuous_driving_sec = 0
    elif short_rest > 0 and rest_credit >= short_rest:
        state.continuous_driving_sec = 0


def extract_province_hops(
    vehicle: Any,
    stops: Sequence[ScheduledStop],
    order_by_id: Mapping[str, Any],
    end_location: Optional[Any] = None,
) -> List[str]:
    """Extract ordered province codes traversed by the route without adjacent duplicates."""
    hops: List[str] = []

    def _append_province(loc: Any) -> None:
        if loc is None:
            return
        prov = getattr(loc, "province_code", None) or getattr(loc, "province_name", None)
        if prov and (not hops or hops[-1] != prov):
            hops.append(str(prov))

    _append_province(getattr(vehicle, "depot", None))
    for stop in stops:
        oid = getattr(stop, "allocation_id", None) or getattr(stop, "order_id", "") or ""
        order = order_by_id.get(oid)
        if order is not None:
            loc = order.pickup_location if stop.stop_type == "PICKUP" else order.delivery_location
            _append_province(loc)
    _append_province(end_location)
    return hops


@dataclass
class ScheduledTimelineResult:
    feasible: bool
    reason: str = ""
    scheduled_stops: List[ScheduledStop] = field(default_factory=list)
    route_start_sec: int = 0
    route_end_sec: int = 0
    return_travel_time_sec: int = 0
    return_waiting_time_sec: int = 0
    mandatory_rest_sec: int = 0
    rest_breaks: List[RestBreakRecord] = field(default_factory=list)
    total_distance_meters: float = 0.0
    province_hops: List[str] = field(default_factory=list)


def _stop_location_object(order: Any, stop_type: str) -> Any:
    return order.pickup_location if stop_type == "PICKUP" else order.delivery_location


def stop_effective_service_seconds(
    order: Any,
    stop_type: str,
    previous_location_key: Optional[str],
) -> Tuple[int, str]:
    """Compute base + weight/package dynamic handling + coalesced warehouse docking."""
    loc = _stop_location_object(order, stop_type)
    per_ton = getattr(loc, "handling_sec_per_ton", 0) or 0
    per_pkg = getattr(loc, "handling_sec_per_package", 0) or 0
    if per_ton > 0 or per_pkg > 0:
        items = order.items
        total_tons = sum(it.weight_kg for it in items) / 1000.0
        dynamic_handling = max(0, round(per_ton * total_tons) + int(per_pkg) * len(items))
    else:
        dynamic_handling = 0
    base_service = int(order.service_seconds(stop_type)) + dynamic_handling

    loc_key = str(getattr(loc, "source_location_id", None) or getattr(loc, "id", "") or "")
    docking = int(getattr(loc, "docking_time_sec", 0) or 0)
    if docking > 0 and loc_key and loc_key != previous_location_key:
        return base_service + docking, loc_key
    return base_service, loc_key


def needs_interprovincial_timeline(request: Any, vehicle: Any) -> bool:
    """Return True when exact inter-provincial scheduling rules apply to this route."""
    policy = getattr(request, "policy", None)
    if is_rest_policy_enabled(getattr(policy, "driving_rest_policy", None)):
        return True
    if not getattr(vehicle, "return_to_depot", True) or getattr(vehicle, "end_depot", None) is not None:
        return True
    for order in (getattr(request, "orders", None) or ()):
        for loc in (
            getattr(order, "pickup_location", None),
            getattr(order, "delivery_location", None),
        ):
            if loc is None:
                continue
            if (
                int(getattr(loc, "docking_time_sec", 0) or 0) > 0
                or int(getattr(loc, "handling_sec_per_ton", 0) or 0) > 0
                or int(getattr(loc, "handling_sec_per_package", 0) or 0) > 0
                or bool(getattr(loc, "operating_windows", None))
            ):
                return True
    return False


def check_cross_day_resource_conflicts(
    routes: Sequence[Any],
    vehicle_by_id: Mapping[str, Any],
    *,
    min_inter_trip_rest_sec: int = 0,
) -> bool:
    """Return True if any physical vehicle or driver has overlapping or under-rested trips."""
    day_drivers: set[Tuple[int, str]] = set()
    vehicle_intervals: Dict[str, List[Tuple[int, int, int]]] = {}
    driver_intervals: Dict[str, List[Tuple[int, int, int]]] = {}

    for route in routes:
        day_idx = int(getattr(route, "service_day_index", 0) or 0)
        start_s = int(getattr(route, "start_time_sec", 0) or 0)
        end_s = int(getattr(route, "end_time_sec", 0) or 0)
        plate = getattr(route, "plate_number", None)

        rid = getattr(route, "route_id", None) or getattr(route, "vehicle_id", "")
        veh = vehicle_by_id.get(rid) or vehicle_by_id.get(getattr(route, "vehicle_id", ""))
        phys_veh = (
            getattr(veh, "source_vehicle_id", None) or getattr(veh, "id", None)
            if veh is not None
            else (getattr(route, "vehicle_id", None) or plate)
        )
        if phys_veh:
            existing_v = vehicle_intervals.setdefault(str(phys_veh), [])
            for p_day, p_start, p_end in existing_v:
                if p_day == day_idx or (start_s < p_end and p_start < end_s):
                    return True
            existing_v.append((day_idx, start_s, end_s))

        driver_id = getattr(route, "driver_id", None)
        if driver_id:
            if (day_idx, driver_id) in day_drivers:
                return True
            day_drivers.add((day_idx, driver_id))
            driver_intervals.setdefault(str(driver_id), []).append(
                (day_idx, start_s, end_s)
            )

    rest_gap = max(0, int(min_inter_trip_rest_sec or 0))
    for intervals in driver_intervals.values():
        if len(intervals) <= 1:
            continue
        sorted_ivs = sorted(intervals, key=lambda item: (item[1], item[2], item[0]))
        for (d1, _s1, e1), (d2, s2, _e2) in zip(sorted_ivs, sorted_ivs[1:]):
            if d1 == d2 or s2 < e1 + rest_gap:
                return True

    return False


def calculate_route_toll_vnd(
    toll_matrix_vnd: Optional[Sequence[Sequence[float]]],
    vehicle_index: int,
    vehicle: Any,
    stops: Sequence[Any],
    stop_node_resolver: Any,
    *,
    start_node_index: Optional[int] = None,
    end_node_index: Optional[int] = None,
) -> int:
    """Compute exact leg-by-leg road/BOT toll fee scaled by vehicle toll_factor."""
    if toll_matrix_vnd is None or not stops:
        return 0
    toll_factor = float(getattr(vehicle, "toll_factor", 1.0) or 1.0)
    prev_idx = vehicle_index if start_node_index is None else start_node_index
    total_toll = 0.0
    n_rows = len(toll_matrix_vnd)
    for stop in stops:
        node_idx = stop_node_resolver(stop)
        if (
            node_idx is not None
            and 0 <= prev_idx < n_rows
            and 0 <= node_idx < len(toll_matrix_vnd[prev_idx])
        ):
            total_toll += float(toll_matrix_vnd[prev_idx][node_idx])
            prev_idx = node_idx
    if (
        end_node_index is not None
        and 0 <= prev_idx < n_rows
        and 0 <= end_node_index < len(toll_matrix_vnd[prev_idx])
    ):
        total_toll += float(toll_matrix_vnd[prev_idx][end_node_index])
    return max(0, round(total_toll * toll_factor))


def calculate_route_overnight_allowance_vnd(
    rest_breaks: Sequence[Any],
    rest_policy: Any,
) -> int:
    """Compute driver overnight stay allowance for daily rest stops along the route."""
    if not is_rest_policy_enabled(rest_policy) or not rest_breaks:
        return 0
    per_night = int(getattr(rest_policy, "overnight_allowance_vnd", 0) or 0)
    if per_night <= 0:
        return 0
    daily_breaks = sum(
        1 for br in rest_breaks if getattr(br, "reason", None) == "DAILY_LIMIT"
    )
    return daily_breaks * per_night


def schedule_route_timeline(
    *,
    vehicle: Any,
    vehicle_index: int,
    stops: Sequence[ScheduledStop],
    order_by_id: Mapping[str, Any],
    distance_matrix: Sequence[Sequence[float]],
    duration_matrix: Sequence[Sequence[float]],
    stop_node_resolver: Any,
    end_node_index: Optional[int],
    rest_policy: Any = None,
    apply_jit_start: bool = True,
    initial_start_sec: Optional[int] = None,
) -> ScheduledTimelineResult:
    """Schedule a stop sequence enforcing time windows, curfews, warehouse hours,
    dynamic handling + docking coalescing, open/custom end-depots, and driving rest breaks.
    """
    if not stops:
        return ScheduledTimelineResult(feasible=True)

    rest_enabled = is_rest_policy_enabled(rest_policy)

    def _run_pass(start_sec: float) -> ScheduledTimelineResult:
        current_time = float(start_sec)
        previous_index = vehicle_index
        previous_loc_key: Optional[str] = None
        delivered_split_groups = set()
        state = DriverRestState()
        scheduled: List[ScheduledStop] = []
        all_breaks: List[RestBreakRecord] = []
        total_mandatory_rest = 0
        total_distance = 0.0

        for sequence, stop in enumerate(stops, start=1):
            allocation_id = getattr(stop, "allocation_id", None) or getattr(stop, "order_id", "") or ""
            order = order_by_id.get(allocation_id)
            if order is None:
                return ScheduledTimelineResult(False, f"Đơn {allocation_id} không tồn tại")
            node_index = stop_node_resolver(stop)
            if node_index is None:
                return ScheduledTimelineResult(False, f"Không tìm thấy node cho điểm dừng {stop.location_id}")

            if stop.stop_type == "PICKUP" and order.split_group_id and order.split_group_id in delivered_split_groups:
                return ScheduledTimelineResult(False, "Không lấy thêm phần của cùng yêu cầu sau khi đã bắt đầu giao")
            if stop.stop_type == "DELIVERY" and order.split_group_id:
                delivered_split_groups.add(order.split_group_id)

            leg_dist = float(distance_matrix[previous_index][node_index])
            travel_time = float(duration_matrix[previous_index][node_index])
            if travel_time < 0 or leg_dist < 0:
                return ScheduledTimelineResult(False, "Ma trận đường đi chứa giá trị âm")
            total_distance += leg_dist

            leg_start = current_time
            arr_after_drive, enroute_rest_sec, leg_breaks, state, fail_msg = simulate_driving_leg(
                leg_start, travel_time, state, rest_policy, sequence - 1
            )
            if fail_msg is not None:
                return ScheduledTimelineResult(False, fail_msg)

            total_mandatory_rest += enroute_rest_sec
            all_breaks.extend(leg_breaks)

            window_start = (
                order.pickup_window_start_sec
                if stop.stop_type == "PICKUP"
                else order.delivery_window_start_sec
            )
            window_end = (
                order.pickup_window_end_sec
                if stop.stop_type == "PICKUP"
                else order.delivery_window_end_sec
            )
            service_duration, previous_loc_key = stop_effective_service_seconds(
                order, stop.stop_type, previous_loc_key
            )
            loc = _stop_location_object(order, stop.stop_type)
            op_windows = getattr(loc, "operating_windows", None)
            curfews = (
                order.pickup_curfew_windows
                if stop.stop_type == "PICKUP"
                else order.delivery_curfew_windows
            )
            final_arrival = max(arr_after_drive, float(window_start))
            if curfews and op_windows:
                for _ in range(16):
                    after_curfew = advance_past_curfews(
                        final_arrival,
                        service_duration,
                        float(vehicle.payload_limit_kg),
                        curfews,
                    )
                    after_hours = align_arrival_with_warehouse_hours(
                        after_curfew, service_duration, op_windows
                    )
                    if abs(after_hours - final_arrival) <= 1e-6:
                        break
                    final_arrival = after_hours
            elif curfews:
                final_arrival = advance_past_curfews(
                    final_arrival,
                    service_duration,
                    float(vehicle.payload_limit_kg),
                    curfews,
                )
            elif op_windows:
                final_arrival = align_arrival_with_warehouse_hours(
                    final_arrival, service_duration, op_windows
                )
            if final_arrival > window_end + 0.01 or final_arrival > vehicle.available_end_sec:
                return ScheduledTimelineResult(
                    False,
                    f"{stop.stop_type} đơn {order.order_number} vượt khung giờ hoặc ca xe",
                )

            arrival = int(round(final_arrival))
            departure = arrival + service_duration
            if departure > vehicle.available_end_sec:
                return ScheduledTimelineResult(
                    False,
                    f"Xe {vehicle.plate_number} vượt thời gian khả dụng khi rời điểm {stop.location_name}",
                )

            leg_elapsed = max(0, arrival - int(round(leg_start)))
            if rest_enabled:
                travel_seconds = min(leg_elapsed, max(0, int(round(travel_time))))
            else:
                travel_seconds = min(leg_elapsed, max(0, int(round(travel_time))))
            waiting_seconds = max(0, leg_elapsed - travel_seconds)

            stop_wait_only = max(0, arrival - int(round(arr_after_drive)))
            _apply_stop_rest_credit(state, stop_wait_only, service_duration, rest_policy)

            scheduled.append(
                _copy_scheduled_stop_with_times(
                    stop,
                    sequence=sequence,
                    arrival_time_sec=arrival,
                    departure_time_sec=departure,
                    travel_time_sec=travel_seconds,
                    waiting_time_sec=waiting_seconds,
                    service_time_sec=service_duration,
                )
            )
            current_time = float(departure)
            previous_index = node_index

        if end_node_index is None:
            return_travel = 0
            return_waiting = 0
            route_end = int(round(current_time))
        else:
            ret_dist = float(distance_matrix[previous_index][end_node_index])
            ret_dur = float(duration_matrix[previous_index][end_node_index])
            if ret_dur < 0 or ret_dist < 0:
                return ScheduledTimelineResult(False, "Ma trận chặng về chứa giá trị âm")
            total_distance += ret_dist
            ret_arr, ret_rest_sec, ret_breaks, state, fail_msg = simulate_driving_leg(
                current_time, ret_dur, state, rest_policy, len(stops)
            )
            if fail_msg is not None:
                return ScheduledTimelineResult(False, fail_msg)
            total_mandatory_rest += ret_rest_sec
            all_breaks.extend(ret_breaks)
            route_end = int(round(ret_arr))
            if route_end > vehicle.available_end_sec:
                return ScheduledTimelineResult(
                    False,
                    f"Xe {vehicle.plate_number} không kịp về điểm kết thúc trong ca",
                )
            ret_elapsed = max(0, route_end - int(round(current_time)))
            return_travel = min(ret_elapsed, max(0, int(round(ret_dur))))
            return_waiting = max(0, ret_elapsed - return_travel)

        end_location = resolve_vehicle_end_location(vehicle, scheduled, order_by_id)
        hops = extract_province_hops(vehicle, scheduled, order_by_id, end_location)
        return ScheduledTimelineResult(
            feasible=True,
            scheduled_stops=scheduled,
            route_start_sec=int(round(start_sec)),
            route_end_sec=route_end,
            return_travel_time_sec=return_travel,
            return_waiting_time_sec=return_waiting,
            mandatory_rest_sec=total_mandatory_rest,
            rest_breaks=all_breaks,
            total_distance_meters=total_distance,
            province_hops=hops,
        )

    base_start = float(vehicle.available_start_sec if initial_start_sec is None else initial_start_sec)
    first_pass = _run_pass(base_start)
    if not first_pass.feasible or not apply_jit_start:
        return first_pass

    first_stop = first_pass.scheduled_stops[0]
    first_leg_breaks_sec = sum(
        b.duration_sec for b in first_pass.rest_breaks if b.leg_after_sequence == 0
    )
    jit_start = max(
        int(round(base_start)),
        first_stop.arrival_time_sec - first_stop.travel_time_sec - first_leg_breaks_sec,
    )
    if jit_start <= int(round(base_start)):
        return first_pass

    second_pass = _run_pass(float(jit_start))
    if second_pass.feasible:
        return second_pass
    return first_pass


def _copy_scheduled_stop_with_times(
    stop: Any,
    *,
    sequence: int,
    arrival_time_sec: int,
    departure_time_sec: int,
    travel_time_sec: int,
    waiting_time_sec: int,
    service_time_sec: int,
) -> Any:
    """Update both Pydantic ScheduledStop and lightweight dataclass ScheduledStop."""
    if hasattr(stop, "model_copy"):
        return stop.model_copy(
            update={
                "sequence": sequence,
                "arrival_time_sec": arrival_time_sec,
                "departure_time_sec": departure_time_sec,
                "travel_time_sec": travel_time_sec,
                "waiting_time_sec": waiting_time_sec,
                "service_time_sec": service_time_sec,
            }
        )
    from dataclasses import replace

    return replace(
        stop,
        sequence=sequence,
        arrival_time_sec=arrival_time_sec,
        departure_time_sec=departure_time_sec,
        travel_time_sec=travel_time_sec,
        waiting_time_sec=waiting_time_sec,
        service_time_sec=service_time_sec,
    )
