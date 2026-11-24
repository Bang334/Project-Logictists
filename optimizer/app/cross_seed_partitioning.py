"""Cross-seed CP-SAT route recombination over already-audited 3D worker plans."""

from __future__ import annotations

from collections import defaultdict
import copy
from dataclasses import dataclass
from typing import Dict, FrozenSet, List, Optional, Sequence, Set, Tuple

from ortools.sat.python import cp_model

from .driver_matcher import DriverMatcher
from .models import (
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    OptimizedRoute,
    PlanningObjectiveBreakdown,
    can_driver_drive_vehicle,
)
from .planning_objective import (
    apply_planning_objective,
    calendar_salary_for_span,
    route_operational_late_penalty,
)


@dataclass(frozen=True)
class _PoolRouteEntry:
    route: OptimizedRoute
    served_orders: FrozenSet[str]
    day_index: int
    slot_id: str
    physical_vehicle_id: str
    plate_number: str
    start_sec: int
    end_sec: int
    linear_score_vnd: int
    payload_limit_kg: float
    vehicle_type: str


def _validate_and_extract_orders(
    route: OptimizedRoute,
    expected_items: Dict[str, Set[str]],
) -> Optional[FrozenSet[str]]:
    """Return served allocation IDs only when a route covers complete orders safely."""
    if not route.stops:
        return None
    if not (route.spatial_validation and route.spatial_validation.is_valid):
        return None
    if route.cost is None:
        return None

    picked_by_order: Dict[str, Set[str]] = defaultdict(set)
    delivered_by_order: Dict[str, Set[str]] = defaultdict(set)
    for stop in route.stops:
        oid = stop.allocation_id or stop.order_id
        if not oid or oid not in expected_items:
            return None
        if stop.stop_type == "PICKUP":
            if any(item_id in picked_by_order[oid] for item_id in stop.items_loaded):
                return None
            picked_by_order[oid].update(stop.items_loaded)
        elif stop.stop_type == "DELIVERY":
            if any(item_id in delivered_by_order[oid] for item_id in stop.items_unloaded):
                return None
            delivered_by_order[oid].update(stop.items_unloaded)

    if not picked_by_order or picked_by_order != delivered_by_order:
        return None
    for oid, items_set in picked_by_order.items():
        if items_set != expected_items[oid]:
            return None
    return frozenset(picked_by_order.keys())


def route_pool_signature(route: OptimizedRoute) -> Tuple:
    return (
        route.service_day_index,
        route.route_id or route.vehicle_id,
        route.vehicle_id,
        tuple(
            (
                stop.stop_type,
                stop.allocation_id or stop.order_id or "",
                tuple(stop.items_loaded),
                tuple(stop.items_unloaded),
            )
            for stop in route.stops
        ),
    )


_route_pool_signature = route_pool_signature


def _physical_vehicle_overlap_free(
    routes: Sequence[OptimizedRoute],
) -> bool:
    """Verify physical trucks do not run twice in a day or overlap across days."""
    intervals_by_vehicle: Dict[str, List[Tuple[int, int, int, str]]] = defaultdict(list)
    for route in routes:
        phys_id = route.vehicle_id or route.plate_number
        if not phys_id:
            continue
        start_s = int(route.start_time_sec)
        end_s = int(route.end_time_sec)
        day_idx = int(route.service_day_index)
        plate = route.plate_number
        for prev_day, prev_start, prev_end, prev_plate in intervals_by_vehicle[phys_id]:
            if day_idx == prev_day:
                return False
            if start_s < prev_end and prev_start < end_s:
                return False
            if plate and prev_plate and plate == prev_plate and start_s < prev_end and prev_start < end_s:
                return False
        intervals_by_vehicle[phys_id].append((day_idx, start_s, end_s, plate))
    return True


def _build_interchangeable_vehicle_groups(
    request: FleetOptimizationRequest,
) -> Tuple[Dict[str, Tuple], Dict[Tuple, List[int]]]:
    """Group same-day vehicles with identical geometry, cost, shift window, and matrix rows."""
    nv = len(request.vehicles)
    if nv < 2:
        return {}, {}

    dist_m = request.distance_matrix_meters
    dur_s = request.duration_matrix_seconds

    phys_intervals: Dict[str, List[Tuple[int, int, int]]] = defaultdict(list)
    day_plate_counts: Dict[Tuple[int, str], int] = defaultdict(int)
    day_phys_counts: Dict[Tuple[int, str], int] = defaultdict(int)
    for v in request.vehicles:
        phys_id = v.source_vehicle_id or v.id
        phys_intervals[phys_id].append((v.service_day_index, v.available_start_sec, v.available_end_sec))
        if v.plate_number:
            day_plate_counts[(v.service_day_index, v.plate_number)] += 1
        day_phys_counts[(v.service_day_index, phys_id)] += 1

    cross_day_overlap_phys: Set[str] = set()
    for phys_id, slots in phys_intervals.items():
        if len(slots) <= 1:
            continue
        for i in range(len(slots)):
            d1, s1, e1 = slots[i]
            for j in range(i + 1, len(slots)):
                d2, s2, e2 = slots[j]
                if d1 != d2 and s1 < e2 and s2 < e1:
                    cross_day_overlap_phys.add(phys_id)
                    break
            if phys_id in cross_day_overlap_phys:
                break

    raw_groups: Dict[Tuple, List[int]] = defaultdict(list)
    for v_idx, v in enumerate(request.vehicles):
        phys_id = v.source_vehicle_id or v.id
        if phys_id in cross_day_overlap_phys:
            continue
        if v.plate_number and day_plate_counts[(v.service_day_index, v.plate_number)] > 1:
            continue
        if day_phys_counts[(v.service_day_index, phys_id)] > 1:
            continue
        profile = (
            v.service_day_index,
            v.available_start_sec,
            v.available_end_sec,
            float(v.length_cm),
            float(v.width_cm),
            float(v.height_cm),
            float(v.payload_limit_kg),
            v.door_position,
            float(v.door_width_cm) if v.door_width_cm is not None else None,
            v.vehicle_type or "",
            v.model or "",
            int(v.fixed_operating_cost_vnd),
            float(v.fuel_consumption_liters_per_100_km),
            float(v.load_fuel_surcharge_percent_at_full_payload),
            round(float(v.depot.latitude), 6),
            round(float(v.depot.longitude), 6),
            tuple(dist_m[v_idx][nv:]),
            tuple(row[v_idx] for row in dist_m[nv:]),
            tuple(dur_s[v_idx][nv:]),
            tuple(row[v_idx] for row in dur_s[nv:]),
        )
        raw_groups[profile].append(v_idx)

    group_slots: Dict[Tuple, List[int]] = {
        profile: indices for profile, indices in raw_groups.items() if len(indices) >= 2
    }
    slot_to_group: Dict[str, Tuple] = {
        request.vehicles[v_idx].id: profile
        for profile, indices in group_slots.items()
        for v_idx in indices
    }
    return slot_to_group, group_slots


def _is_entry_flexible_in_group(
    entry: _PoolRouteEntry,
    group_key: Optional[Tuple],
    group_slots: Dict[Tuple, List[int]],
    request: FleetOptimizationRequest,
    order_by_id: dict,
    vehicle_by_id: Dict[str, FleetVehicle],
) -> bool:
    if group_key is None:
        return False
    orig_veh = vehicle_by_id.get(entry.slot_id)
    if orig_veh is None:
        return False
    if entry.start_sec < orig_veh.available_start_sec or entry.end_sec > orig_veh.available_end_sec:
        return False

    group_vehicles = [request.vehicles[idx] for idx in group_slots[group_key]]
    for oid in entry.served_orders:
        order = order_by_id.get(oid)
        if order is None:
            return False
        allowed = order.allowed_source_vehicle_ids
        if not allowed:
            continue
        allowed_set = set(allowed)
        if not all(
            (v.id in allowed_set) or ((v.source_vehicle_id or v.id) in allowed_set)
            for v in group_vehicles
        ):
            return False
    return True


def _materialize_selected_routes(
    selected_entries: Sequence[_PoolRouteEntry],
    entry_groups: Sequence[Optional[Tuple]],
    entry_flexible: Sequence[bool],
    group_slots: Dict[Tuple, List[int]],
    request: FleetOptimizationRequest,
    vehicle_by_id: Dict[str, FleetVehicle],
) -> Optional[List[OptimizedRoute]]:
    """Assign pinned routes to exact slots and map flexible routes onto free identical slots."""
    used_slots: Set[str] = set()
    used_day_plates: Set[Tuple[int, str]] = set()
    used_day_phys: Set[Tuple[int, str]] = set()
    intervals_by_phys: Dict[str, List[Tuple[int, int]]] = defaultdict(list)
    materialized: List[Optional[OptimizedRoute]] = [None] * len(selected_entries)

    def _claim(slot_id: str, day_idx: int, plate: str, phys_id: str, start_s: int, end_s: int) -> bool:
        if slot_id in used_slots:
            return False
        if plate and (day_idx, plate) in used_day_plates:
            return False
        if phys_id and (day_idx, phys_id) in used_day_phys:
            return False
        if phys_id:
            for prev_start, prev_end in intervals_by_phys[phys_id]:
                if start_s < prev_end and prev_start < end_s:
                    return False
        used_slots.add(slot_id)
        if plate:
            used_day_plates.add((day_idx, plate))
        if phys_id:
            used_day_phys.add((day_idx, phys_id))
            intervals_by_phys[phys_id].append((start_s, end_s))
        return True

    # 1. Place all pinned routes on their original vehicle slots first.
    flexible_indices: List[int] = []
    for pos, entry in enumerate(selected_entries):
        if not entry_flexible[pos]:
            if not _claim(
                entry.slot_id,
                entry.day_index,
                entry.plate_number,
                entry.physical_vehicle_id,
                entry.start_sec,
                entry.end_sec,
            ):
                return None
            materialized[pos] = copy.deepcopy(entry.route)
        else:
            flexible_indices.append(pos)

    # 2. Keep original slots for flexible routes when available; reassign collisions within group.
    deferred_indices: List[int] = []
    for pos in flexible_indices:
        entry = selected_entries[pos]
        if _claim(
            entry.slot_id,
            entry.day_index,
            entry.plate_number,
            entry.physical_vehicle_id,
            entry.start_sec,
            entry.end_sec,
        ):
            materialized[pos] = copy.deepcopy(entry.route)
        else:
            deferred_indices.append(pos)

    for pos in deferred_indices:
        entry = selected_entries[pos]
        group_key = entry_groups[pos]
        if group_key is None:
            return None
        orig_veh = vehicle_by_id.get(entry.slot_id)
        assigned_route: Optional[OptimizedRoute] = None
        for v_idx in group_slots[group_key]:
            cand_veh = request.vehicles[v_idx]
            cand_phys = cand_veh.source_vehicle_id or cand_veh.id
            if not _claim(
                cand_veh.id,
                cand_veh.service_day_index,
                cand_veh.plate_number,
                cand_phys,
                entry.start_sec,
                entry.end_sec,
            ):
                continue
            cloned = copy.deepcopy(entry.route)
            cloned.route_id = cand_veh.id
            cloned.vehicle_id = cand_phys
            cloned.plate_number = cand_veh.plate_number
            if cloned.depot is not None:
                cloned.depot = cand_veh.depot.model_copy()
            if cloned.end_location is not None and (
                (orig_veh is not None and cloned.end_location.id == orig_veh.depot.id)
                or cloned.end_location.id == entry.slot_id
            ):
                cloned.end_location = cand_veh.depot.model_copy()
            assigned_route = cloned
            break
        if assigned_route is None:
            return None
        materialized[pos] = assigned_route

    return [r for r in materialized if r is not None]


def _eligible_driver_overlap_free(
    request: FleetOptimizationRequest,
    routes: Sequence[OptimizedRoute],
) -> bool:
    """Verify physical drivers do not overlap across day boundaries."""
    driver_by_id: Dict[str, DriverOption] = {d.id: d for d in request.drivers}
    intervals_by_driver: Dict[str, List[Tuple[int, int]]] = defaultdict(list)
    for route in routes:
        if not route.driver_id:
            continue
        drv = driver_by_id.get(route.driver_id)
        phys_id = (drv.source_driver_id or drv.id) if drv is not None else route.driver_id
        start_s = int(route.start_time_sec)
        end_s = int(route.end_time_sec)
        for prev_start, prev_end in intervals_by_driver[phys_id]:
            if start_s < prev_end and prev_start < end_s:
                return False
        intervals_by_driver[phys_id].append((start_s, end_s))
    return True


def _ingest_pool_route(
    route: OptimizedRoute,
    *,
    expected_items: Dict[str, Set[str]],
    vehicle_by_id: Dict[str, FleetVehicle],
    order_by_id: dict,
    request: FleetOptimizationRequest,
    has_daily_resource_slots: bool,
    pool_by_sig: Dict[Tuple, _PoolRouteEntry],
) -> None:
    served = _validate_and_extract_orders(route, expected_items)
    if served is None:
        return

    slot_id = route.route_id or route.vehicle_id
    veh = vehicle_by_id.get(slot_id)
    phys_veh_id = route.vehicle_id or (veh.source_vehicle_id or veh.id if veh else slot_id)
    plate = route.plate_number or (veh.plate_number if veh else phys_veh_id)
    op_cost = int(route.cost.total_cost_vnd) if route.cost else 0
    active_sal = int(route.cost.driver_fixed_salary_allocation_vnd) if route.cost else 0
    late_pen = route_operational_late_penalty(request, route.stops, order_by_id=order_by_id)
    linear_score = max(
        0,
        op_cost - (active_sal if has_daily_resource_slots else 0) + late_pen,
    )

    entry = _PoolRouteEntry(
        route=route,
        served_orders=served,
        day_index=int(route.service_day_index),
        slot_id=slot_id,
        physical_vehicle_id=phys_veh_id,
        plate_number=plate,
        start_sec=int(route.start_time_sec),
        end_sec=int(route.end_time_sec),
        linear_score_vnd=linear_score,
        payload_limit_kg=float(veh.payload_limit_kg) if veh else 0.0,
        vehicle_type=(veh.vehicle_type or veh.model or "") if veh else "",
    )
    sig = _route_pool_signature(route)
    existing = pool_by_sig.get(sig)
    if existing is None or entry.linear_score_vnd < existing.linear_score_vnd:
        pool_by_sig[sig] = entry


def solve_cross_seed_set_partitioning(
    request: FleetOptimizationRequest,
    complete_plans: Sequence[FleetOptimizationResponse],
    expected_items: Dict[str, Set[str]],
    *,
    compare_horizons: bool,
    extra_routes: Sequence[OptimizedRoute] = (),
    allow_vehicle_profile_reassignment: bool = True,
    time_limit_sec: float = 1.5,
) -> Optional[Tuple[FleetOptimizationResponse, PlanningObjectiveBreakdown]]:
    """Combine already-audited 3D routes across seeds using CP-SAT set partitioning."""
    if not complete_plans or (len(complete_plans) < 2 and not extra_routes):
        return None
    if not expected_items or not request.drivers:
        return None

    vehicle_by_id: Dict[str, FleetVehicle] = {v.id: v for v in request.vehicles}
    order_by_id = {o.id: o for o in request.orders}
    all_order_ids = set(expected_items.keys())
    has_daily_resource_slots = any(
        vehicle.source_vehicle_id is not None for vehicle in request.vehicles
    ) and any(driver.source_driver_id is not None for driver in request.drivers)

    pool_by_sig: Dict[Tuple, _PoolRouteEntry] = {}
    for plan in complete_plans:
        for route in plan.routes:
            _ingest_pool_route(
                route,
                expected_items=expected_items,
                vehicle_by_id=vehicle_by_id,
                order_by_id=order_by_id,
                request=request,
                has_daily_resource_slots=has_daily_resource_slots,
                pool_by_sig=pool_by_sig,
            )
    for route in extra_routes:
        _ingest_pool_route(
            route,
            expected_items=expected_items,
            vehicle_by_id=vehicle_by_id,
            order_by_id=order_by_id,
            request=request,
            has_daily_resource_slots=has_daily_resource_slots,
            pool_by_sig=pool_by_sig,
        )

    pool_entries: List[_PoolRouteEntry] = list(pool_by_sig.values())

    if len(pool_entries) <= 1:
        return None

    routes_by_order: Dict[str, List[int]] = {oid: [] for oid in all_order_ids}
    for idx, entry in enumerate(pool_entries):
        for oid in entry.served_orders:
            routes_by_order[oid].append(idx)
    if any(not indices for indices in routes_by_order.values()):
        return None

    model = cp_model.CpModel()
    x = [model.NewBoolVar(f"x_{i}") for i in range(len(pool_entries))]

    for indices in routes_by_order.values():
        model.Add(sum(x[i] for i in indices) == 1)

    if allow_vehicle_profile_reassignment:
        slot_to_group, group_slots = _build_interchangeable_vehicle_groups(request)
    else:
        slot_to_group, group_slots = {}, {}
    entry_groups: List[Optional[Tuple]] = []
    entry_flexible: List[bool] = []
    for entry in pool_entries:
        g_key = slot_to_group.get(entry.slot_id)
        entry_groups.append(g_key)
        entry_flexible.append(
            _is_entry_flexible_in_group(
                entry, g_key, group_slots, request, order_by_id, vehicle_by_id,
            )
        )

    by_slot: Dict[str, List[int]] = defaultdict(list)
    by_day_plate: Dict[Tuple[int, str], List[int]] = defaultdict(list)
    by_day_phys_veh: Dict[Tuple[int, str], List[int]] = defaultdict(list)
    by_phys_veh: Dict[str, List[int]] = defaultdict(list)
    by_profile_group: Dict[Tuple, List[int]] = defaultdict(list)
    by_day: Dict[int, List[int]] = defaultdict(list)

    for idx, entry in enumerate(pool_entries):
        g_key = entry_groups[idx]
        if g_key is not None:
            by_profile_group[g_key].append(idx)
        if not entry_flexible[idx]:
            by_slot[entry.slot_id].append(idx)
            by_day_plate[(entry.day_index, entry.plate_number)].append(idx)
            by_day_phys_veh[(entry.day_index, entry.physical_vehicle_id)].append(idx)
            by_phys_veh[entry.physical_vehicle_id].append(idx)
        by_day[entry.day_index].append(idx)

    for group in (*by_slot.values(), *by_day_plate.values(), *by_day_phys_veh.values()):
        if len(group) > 1:
            model.Add(sum(x[i] for i in group) <= 1)

    for g_key, group_indices in by_profile_group.items():
        cap = len(group_slots[g_key])
        if len(group_indices) > cap:
            model.Add(sum(x[i] for i in group_indices) <= cap)

    # Prevent cross-day physical truck schedule overlaps (e.g. overnight routes).
    for indices in by_phys_veh.values():
        if len(indices) <= 1:
            continue
        for pos_a in range(len(indices)):
            i = indices[pos_a]
            ei = pool_entries[i]
            for pos_b in range(pos_a + 1, len(indices)):
                j = indices[pos_b]
                ej = pool_entries[j]
                if ei.day_index != ej.day_index and ei.start_sec < ej.end_sec and ej.start_sec < ei.end_sec:
                    model.Add(x[i] + x[j] <= 1)

    drivers_by_day: Dict[int, List[DriverOption]] = defaultdict(list)
    for driver in request.drivers:
        drivers_by_day[driver.service_day_index].append(driver)

    max_routes_per_day = request.policy.max_routes_per_day
    for day, indices in by_day.items():
        day_drivers = drivers_by_day.get(day, [])
        day_limit = len(day_drivers)
        if max_routes_per_day is not None:
            day_limit = min(day_limit, max_routes_per_day)
        model.Add(sum(x[i] for i in indices) <= day_limit)
        if day_limit == 0:
            continue
        # Enforce Hall license-tier capacity across cumulative eligible driver subsets on that day.
        route_driver_masks = {
            i: frozenset(
                d_idx
                for d_idx, drv in enumerate(day_drivers)
                if can_driver_drive_vehicle(
                    drv.license_class,
                    pool_entries[i].payload_limit_kg,
                    pool_entries[i].vehicle_type,
                )
            )
            for i in indices
        }
        for allowed_mask in set(route_driver_masks.values()):
            constrained_routes = [i for i in indices if route_driver_masks[i].issubset(allowed_mask)]
            if len(allowed_mask) < len(constrained_routes):
                model.Add(sum(x[i] for i in constrained_routes) <= len(allowed_mask))

    max_span = max((entry.day_index + 1 for entry in pool_entries), default=1)
    span_ge: Dict[int, cp_model.IntVar] = {}
    if has_daily_resource_slots and max_span >= 2:
        for s in range(2, max_span + 1):
            span_ge[s] = model.NewBoolVar(f"span_ge_{s}")
            if s > 2:
                model.Add(span_ge[s - 1] >= span_ge[s])
        for idx, entry in enumerate(pool_entries):
            req_span = entry.day_index + 1
            if req_span >= 2:
                model.Add(span_ge[req_span] >= x[idx])

    linear_terms = [entry.linear_score_vnd * x[idx] for idx, entry in enumerate(pool_entries)]
    calendar_terms = []
    if has_daily_resource_slots and max_span >= 2:
        for s in range(2, max_span + 1):
            delta = max(0, calendar_salary_for_span(request, s) - calendar_salary_for_span(request, s - 1))
            if delta:
                calendar_terms.append(delta * span_ge[s])

    score_upper_bound = sum(entry.linear_score_vnd for entry in pool_entries) + (
        calendar_salary_for_span(request, max_span) if has_daily_resource_slots else 0
    )
    if compare_horizons:
        model.Minimize(sum(linear_terms) + sum(calendar_terms) + sum(x))
    else:
        route_weight = max(1_000_000_000, score_upper_bound + 1)
        model.Minimize(route_weight * sum(x) + sum(linear_terms) + sum(calendar_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max(0.2, float(time_limit_sec))
    solver.parameters.num_workers = 1
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    selected_pos = [
        idx for idx in range(len(pool_entries)) if solver.Value(x[idx]) == 1
    ]
    if not selected_pos:
        return None
    selected_routes = _materialize_selected_routes(
        [pool_entries[idx] for idx in selected_pos],
        [entry_groups[idx] for idx in selected_pos],
        [entry_flexible[idx] for idx in selected_pos],
        group_slots,
        request,
        vehicle_by_id,
    )
    if not selected_routes or not _physical_vehicle_overlap_free(selected_routes):
        return None

    selected_routes.sort(
        key=lambda r: (r.service_day_index, r.start_time_sec, r.route_id or r.vehicle_id)
    )
    try:
        DriverMatcher(request).assign_drivers_to_routes(selected_routes)
    except ValueError:
        return None

    if not _eligible_driver_overlap_free(request, selected_routes):
        return None

    total_distance_km = round(sum(r.total_distance_km for r in selected_routes), 2)
    total_duration_minutes = round(sum(r.total_duration_minutes for r in selected_routes), 2)
    total_cost_vnd = sum(r.cost.total_cost_vnd for r in selected_routes if r.cost is not None)

    combined = FleetOptimizationResponse(
        job_id=request.job_id,
        status="SUCCESS",
        total_distance_km=total_distance_km,
        total_duration_minutes=total_duration_minutes,
        total_cost_vnd=total_cost_vnd,
        routes=selected_routes,
        unassigned_orders=[],
        diagnostics=[
            "Cross-seed CP-SAT: đã tổ hợp các tuyến đã kiểm chứng 3D từ nhiều seed song song."
        ],
    )
    breakdown = apply_planning_objective(request, combined)
    return combined, breakdown
