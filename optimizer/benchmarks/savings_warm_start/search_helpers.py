"""General search helpers for heterogeneous consolidation, operational lateness, and bounded polish."""

from __future__ import annotations

import copy
import math
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

from app.alns_engine import calendar_salary_for_span
from app.models import FleetOptimizationResponse, OrderPair, ScheduledStop
from app.packing_rules import resolve_can_rotate
from app.planning_objective import (
    apply_planning_objective,
    operational_late_daily_weight_vnd,
    plan_lexicographic_key,
)
from app.route_costing import calculate_late_delivery_penalty
from app.stacking import effective_floor_capacity_cm2

SECONDS_PER_DAY = 86_400


def request_packing_intensity(request: Any) -> float:
    """Return a continuous [0, 1] packing-density index from items per order."""
    orders = getattr(request, "orders", ()) or ()
    total_orders = len(orders)
    if total_orders <= 0:
        return 0.0
    total_items = sum(len(order.items) for order in orders)
    max_items = max((len(order.items) for order in orders), default=0)
    avg_items = total_items / total_orders
    return min(
        1.0,
        max(0.0, (avg_items - 3.0) / 14.0) * 0.65
        + max(0.0, (max_items - 8.0) / 24.0) * 0.35,
    )


def route_stop_signature(stops: Sequence[ScheduledStop]) -> Tuple[Tuple[str, str], ...]:
    """Return canonical stop sequence key for caching route schedules/costs."""
    return tuple(
        (stop.allocation_id or stop.order_id or "", stop.stop_type)
        for stop in stops
    )


def vehicle_profile(
    vehicle: Any,
    *,
    shares_active_physical: bool = False,
    restricted_tag: Optional[str] = None,
) -> Tuple[object, ...]:
    """Group interchangeable vehicle slots by physical, cost, and time attributes."""
    return (
        vehicle.service_day_index,
        vehicle.available_start_sec,
        vehicle.available_end_sec,
        vehicle.depot.id,
        vehicle.length_cm,
        vehicle.width_cm,
        vehicle.height_cm,
        vehicle.payload_limit_kg,
        vehicle.door_position,
        vehicle.door_width_cm,
        vehicle.vehicle_type,
        vehicle.fuel_consumption_liters_per_100_km,
        vehicle.load_fuel_surcharge_percent_at_full_payload,
        vehicle.fixed_operating_cost_vnd,
        shares_active_physical,
        restricted_tag,
    )


def representative_empty_indices(
    optimizer: Any,
    routes: Sequence[Sequence[Any]],
) -> List[int]:
    """Keep one empty slot per interchangeable vehicle profile."""
    active_physical = {
        optimizer.vehicles[idx].source_vehicle_id or optimizer.vehicles[idx].id
        for idx, route in enumerate(routes)
        if route
    }
    restricted_ids: Set[str] = set()
    for order in optimizer.orders:
        if order.allowed_source_vehicle_ids:
            restricted_ids.update(order.allowed_source_vehicle_ids)

    representatives: List[int] = []
    seen: Set[Tuple[object, ...]] = set()
    for index, route in enumerate(routes):
        if route:
            continue
        vehicle = optimizer.vehicles[index]
        phys_id = vehicle.source_vehicle_id or vehicle.id
        restricted_tag = (
            phys_id
            if (phys_id in restricted_ids or vehicle.id in restricted_ids)
            else None
        )
        profile = vehicle_profile(
            vehicle,
            shares_active_physical=(phys_id in active_physical),
            restricted_tag=restricted_tag,
        )
        if profile in seen:
            continue
        seen.add(profile)
        representatives.append(index)
    return representatives


def route_operational_lateness_vnd(
    order_by_id: Dict[str, OrderPair],
    search_policy: Any,
    stops: Sequence[ScheduledStop],
) -> int:
    """Compute operational lateness penalty on scheduled route stops using search_policy."""
    if not stops or search_policy.late_delivery_penalty_mode == "NONE":
        return 0
    latest_by_source: Dict[str, Tuple[OrderPair, int]] = {}
    for stop in stops:
        if stop.stop_type != "DELIVERY":
            continue
        oid = stop.allocation_id or stop.order_id
        order = order_by_id.get(oid or "")
        if order is None:
            continue
        source_id = order.source_order_id or order.id
        prev = latest_by_source.get(source_id)
        if prev is None or stop.arrival_time_sec > prev[1]:
            latest_by_source[source_id] = (order, int(stop.arrival_time_sec))
    return sum(
        calculate_late_delivery_penalty(order, arrival_sec, search_policy)
        for order, arrival_sec in latest_by_source.values()
    )


def plan_operational_lateness_vnd(
    optimizer: Any,
    routes_stops: Sequence[Sequence[ScheduledStop]],
) -> int:
    """Compute plan-wide operational lateness, grouped once per source order across trips."""
    search_policy = getattr(optimizer, "_search_policy", optimizer.policy)
    if search_policy.late_delivery_penalty_mode == "NONE":
        return 0

    latest_by_source: Dict[str, Tuple[OrderPair, int]] = {}
    sched_cache: Dict[Tuple[int, Tuple[Tuple[str, str], ...]], Optional[List[ScheduledStop]]] = (
        getattr(optimizer, "_route_schedule_cache", {})
    )
    for v_idx, stops in enumerate(routes_stops):
        if not stops:
            continue
        sig = route_stop_signature(stops)
        key = (v_idx, sig)
        scheduled_stops = sched_cache.get(key)
        if key not in sched_cache:
            scheduled = optimizer._schedule_stops(v_idx, list(stops))
            scheduled_stops = scheduled[0] if scheduled is not None else None
            if len(sched_cache) >= 8192:
                sched_cache.clear()
            sched_cache[key] = scheduled_stops
        eval_stops = scheduled_stops if scheduled_stops is not None else stops
        for stop in eval_stops:
            if stop.stop_type != "DELIVERY":
                continue
            oid = stop.allocation_id or stop.order_id
            order = optimizer.order_by_id.get(oid or "")
            if order is None:
                continue
            source_id = order.source_order_id or order.id
            prev = latest_by_source.get(source_id)
            if prev is None or stop.arrival_time_sec > prev[1]:
                latest_by_source[source_id] = (order, int(stop.arrival_time_sec))

    return sum(
        calculate_late_delivery_penalty(order, arrival_sec, search_policy)
        for order, arrival_sec in latest_by_source.values()
    )


def _max_routes_allows_day(
    optimizer: Any,
    routes: Sequence[Sequence[Any]],
    day_index: int,
    *,
    excluding_index: Optional[int] = None,
) -> bool:
    max_routes = getattr(optimizer.request.policy, "max_routes_per_day", None)
    if max_routes is None:
        return True
    active_on_day = sum(
        1
        for idx, r in enumerate(routes)
        if r and idx != excluding_index and optimizer.vehicles[idx].service_day_index == day_index
    )
    return active_on_day < max_routes


def _all_orders_allow_vehicle(optimizer: Any, stops: Sequence[ScheduledStop], vehicle: Any) -> bool:
    for stop in stops:
        if stop.stop_type != "PICKUP":
            continue
        oid = stop.allocation_id or stop.order_id
        order = optimizer.order_by_id.get(oid or "")
        if order is not None and not optimizer._order_allows_vehicle(order, vehicle):
            return False
    return True


def _route_max_load(optimizer: Any, stops: Sequence[ScheduledStop]) -> Tuple[float, float]:
    weight = 0.0
    area = 0.0
    max_w = 0.0
    max_a = 0.0
    for stop in stops:
        oid = stop.allocation_id or stop.order_id
        order = optimizer.order_by_id.get(oid or "")
        if order is None:
            continue
        ow = order.total_weight_kg
        oa = sum(item.length_cm * item.width_cm for item in order.items)
        if stop.stop_type == "PICKUP":
            weight += ow
            area += oa
            max_w = max(max_w, weight)
            max_a = max(max_a, area)
        else:
            weight = max(0.0, weight - ow)
            area = max(0.0, area - oa)
    return max_w, max_a


def bounded_vehicle_reassignment(
    optimizer: Any,
    routes: List[List[ScheduledStop]],
    unassigned: List[str],
    deadline: float,
) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
    """Reassign active routes to better empty slots within deadline using profile dedup."""
    if time.perf_counter() >= deadline:
        return None
    current_cost, _, _ = optimizer._evaluate_plan_cost(routes, unassigned)
    current_key = optimizer._candidate_key(routes, unassigned)
    best_cand = None
    active_indices = [i for i, r in enumerate(routes) if r]
    active_physical = {
        optimizer.vehicles[i].source_vehicle_id or optimizer.vehicles[i].id
        for i in active_indices
    }
    empty_reps = representative_empty_indices(optimizer, routes)

    for src_i in active_indices:
        if time.perf_counter() >= deadline:
            break
        src_v = optimizer.vehicles[src_i]
        stops = routes[src_i]
        max_w, _ = _route_max_load(optimizer, stops)
        for tgt_i in empty_reps:
            if time.perf_counter() >= deadline:
                break
            tgt_v = optimizer.vehicles[tgt_i]
            if (
                tgt_v.service_day_index != src_v.service_day_index
                and not _max_routes_allows_day(
                    optimizer, routes, tgt_v.service_day_index, excluding_index=src_i
                )
            ):
                continue
            if (
                tgt_v.service_day_index >= src_v.service_day_index
                and tgt_v.available_start_sec >= src_v.available_start_sec
                and tgt_v.depot.id == src_v.depot.id
                and tgt_v.fixed_operating_cost_vnd >= src_v.fixed_operating_cost_vnd
                and tgt_v.fuel_consumption_liters_per_100_km >= src_v.fuel_consumption_liters_per_100_km
                and (tgt_v.source_vehicle_id or tgt_v.id) not in active_physical
            ):
                continue
            if max_w > tgt_v.payload_limit_kg + 0.01:
                continue
            if not optimizer._vehicle_has_compatible_driver(tgt_v):
                continue
            if not _all_orders_allow_vehicle(optimizer, stops, tgt_v):
                continue
            scheduled = optimizer._schedule_stops(tgt_i, stops)
            if scheduled is None:
                continue
            cand_routes = list(routes)
            cand_routes[src_i] = []
            cand_routes[tgt_i] = scheduled[0]
            c_key = optimizer._candidate_key(cand_routes, unassigned)
            if c_key < current_key and (best_cand is None or c_key < best_cand[0]):
                if not optimizer._validate_stops_cached(tgt_i, scheduled[0]):
                    continue
                c_cost, _, _ = optimizer._evaluate_plan_cost(cand_routes, unassigned)
                best_cand = (c_key, c_cost, cand_routes)
    if best_cand is None:
        return None
    return (best_cand[1], best_cand[2], list(unassigned))


def bounded_optimize_production_vehicles(
    optimizer: Any,
    routes: List[List[ScheduledStop]],
    unassigned: List[str],
    deadline: float,
) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
    """Deadline-bounded idle vehicle reassignment and active vehicle swaps ranked by production audit."""
    if time.perf_counter() >= deadline:
        return None
    cur_routes = list(routes)
    cur_unassigned = list(unassigned)
    cur_rank = optimizer._rank_candidate_for_audit(cur_routes, cur_unassigned)
    changed = False
    max_passes = max(4, len(optimizer.vehicles))

    for _ in range(max_passes):
        if time.perf_counter() >= deadline:
            break
        step_changed = False
        active_indices = [i for i, r in enumerate(cur_routes) if r]
        active_physical = {
            optimizer.vehicles[i].source_vehicle_id or optimizer.vehicles[i].id
            for i in active_indices
        }
        route_weights = {
            idx: _route_max_load(optimizer, cur_routes[idx])[0]
            for idx in active_indices
        }
        empty_reps = representative_empty_indices(optimizer, cur_routes)
        direct_cands: List[Tuple[Tuple[int, ...], int, List[List[ScheduledStop]]]] = []
        for src_i in active_indices:
            if time.perf_counter() >= deadline:
                break
            src_v = optimizer.vehicles[src_i]
            stops = cur_routes[src_i]
            max_w = route_weights[src_i]
            for tgt_i in empty_reps:
                if time.perf_counter() >= deadline:
                    break
                tgt_v = optimizer.vehicles[tgt_i]
                if (
                    tgt_v.service_day_index != src_v.service_day_index
                    and not _max_routes_allows_day(
                        optimizer, cur_routes, tgt_v.service_day_index, excluding_index=src_i
                    )
                ):
                    continue
                if max_w > tgt_v.payload_limit_kg + 0.01:
                    continue
                if (
                    tgt_v.service_day_index >= src_v.service_day_index
                    and tgt_v.available_start_sec >= src_v.available_start_sec
                    and tgt_v.depot.id == src_v.depot.id
                    and tgt_v.fixed_operating_cost_vnd >= src_v.fixed_operating_cost_vnd
                    and tgt_v.fuel_consumption_liters_per_100_km >= src_v.fuel_consumption_liters_per_100_km
                    and (tgt_v.source_vehicle_id or tgt_v.id) not in active_physical
                ):
                    continue
                if not optimizer._vehicle_has_compatible_driver(tgt_v):
                    continue
                if not _all_orders_allow_vehicle(optimizer, stops, tgt_v):
                    continue
                scheduled = optimizer._schedule_stops(tgt_i, stops)
                if scheduled is None:
                    continue
                cand_routes = list(cur_routes)
                cand_routes[src_i] = []
                cand_routes[tgt_i] = scheduled[0]
                cand_rank = optimizer._rank_candidate_for_audit(cand_routes, cur_unassigned)
                if cand_rank < cur_rank:
                    direct_cands.append((cand_rank, tgt_i, cand_routes))
        if direct_cands:
            direct_cands.sort(key=lambda item: item[0])
            for cand_rank, tgt_i, cand_routes in direct_cands:
                if time.perf_counter() >= deadline:
                    break
                if optimizer._validate_stops_cached(tgt_i, cand_routes[tgt_i]):
                    cur_rank, cur_routes = cand_rank, cand_routes
                    changed = True
                    step_changed = True
                    break

        active = [idx for idx, r in enumerate(cur_routes) if r]
        profiles = {
            idx: vehicle_profile(optimizer.vehicles[idx])
            for idx in active
        }
        route_weights = {
            idx: _route_max_load(optimizer, cur_routes[idx])[0]
            for idx in active
        }
        for idx_a in range(len(active)):
            if time.perf_counter() >= deadline:
                break
            i = active[idx_a]
            vi = optimizer.vehicles[i]
            if not optimizer._vehicle_has_compatible_driver(vi):
                continue
            for idx_b in range(idx_a + 1, len(active)):
                if time.perf_counter() >= deadline:
                    break
                j = active[idx_b]
                if profiles[i] == profiles[j]:
                    continue
                vj = optimizer.vehicles[j]
                if route_weights[i] > vj.payload_limit_kg + 0.01 or route_weights[j] > vi.payload_limit_kg + 0.01:
                    continue
                if not optimizer._vehicle_has_compatible_driver(vj):
                    continue
                if not _all_orders_allow_vehicle(optimizer, cur_routes[i], vj):
                    continue
                if not _all_orders_allow_vehicle(optimizer, cur_routes[j], vi):
                    continue
                sched_i_on_j = optimizer._schedule_stops(j, cur_routes[i])
                if sched_i_on_j is None:
                    continue
                sched_j_on_i = optimizer._schedule_stops(i, cur_routes[j])
                if sched_j_on_i is None:
                    continue
                swapped = list(cur_routes)
                swapped[i] = sched_j_on_i[0]
                swapped[j] = sched_i_on_j[0]
                cand_rank = optimizer._rank_candidate_for_audit(swapped, cur_unassigned)
                if cand_rank >= cur_rank:
                    continue
                if not optimizer._validate_stops_cached(j, sched_i_on_j[0]):
                    continue
                if not optimizer._validate_stops_cached(i, sched_j_on_i[0]):
                    continue
                cur_routes, cur_rank = swapped, cand_rank
                route_weights[i], route_weights[j] = route_weights[j], route_weights[i]
                changed = True
                step_changed = True
                break
        if not step_changed:
            break

    if changed:
        cost, _, _ = optimizer._evaluate_plan_cost(cur_routes, cur_unassigned)
        return (cost, cur_routes, cur_unassigned)
    return None


def _route_order_ids(stops: Sequence[ScheduledStop]) -> List[str]:
    return list(
        dict.fromkeys(
            stop.allocation_id or stop.order_id
            for stop in stops
            if stop.order_id
        )
    )


def _route_centroid(
    optimizer: Any,
    stops: Sequence[ScheduledStop],
) -> Optional[Tuple[float, float]]:
    lat_sum = 0.0
    lon_sum = 0.0
    count = 0
    for order_id in _route_order_ids(stops):
        order = optimizer.order_by_id.get(order_id)
        if order is None:
            continue
        lat_sum += 0.5 * (order.pickup_location.latitude + order.delivery_location.latitude)
        lon_sum += 0.5 * (order.pickup_location.longitude + order.delivery_location.longitude)
        count += 1
    if count == 0:
        return None
    return (lat_sum / count, lon_sum / count)


def _route_centroid_dist2(
    c1: Optional[Tuple[float, float]],
    c2: Optional[Tuple[float, float]],
) -> float:
    if c1 is None or c2 is None:
        return 1e9
    return (c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2


def _empty_vehicle_indices(routes: Sequence[Sequence[Any]]) -> Set[int]:
    return {idx for idx, route in enumerate(routes) if not route}


def _try_pair_route_consolidation(
    optimizer: Any,
    current: List[List[ScheduledStop]],
    active_indices: Sequence[int],
    deadline: float,
) -> Optional[List[List[ScheduledStop]]]:
    """Eliminate one route by jointly rebuilding victim + nearest partner route."""
    if len(active_indices) < 2:
        return None
    centroids = {idx: _route_centroid(optimizer, current[idx]) for idx in active_indices}
    pair_specs: List[Tuple[List[List[ScheduledStop]], List[str], List[Tuple[int, Set[int]]]]] = []
    for victim_idx in active_indices[:4]:
        victim_orders = _route_order_ids(current[victim_idx])
        remaining_active = [idx for idx in active_indices if idx != victim_idx]
        partners = sorted(
            remaining_active,
            key=lambda idx: (
                0 if optimizer.vehicles[idx].service_day_index == optimizer.vehicles[victim_idx].service_day_index else 1,
                _route_centroid_dist2(centroids[victim_idx], centroids[idx]),
                len(_route_order_ids(current[idx])),
            ),
        )[:4]
        for partner_idx in partners:
            partner_orders = _route_order_ids(current[partner_idx])
            combined_orders = list(dict.fromkeys([*victim_orders, *partner_orders]))
            pair_base = copy.deepcopy(current)
            pair_base[victim_idx] = []
            pair_base[partner_idx] = []

            partner_v = optimizer.vehicles[partner_idx]
            partner_area = effective_floor_capacity_cm2(partner_v, optimizer.request.demo_stacking)
            keep_candidates: List[int] = [partner_idx]
            empty_reps = [
                idx
                for idx in representative_empty_indices(optimizer, pair_base)
                if idx != victim_idx
                and idx != partner_idx
                and optimizer._vehicle_has_compatible_driver(optimizer.vehicles[idx])
            ]
            upgrade_slots = [
                idx
                for idx in empty_reps
                if (
                    optimizer.vehicles[idx].payload_limit_kg > partner_v.payload_limit_kg + 1.0
                    or effective_floor_capacity_cm2(optimizer.vehicles[idx], optimizer.request.demo_stacking)
                    > partner_area + 1.0
                    or optimizer.vehicles[idx].service_day_index < partner_v.service_day_index
                )
            ]
            upgrade_slots.sort(
                key=lambda idx: (
                    0 if optimizer.vehicles[idx].service_day_index == partner_v.service_day_index else 1,
                    -optimizer.vehicles[idx].payload_limit_kg,
                    -effective_floor_capacity_cm2(optimizer.vehicles[idx], optimizer.request.demo_stacking),
                )
            )
            keep_candidates.extend(upgrade_slots[:2])
            pair_base_empty = _empty_vehicle_indices(pair_base)
            valid_keeps: List[Tuple[int, Set[int]]] = []
            for keep_slot in keep_candidates:
                keep_v = optimizer.vehicles[keep_slot]
                if (
                    keep_v.service_day_index != partner_v.service_day_index
                    and not _max_routes_allows_day(
                        optimizer, pair_base, keep_v.service_day_index, excluding_index=partner_idx
                    )
                ):
                    continue
                valid_keeps.append((keep_slot, pair_base_empty - {keep_slot}))
            if valid_keeps:
                pair_specs.append((pair_base, combined_orders, valid_keeps))

    # Try regret3 across all (victim, partner) pairs before regret2 so broad coverage runs first.
    for repair_op in ("regret3", "regret2"):
        for pair_base, combined_orders, valid_keeps in pair_specs:
            if time.perf_counter() >= deadline:
                return None
            for _, excluded in valid_keeps:
                if time.perf_counter() >= deadline:
                    return None
                cand_routes, failed = optimizer._repair(
                    copy.deepcopy(pair_base),
                    combined_orders,
                    repair_op,
                    deadline,
                    excluded_vehicle_indices=excluded,
                )
                if not failed:
                    return cand_routes
    return None


def _try_multi_route_ripple_consolidation(
    optimizer: Any,
    current: List[List[ScheduledStop]],
    active_indices: Sequence[int],
    deadline: float,
) -> Optional[List[List[ScheduledStop]]]:
    """Eliminate a victim route by re-routing edge orders across remaining routes."""
    if len(active_indices) < 3:
        return None
    edge_k = max(2, round(len(optimizer.orders) * 0.30))
    destroy_ops = (optimizer._destroy_related, optimizer._destroy_worst)
    ripple_plans: List[Tuple[List[List[ScheduledStop]], List[str], Set[int]]] = []
    for victim_idx in active_indices[:3]:
        victim_orders = _route_order_ids(current[victim_idx])
        base = copy.deepcopy(current)
        base[victim_idx] = []
        forbidden_empty = _empty_vehicle_indices(base)
        for destroy_fn in destroy_ops:
            destroyed, extra_removed = destroy_fn(copy.deepcopy(base), edge_k)
            pool = list(dict.fromkeys([*victim_orders, *extra_removed]))
            if pool:
                ripple_plans.append((destroyed, pool, forbidden_empty))
    for repair_op in ("regret3", "regret2"):
        for destroyed, pool, forbidden_empty in ripple_plans:
            if time.perf_counter() >= deadline:
                return None
            cand_routes, failed = optimizer._repair(
                copy.deepcopy(destroyed),
                pool,
                repair_op,
                deadline,
                excluded_vehicle_indices=forbidden_empty,
            )
            if not failed:
                return cand_routes
    return None


def _slot_set_respects_policy(
    optimizer: Any,
    slots: Sequence[int],
) -> bool:
    """Verify slot subset respects driver compatibility and max_routes_per_day."""
    max_routes = getattr(optimizer.request.policy, "max_routes_per_day", None)
    day_counts: Dict[int, int] = {}
    seen_phys_day: Set[Tuple[str, int]] = set()
    for s_idx in slots:
        v = optimizer.vehicles[s_idx]
        if not optimizer._vehicle_has_compatible_driver(v):
            return False
        phys_day = (v.source_vehicle_id or v.id, v.service_day_index)
        if phys_day in seen_phys_day:
            return False
        seen_phys_day.add(phys_day)
        day_counts[v.service_day_index] = day_counts.get(v.service_day_index, 0) + 1
    if max_routes is not None and any(cnt > max_routes for cnt in day_counts.values()):
        return False
    return True


def _is_pure_empty_cycles(stops: Sequence[ScheduledStop]) -> Optional[List[str]]:
    if len(stops) % 2 != 0:
        return None
    cyc: List[str] = []
    for idx in range(0, len(stops), 2):
        p_s, d_s = stops[idx], stops[idx + 1]
        p_id = p_s.allocation_id or p_s.order_id
        d_id = d_s.allocation_id or d_s.order_id
        if p_s.stop_type != "PICKUP" or d_s.stop_type != "DELIVERY" or not p_id or p_id != d_id:
            return None
        cyc.append(p_id)
    return cyc


def _can_chain_empty_cycles(
    optimizer: Any,
    order_ids: Sequence[str],
    target_k: int,
) -> bool:
    """Return True unless wall-clock time windows prove k-1 [P, D] chains impossible."""
    n = len(order_ids)
    if n <= target_k:
        return True
    stop_templates = getattr(optimizer, "_stop_templates_by_order_id", None)
    order_node_indices = getattr(optimizer, "order_node_indices", None)
    dur_matrix = getattr(optimizer.request, "duration_matrix_seconds", None)
    if not stop_templates or dur_matrix is None:
        return True

    bounds: List[Tuple[int, int, float, int]] = []
    for oid in order_ids:
        order = optimizer.order_by_id.get(oid)
        tmpl = stop_templates.get(oid)
        if (
            order is None
            or order.split_group_id
            or tmpl is None
            or len(tmpl) != 2
            or (tmpl[0].stop_type, tmpl[1].stop_type) != ("PICKUP", "DELIVERY")
        ):
            return True
        if order_node_indices is not None and oid in order_node_indices:
            p_node, d_node = order_node_indices[oid]
        else:
            p_node = optimizer._stop_node_index(tmpl[0])
            d_node = optimizer._stop_node_index(tmpl[1])
            if p_node is None or d_node is None:
                return True
        earliest_d_start = max(
            float(order.delivery_window_start_sec),
            float(order.pickup_window_start_sec)
            + float(order.service_seconds("PICKUP"))
            + float(dur_matrix[p_node][d_node]),
        )
        earliest_d_finish = earliest_d_start + float(order.service_seconds("DELIVERY"))
        bounds.append((p_node, d_node, earliest_d_finish, int(order.pickup_window_end_sec)))

    followers = 0
    needed_followers = n - target_k
    for b_idx, (p_b, _, _, p_end_b) in enumerate(bounds):
        limit_b = float(p_end_b) + 2.0
        for a_idx, (_, d_a, fin_a, _) in enumerate(bounds):
            if a_idx != b_idx and fin_a + float(dur_matrix[d_a][p_b]) <= limit_b:
                followers += 1
                break
    return followers >= needed_followers


def _try_empty_cycle_consolidation(
    optimizer: Any,
    current: List[List[ScheduledStop]],
    active_indices: Sequence[int],
    deadline: float,
) -> Optional[List[List[ScheduledStop]]]:
    """Consolidate routes cleanly using empty-load [P, D] cycles across k-1 vehicles."""
    if len(active_indices) < 2 or time.perf_counter() + 0.06 >= deadline:
        return None

    expected_order_ids = list(
        dict.fromkeys(
            oid
            for idx in active_indices
            for oid in _route_order_ids(current[idx])
        )
    )
    if not expected_order_ids:
        return None
    if not _can_chain_empty_cycles(optimizer, expected_order_ids, len(active_indices) - 1):
        return None

    # 3a) Fast pairwise empty-load cycle merge on existing active routes.
    if hasattr(optimizer, "_refine_pairwise_empty_cycles"):
        rem_pair = deadline - time.perf_counter()
        pair_deadline = min(deadline, time.perf_counter() + rem_pair * 0.25)
        pairwise = optimizer._refine_pairwise_empty_cycles(copy.deepcopy(current), pair_deadline)
        if pairwise:
            active_pair = [r for r in pairwise if r]
            if len(active_pair) < len(active_indices):
                pair_orders = {
                    oid for r in active_pair for oid in _route_order_ids(r)
                }
                if len(pair_orders) == len(expected_order_ids):
                    return pairwise

    # 3b) Global k -> k-1 multi-bin empty-load cycle packing across heterogeneous slots.
    if len(active_indices) < 3 or time.perf_counter() + 0.08 >= deadline:
        return None
    stop_templates = getattr(optimizer, "_stop_templates_by_order_id", None)
    if not stop_templates:
        return None

    order_meta: Dict[str, Tuple[OrderPair, ScheduledStop, ScheduledStop, int, int, float, float, float]] = {}
    order_area_by_id: Dict[str, float] = {}
    order_node_indices = getattr(optimizer, "order_node_indices", None)
    for oid in expected_order_ids:
        order = optimizer.order_by_id.get(oid)
        tmpl = stop_templates.get(oid)
        if (
            order is None
            or order.split_group_id
            or tmpl is None
            or len(tmpl) != 2
            or (tmpl[0].stop_type, tmpl[1].stop_type) != ("PICKUP", "DELIVERY")
        ):
            return None
        if order_node_indices is not None and oid in order_node_indices:
            p_node, d_node = order_node_indices[oid]
        else:
            p_node = optimizer._stop_node_index(tmpl[0])
            d_node = optimizer._stop_node_index(tmpl[1])
            if p_node is None or d_node is None:
                return None
        area = float(sum(it.length_cm * it.width_cm for it in order.items))
        vol = float(sum(it.length_cm * it.width_cm * it.height_cm for it in order.items))
        max_dim = float(
            max((max(it.length_cm, it.width_cm, it.height_cm) for it in order.items), default=0.0)
        )
        order_area_by_id[oid] = area
        order_meta[oid] = (
            order, tmpl[0], tmpl[1], p_node, d_node, float(order.total_weight_kg), vol, max_dim
        )

    dist_matrix = optimizer.request.distance_matrix_meters
    use_fast_sched = hasattr(optimizer, "_can_schedule_stops")

    def _can_sched(v_idx: int, stops: List[ScheduledStop]) -> bool:
        if use_fast_sched:
            return bool(optimizer._can_schedule_stops(v_idx, stops))
        return optimizer._schedule_stops(v_idx, stops) is not None

    single_spatial_cache: Dict[Tuple[Tuple[Any, ...], str], bool] = {}

    def _geom_key(v: Any) -> Tuple[Any, ...]:
        return (
            v.length_cm,
            v.width_cm,
            v.height_cm,
            round(v.payload_limit_kg, 3),
            v.door_position,
            v.door_width_cm,
            v.vehicle_type,
        )

    def _order_fits_slot_single(v_idx: int, oid: str) -> bool:
        v = optimizer.vehicles[v_idx]
        order, p_stop, d_stop, _, _, _, _, _ = order_meta[oid]
        if not optimizer._order_allows_vehicle(order, v):
            return False
        if not optimizer._vehicle_has_compatible_driver(v):
            return False
        g_key = (_geom_key(v), oid)
        cached = single_spatial_cache.get(g_key)
        if cached is not None:
            return cached
        cycle = [p_stop, d_stop]
        ok = _can_sched(v_idx, cycle) and bool(optimizer._validate_stops_cached(v_idx, cycle))
        single_spatial_cache[g_key] = ok
        return ok

    target_k = len(active_indices) - 1
    slot_candidates: List[Tuple[Tuple[int, ...], Optional[int]]] = []
    seen_slot_tuples: Set[Tuple[int, ...]] = set()

    def _add_slot_set(raw_slots: Sequence[int], victim_idx: Optional[int]) -> None:
        sorted_key = tuple(sorted(raw_slots))
        if len(sorted_key) != target_k or sorted_key in seen_slot_tuples:
            return
        if not _slot_set_respects_policy(optimizer, sorted_key):
            return
        seen_slot_tuples.add(sorted_key)
        slot_candidates.append((tuple(raw_slots), victim_idx))

    # S1 (singleton physical vehicles): drop routes that free a physical vehicle first.
    active_phys_counts: Dict[str, int] = {}
    for idx in active_indices:
        p_id = optimizer.vehicles[idx].source_vehicle_id or optimizer.vehicles[idx].id
        active_phys_counts[p_id] = active_phys_counts.get(p_id, 0) + 1
    s1_singleton = [
        idx
        for idx in active_indices
        if active_phys_counts[optimizer.vehicles[idx].source_vehicle_id or optimizer.vehicles[idx].id] == 1
    ]
    s1_other = [
        idx
        for idx in active_indices
        if active_phys_counts[optimizer.vehicles[idx].source_vehicle_id or optimizer.vehicles[idx].id] != 1
    ]
    for victim_idx in s1_singleton:
        kept = [idx for idx in active_indices if idx != victim_idx]
        _add_slot_set(kept, victim_idx)

    # S_min_phys: minimize distinct physical vehicles across active days (drops driver fixed wages).
    demo_stacking = optimizer.request.demo_stacking
    active_days = {optimizer.vehicles[i].service_day_index for i in active_indices}
    all_compat = [
        idx
        for idx, v in enumerate(optimizer.vehicles)
        if optimizer._vehicle_has_compatible_driver(v)
    ]
    compat_by_phys: Dict[str, List[int]] = {}
    for idx in all_compat:
        p_id = optimizer.vehicles[idx].source_vehicle_id or optimizer.vehicles[idx].id
        compat_by_phys.setdefault(p_id, []).append(idx)
    max_routes = getattr(optimizer.request.policy, "max_routes_per_day", None)
    for active_days_only in (True, False):
        for floor_first in (False, True):
            phys_rank = sorted(
                compat_by_phys.values(),
                key=lambda idxs: (
                    -len({
                        optimizer.vehicles[i].service_day_index
                        for i in idxs
                        if (not active_days_only or optimizer.vehicles[i].service_day_index in active_days)
                    }),
                    -(
                        max(effective_floor_capacity_cm2(optimizer.vehicles[i], demo_stacking) for i in idxs)
                        if floor_first
                        else max(optimizer.vehicles[i].payload_limit_kg for i in idxs)
                    ),
                    -(
                        max(optimizer.vehicles[i].payload_limit_kg for i in idxs)
                        if floor_first
                        else max(effective_floor_capacity_cm2(optimizer.vehicles[i], demo_stacking) for i in idxs)
                    ),
                    min(optimizer.vehicles[i].fixed_operating_cost_vnd for i in idxs),
                ),
            )
            picked_phys: List[int] = []
            used_phys_day: Set[Tuple[str, int]] = set()
            day_counts: Dict[int, int] = {}
            for idxs in phys_rank:
                sorted_days = sorted(
                    idxs,
                    key=lambda i: (
                        0 if optimizer.vehicles[i].service_day_index in active_days else 1,
                        optimizer.vehicles[i].service_day_index,
                        -optimizer.vehicles[i].payload_limit_kg,
                        -effective_floor_capacity_cm2(optimizer.vehicles[i], demo_stacking),
                        optimizer.vehicles[i].fixed_operating_cost_vnd,
                    ),
                )
                for idx in sorted_days:
                    v = optimizer.vehicles[idx]
                    if active_days_only and v.service_day_index not in active_days:
                        continue
                    pd_key = (v.source_vehicle_id or v.id, v.service_day_index)
                    if pd_key in used_phys_day:
                        continue
                    if max_routes is not None and day_counts.get(v.service_day_index, 0) >= max_routes:
                        continue
                    picked_phys.append(idx)
                    used_phys_day.add(pd_key)
                    day_counts[v.service_day_index] = day_counts.get(v.service_day_index, 0) + 1
                    if len(picked_phys) == target_k:
                        break
                if len(picked_phys) == target_k:
                    break
            if len(picked_phys) == target_k:
                _add_slot_set(picked_phys, None)

    # S1 (remaining): drop non-singleton routes after testing minimum-physical-vehicle sets.
    for victim_idx in s1_other:
        kept = [idx for idx in active_indices if idx != victim_idx]
        _add_slot_set(kept, victim_idx)

    # S2: upgrade weakest kept slot on top S1 sets using idle stronger/earlier representatives.
    for base_slots, victim_idx in list(slot_candidates[:3]):
        base_set = set(base_slots)
        trial_board: List[List[ScheduledStop]] = [[] for _ in range(len(optimizer.vehicles))]
        for idx in base_slots:
            trial_board[idx] = current[idx] or [order_meta[expected_order_ids[0]][1]]
        empty_reps = [
            idx
            for idx in representative_empty_indices(optimizer, trial_board)
            if idx not in base_set and optimizer._vehicle_has_compatible_driver(optimizer.vehicles[idx])
        ]
        if not empty_reps:
            continue
        weakest_slot = min(
            base_slots,
            key=lambda idx: (
                optimizer.vehicles[idx].payload_limit_kg,
                effective_floor_capacity_cm2(optimizer.vehicles[idx], demo_stacking),
                -optimizer.vehicles[idx].service_day_index,
            ),
        )
        weak_v = optimizer.vehicles[weakest_slot]
        weak_area = effective_floor_capacity_cm2(weak_v, demo_stacking)
        upgrades = sorted(
            (
                idx
                for idx in empty_reps
                if (
                    optimizer.vehicles[idx].payload_limit_kg > weak_v.payload_limit_kg + 1.0
                    or effective_floor_capacity_cm2(optimizer.vehicles[idx], demo_stacking) > weak_area + 1.0
                    or optimizer.vehicles[idx].service_day_index < weak_v.service_day_index
                )
            ),
            key=lambda idx: (
                0 if optimizer.vehicles[idx].service_day_index <= weak_v.service_day_index else 1,
                -optimizer.vehicles[idx].payload_limit_kg,
                -effective_floor_capacity_cm2(optimizer.vehicles[idx], demo_stacking),
                optimizer.vehicles[idx].fixed_operating_cost_vnd,
            ),
        )
        for up_idx in upgrades[:2]:
            upgraded_slots = [up_idx if idx == weakest_slot else idx for idx in base_slots]
            _add_slot_set(upgraded_slots, victim_idx)

    # S3: globally strongest compatible target_k fleet slots across all available vehicles.
    for day_first in (True, False):
        ordered_pool = sorted(
            all_compat,
            key=lambda idx: (
                optimizer.vehicles[idx].service_day_index if day_first else 0,
                -optimizer.vehicles[idx].payload_limit_kg,
                -effective_floor_capacity_cm2(optimizer.vehicles[idx], demo_stacking),
                optimizer.vehicles[idx].service_day_index,
                optimizer.vehicles[idx].fixed_operating_cost_vnd,
            ),
        )
        picked: List[int] = []
        used_phys_day_s3: Set[Tuple[str, int]] = set()
        day_counts_s3: Dict[int, int] = {}
        for idx in ordered_pool:
            v = optimizer.vehicles[idx]
            pd_key = (v.source_vehicle_id or v.id, v.service_day_index)
            if pd_key in used_phys_day_s3:
                continue
            if max_routes is not None and day_counts_s3.get(v.service_day_index, 0) >= max_routes:
                continue
            picked.append(idx)
            used_phys_day_s3.add(pd_key)
            day_counts_s3[v.service_day_index] = day_counts_s3.get(v.service_day_index, 0) + 1
            if len(picked) == target_k:
                break
        if len(picked) == target_k:
            _add_slot_set(picked, None)

    def _pack_cycle_bins(
        slots: Sequence[int],
        init_stops_map: Dict[int, List[ScheduledStop]],
        remaining_oids: Sequence[str],
        *,
        allow_joint_coload: bool = False,
        use_regret2: bool = False,
    ) -> Optional[List[List[ScheduledStop]]]:
        stops_by_slot: Dict[int, List[ScheduledStop]] = {}
        for s_idx in slots:
            raw = list(init_stops_map.get(s_idx, ()))
            if raw and not (
                _can_sched(s_idx, raw) and optimizer._validate_stops_cached(s_idx, raw)
            ):
                return None
            stops_by_slot[s_idx] = raw

        def _stop_node_idx(stop: ScheduledStop) -> int:
            oid_s = stop.allocation_id or stop.order_id or ""
            meta = order_meta[oid_s]
            return meta[3] if stop.stop_type == "PICKUP" else meta[4]

        def _zero_load_split_positions(cur_stops: Sequence[ScheduledStop]) -> List[int]:
            positions = [0]
            depth = 0
            for st_idx, st in enumerate(cur_stops):
                depth += 1 if st.stop_type == "PICKUP" else -1
                if depth == 0:
                    positions.append(st_idx + 1)
            return positions

        def _best_pos_for_slot(
            s_idx: int, cur_stops: List[ScheduledStop], oid: str
        ) -> Optional[Tuple[int, List[ScheduledStop]]]:
            if not _order_fits_slot_single(s_idx, oid):
                return None
            _, p_stop, d_stop, p_node, d_node, _, _, _ = order_meta[oid]
            scored_pos: List[Tuple[int, int]] = []
            n_stops = len(cur_stops)
            for pos in _zero_load_split_positions(cur_stops):
                prev_n = s_idx if pos == 0 else _stop_node_idx(cur_stops[pos - 1])
                next_n = s_idx if pos == n_stops else _stop_node_idx(cur_stops[pos])
                delta_m = (
                    dist_matrix[prev_n][p_node]
                    + dist_matrix[p_node][d_node]
                    + dist_matrix[d_node][next_n]
                    - dist_matrix[prev_n][next_n]
                )
                scored_pos.append((delta_m, pos))
            scored_pos.sort(key=lambda item: item[0])
            for delta_m, pos in scored_pos:
                cand_stops = cur_stops[:pos] + [p_stop, d_stop] + cur_stops[pos:]
                if _can_sched(s_idx, cand_stops) and optimizer._validate_stops_cached(
                    s_idx, cand_stops
                ):
                    return (delta_m, cand_stops)
            return None

        def _best_coload_pos_for_slot(
            s_idx: int, cur_stops: List[ScheduledStop], oid: str
        ) -> Optional[Tuple[int, List[ScheduledStop]]]:
            if not cur_stops or not _order_fits_slot_single(s_idx, oid):
                return None
            _, p_stop, d_stop, p_node, d_node, w_oid, vol_oid, _ = order_meta[oid]
            area_oid = order_area_by_id[oid]
            v = optimizer.vehicles[s_idx]
            payload_lim = float(v.payload_limit_kg) + 1e-6
            stacking_on = bool(demo_stacking and getattr(demo_stacking, "enabled", False))
            area_lim = (
                effective_floor_capacity_cm2(v, demo_stacking) + 1.0
                if not stacking_on
                else float("inf")
            )
            vol_lim = (
                float(v.length_cm) * float(v.width_cm) * float(v.height_cm) + 1.0
                if stacking_on
                else float("inf")
            )
            n_stops = len(cur_stops)
            nodes = [_stop_node_idx(st) for st in cur_stops]
            depth_before = [0] * (n_stops + 1)
            w_at = [0.0] * (n_stops + 1)
            area_at = [0.0] * (n_stops + 1)
            vol_at = [0.0] * (n_stops + 1)
            cur_d = 0
            cur_w = cur_a = cur_v = 0.0
            for idx_st, st in enumerate(cur_stops):
                oid_s = st.allocation_id or st.order_id or ""
                sign = 1 if st.stop_type == "PICKUP" else -1
                cur_d += sign
                cur_w += sign * order_meta[oid_s][5]
                cur_v += sign * order_meta[oid_s][6]
                cur_a += sign * order_area_by_id[oid_s]
                depth_before[idx_st + 1] = cur_d
                w_at[idx_st + 1] = cur_w
                area_at[idx_st + 1] = cur_a
                vol_at[idx_st + 1] = cur_v

            scored: List[Tuple[int, int, int, int]] = []
            for p in range(n_stops + 1):
                if w_at[p] + w_oid > payload_lim:
                    continue
                if area_at[p] + area_oid > area_lim or vol_at[p] + vol_oid > vol_lim:
                    continue
                dp = depth_before[p]
                for q in range(p, n_stops + 1):
                    if q > p:
                        if w_at[q] + w_oid > payload_lim:
                            break
                        if area_at[q] + area_oid > area_lim or vol_at[q] + vol_oid > vol_lim:
                            break
                    elif dp == 0:
                        continue

                    strict_lifo = (dp == depth_before[q]) and all(
                        depth_before[k] >= dp for k in range(p + 1, q)
                    )
                    if not strict_lifo and (q - p) > 2:
                        continue

                    prev_p = s_idx if p == 0 else nodes[p - 1]
                    next_p = s_idx if p == n_stops else nodes[p]
                    if p == q:
                        delta_m = (
                            dist_matrix[prev_p][p_node]
                            + dist_matrix[p_node][d_node]
                            + dist_matrix[d_node][next_p]
                            - dist_matrix[prev_p][next_p]
                        )
                    else:
                        prev_q = nodes[q - 1]
                        next_q = s_idx if q == n_stops else nodes[q]
                        delta_m = (
                            dist_matrix[prev_p][p_node]
                            + dist_matrix[p_node][next_p]
                            - dist_matrix[prev_p][next_p]
                            + dist_matrix[prev_q][d_node]
                            + dist_matrix[d_node][next_q]
                            - dist_matrix[prev_q][next_q]
                        )
                    scored.append((0 if strict_lifo else 1, delta_m, p, q))

            scored.sort(key=lambda item: (item[0], item[1]))
            for _, delta_m, p, q in scored[:16]:
                if time.perf_counter() >= deadline:
                    return None
                cand_stops = (
                    cur_stops[:p] + [p_stop] + cur_stops[p:q] + [d_stop] + cur_stops[q:]
                )
                if _can_sched(s_idx, cand_stops) and optimizer._validate_stops_cached(
                    s_idx, cand_stops
                ):
                    return (delta_m, cand_stops)
            return None

        def _best_fit_for_slot(
            s_idx: int, cur_stops: List[ScheduledStop], oid: str, allow_coload: bool
        ) -> Optional[Tuple[int, List[ScheduledStop]]]:
            empty_fit = _best_pos_for_slot(s_idx, cur_stops, oid)
            if not allow_coload:
                return empty_fit
            coload_fit = _best_coload_pos_for_slot(s_idx, cur_stops, oid)
            if empty_fit is None:
                return coload_fit
            if coload_fit is None or empty_fit[0] <= coload_fit[0]:
                return empty_fit
            return coload_fit

        def _try_insert_best(oid: str, try_coload: bool, joint: bool = False) -> bool:
            best_choice: Optional[Tuple[Tuple[int, int, float], int, List[ScheduledStop]]] = None
            for s_idx in slots:
                if time.perf_counter() >= deadline:
                    return False
                if joint:
                    fitted = _best_fit_for_slot(s_idx, stops_by_slot[s_idx], oid, allow_coload=True)
                elif try_coload:
                    fitted = _best_coload_pos_for_slot(s_idx, stops_by_slot[s_idx], oid)
                else:
                    fitted = _best_pos_for_slot(s_idx, stops_by_slot[s_idx], oid)
                if fitted is None:
                    continue
                delta_m, cand_stops = fitted
                v = optimizer.vehicles[s_idx]
                rank_key = (
                    delta_m,
                    0 if stops_by_slot[s_idx] else 1,
                    float(v.fixed_operating_cost_vnd),
                )
                if best_choice is None or rank_key < best_choice[0]:
                    best_choice = (rank_key, s_idx, cand_stops)
            if best_choice is not None:
                stops_by_slot[best_choice[1]] = best_choice[2]
                return True
            return False

        def _try_eject_relocate(oid: str, allow_coload: bool) -> Optional[Tuple[int, int]]:
            for s_idx in slots:
                if time.perf_counter() >= deadline:
                    return None
                if not _order_fits_slot_single(s_idx, oid):
                    continue
                cur_stops = stops_by_slot[s_idx]
                route_oids = _route_order_ids(cur_stops)
                for ej_oid in reversed(route_oids):
                    red_stops = [
                        st for st in cur_stops if (st.allocation_id or st.order_id) != ej_oid
                    ]
                    ins_main = _best_fit_for_slot(s_idx, red_stops, oid, allow_coload)
                    if ins_main is None:
                        continue
                    for other_slot in slots:
                        if other_slot == s_idx:
                            continue
                        ins_ej = _best_fit_for_slot(other_slot, stops_by_slot[other_slot], ej_oid, allow_coload)
                        if ins_ej is not None:
                            stops_by_slot[s_idx] = ins_main[1]
                            stops_by_slot[other_slot] = ins_ej[1]
                            return (s_idx, other_slot)
            return None

        if use_regret2:
            pending = list(remaining_oids)
            fit_cache: Dict[Tuple[str, int], Optional[Tuple[int, List[ScheduledStop]]]] = {}
            while pending:
                if time.perf_counter() >= deadline:
                    return None
                best_oid_pick: Optional[
                    Tuple[Tuple[int, int, int], str, Optional[int], Optional[List[ScheduledStop]]]
                ] = None
                for oid in pending:
                    if time.perf_counter() >= deadline:
                        return None
                    slot_fits: List[Tuple[Tuple[int, int, float], int, List[ScheduledStop]]] = []
                    for s_idx in slots:
                        fkey = (oid, s_idx)
                        if fkey not in fit_cache:
                            fit_cache[fkey] = _best_fit_for_slot(
                                s_idx, stops_by_slot[s_idx], oid, allow_joint_coload
                            )
                        res = fit_cache[fkey]
                        if res is not None:
                            v = optimizer.vehicles[s_idx]
                            r_key = (
                                res[0],
                                0 if stops_by_slot[s_idx] else 1,
                                float(v.fixed_operating_cost_vnd),
                            )
                            slot_fits.append((r_key, s_idx, res[1]))
                    if not slot_fits:
                        pick_key = (0, 0, 0)
                        cand_item = (pick_key, oid, None, None)
                        if best_oid_pick is None or pick_key < best_oid_pick[0]:
                            best_oid_pick = cand_item
                        break
                    slot_fits.sort(key=lambda item: item[0])
                    best_d = slot_fits[0][0][0]
                    if len(slot_fits) == 1:
                        pick_key = (1, 0, best_d)
                    else:
                        regret = slot_fits[1][0][0] - best_d
                        pick_key = (2, -regret, best_d)
                    if best_oid_pick is None or pick_key < best_oid_pick[0]:
                        best_oid_pick = (pick_key, oid, slot_fits[0][1], slot_fits[0][2])
                assert best_oid_pick is not None
                _, chosen_oid, chosen_slot, chosen_stops = best_oid_pick
                if chosen_slot is not None and chosen_stops is not None:
                    stops_by_slot[chosen_slot] = chosen_stops
                    pending.remove(chosen_oid)
                    for k in [k for k in fit_cache if k[1] == chosen_slot]:
                        del fit_cache[k]
                    continue
                reloc_pair = _try_eject_relocate(chosen_oid, allow_coload=allow_joint_coload)
                if reloc_pair is None:
                    return None
                pending.remove(chosen_oid)
                s_a, s_b = reloc_pair
                for k in [k for k in fit_cache if k[1] in (s_a, s_b)]:
                    del fit_cache[k]
        else:
            for oid in remaining_oids:
                if time.perf_counter() >= deadline:
                    return None
                if allow_joint_coload:
                    if _try_insert_best(oid, try_coload=False, joint=True):
                        continue
                    if _try_eject_relocate(oid, allow_coload=True) is not None:
                        continue
                    return None
                if _try_insert_best(oid, try_coload=False):
                    continue
                if _try_eject_relocate(oid, allow_coload=False) is not None:
                    continue
                if _try_insert_best(oid, try_coload=True):
                    continue
                if _try_eject_relocate(oid, allow_coload=True) is not None:
                    continue
                return None

        cand_routes: List[List[ScheduledStop]] = [[] for _ in range(len(optimizer.vehicles))]
        for s_idx in slots:
            raw = stops_by_slot[s_idx]
            if not raw:
                continue
            scheduled = optimizer._schedule_stops(s_idx, raw)
            if scheduled is None or not optimizer._validate_stops_cached(s_idx, scheduled[0]):
                return None
            cand_routes[s_idx] = scheduled[0]
        if sum(bool(r) for r in cand_routes) >= len(active_indices):
            return None
        return cand_routes

    ffd_order = sorted(
        expected_order_ids,
        key=lambda oid: (-order_meta[oid][5], -order_meta[oid][6], -order_meta[oid][7], order_meta[oid][0].delivery_window_end_sec),
    )
    geo_win_order = sorted(
        expected_order_ids,
        key=lambda oid: (
            order_meta[oid][0].delivery_window_end_sec,
            order_meta[oid][0].pickup_location.latitude,
            order_meta[oid][0].pickup_location.longitude,
        ),
    )

    repair_slot_fallback: List[Tuple[Tuple[int, ...], Sequence[str]]] = []
    for slots, victim_idx in slot_candidates[: min(len(slot_candidates), 16)]:
        if time.perf_counter() >= deadline:
            break
        elig_counts = {
            oid: sum(1 for s_idx in slots if _order_fits_slot_single(s_idx, oid))
            for oid in expected_order_ids
        }
        if any(cnt == 0 for cnt in elig_counts.values()):
            continue

        warm_init: Optional[Dict[int, List[ScheduledStop]]] = None
        warm_oids: List[str] = []
        if victim_idx is not None and all(s_idx != victim_idx for s_idx in slots):
            kept_map: Dict[int, List[ScheduledStop]] = {s_idx: list(current[s_idx]) for s_idx in slots}
            kept_oid_set = {oid for r in kept_map.values() for oid in _route_order_ids(r)}
            missing_warm = [oid for oid in expected_order_ids if oid not in kept_oid_set]
            if len(kept_oid_set) + len(missing_warm) == len(expected_order_ids):
                warm_init = kept_map
                warm_oids = sorted(
                    missing_warm,
                    key=lambda oid: (
                        -order_meta[oid][5],
                        -order_meta[oid][6],
                        order_meta[oid][0].delivery_window_end_sec,
                    ),
                )

        constrained_order = sorted(
            expected_order_ids,
            key=lambda oid: (elig_counts[oid], -order_meta[oid][5], -order_meta[oid][6]),
        )
        repair_slot_fallback.append((slots, constrained_order))

        strategies: List[Tuple[Dict[int, List[ScheduledStop]], Sequence[str], bool, bool]] = []
        if warm_init is not None and all(
            _is_pure_empty_cycles(r) is not None for r in warm_init.values()
        ):
            strategies.append((warm_init, warm_oids, False, False))
        strategies.append(({}, ffd_order, False, False))
        strategies.append(({}, constrained_order, False, False))
        strategies.append(({}, geo_win_order, False, False))
        if warm_init is not None:
            strategies.append((warm_init, warm_oids, True, True))
            strategies.append((warm_init, warm_oids, True, False))
        strategies.append(({}, constrained_order, True, True))
        strategies.append(({}, geo_win_order, True, False))
        strategies.append(({}, ffd_order, True, False))

        for init_map, rem_oids, joint_coload, regret2_flag in strategies:
            if time.perf_counter() >= deadline:
                break
            packed = _pack_cycle_bins(
                slots,
                init_map,
                rem_oids,
                allow_joint_coload=joint_coload,
                use_regret2=regret2_flag,
            )
            if packed is not None:
                return packed

    # Final fallback: run full PackingAware regret2/regret3 restricted strictly to top feasible k-1 slots
    # (prioritizing fewest distinct physical vehicles to drop extra driver fixed wages).
    repair_slot_fallback.sort(
        key=lambda item: len({
            optimizer.vehicles[s].source_vehicle_id or optimizer.vehicles[s].id
            for s in item[0]
        })
    )
    all_v_indices = set(range(len(optimizer.vehicles)))
    empty_board: List[List[ScheduledStop]] = [[] for _ in range(len(optimizer.vehicles))]
    for slots, ordered_oids in repair_slot_fallback[:3]:
        rem_t = deadline - time.perf_counter()
        if rem_t <= 0.12:
            break
        excluded = sorted(all_v_indices - set(slots))
        sub_dl = min(deadline, time.perf_counter() + min(0.85, rem_t * 0.55))
        for op in ("regret2", "regret3"):
            if time.perf_counter() + 0.05 >= sub_dl:
                break
            repaired, failed = optimizer._repair(
                copy.deepcopy(empty_board),
                list(ordered_oids),
                op,
                sub_dl,
                excluded_vehicle_indices=excluded,
            )
            if not failed and sum(bool(r) for r in repaired) < len(active_indices):
                return repaired
    return None


def _item_floor_orientations(
    item: Any, demo_stacking: Any
) -> List[Tuple[float, float]]:
    allowed = getattr(item, "allowed_orientations", None)
    if allowed is not None:
        out: List[Tuple[float, float]] = []
        for ori in allowed:
            dims = (
                (float(item.length_cm), float(item.width_cm))
                if ori == "LWH"
                else (float(item.width_cm), float(item.length_cm))
            )
            if dims not in out:
                out.append(dims)
        return out
    d11 = True if demo_stacking is None else None
    base = (float(item.length_cm), float(item.width_cm))
    if resolve_can_rotate(item, d11_default=d11) and abs(base[0] - base[1]) > 0.1:
        return [base, (base[1], base[0])]
    return [base]


def _min_route_clique_lower_bound(optimizer: Any) -> int:
    """Return a sound minimum active-route lower bound from time+packing conflicts."""
    orders = [o for o in getattr(optimizer, "orders", ()) if not o.split_group_id]
    if len(orders) <= 1:
        return 1 if getattr(optimizer, "orders", None) else 0
    order_nodes = getattr(optimizer, "order_node_indices", None)
    dur_matrix = getattr(optimizer.request, "duration_matrix_seconds", None)
    if not order_nodes or not dur_matrix:
        return 1

    demo_stacking = getattr(optimizer.request, "demo_stacking", None)
    stacking_on = bool(demo_stacking and getattr(demo_stacking, "enabled", True))
    compat_vehicles = [
        (vi, v)
        for vi, v in enumerate(optimizer.vehicles)
        if optimizer._vehicle_has_compatible_driver(v)
    ]
    if not compat_vehicles:
        return 1

    earliest_d: Dict[str, float] = {}
    p_nodes: Dict[str, int] = {}
    d_nodes: Dict[str, int] = {}
    floor_items_by_oid: Dict[str, List[Any]] = {}
    floor_area_by_oid: Dict[str, float] = {}
    max_h_by_oid: Dict[str, float] = {}

    for o in orders:
        nodes = order_nodes.get(o.id)
        if not nodes:
            continue
        p_n, d_n = nodes
        min_p = min(
            (
                float(v.available_start_sec) + float(dur_matrix[vi][p_n])
                for vi, v in compat_vehicles
                if optimizer._order_allows_vehicle(o, v)
            ),
            default=None,
        )
        if min_p is None:
            continue
        ep = max(min_p, float(o.pickup_window_start_sec))
        ed = max(
            ep + o.service_seconds("PICKUP") + float(dur_matrix[p_n][d_n]),
            float(o.delivery_window_start_sec),
        )
        earliest_d[o.id] = ed
        p_nodes[o.id] = p_n
        d_nodes[o.id] = d_n
        fl_items = (
            [
                it
                for it in o.items
                if not getattr(it, "allow_upper_tier", False)
                or getattr(it, "cargo_kind", "UNCLASSIFIED") != "STANDARD"
            ]
            if stacking_on
            else list(o.items)
        )
        fl_items.sort(key=lambda it: float(it.length_cm) * float(it.width_cm), reverse=True)
        floor_items_by_oid[o.id] = fl_items
        floor_area_by_oid[o.id] = sum(
            float(it.length_cm) * float(it.width_cm) for it in fl_items
        )
        max_h_by_oid[o.id] = max((float(it.height_cm) for it in o.items), default=0.0)

    cand_orders = [o for o in orders if o.id in earliest_d]
    n = len(cand_orders)
    if n <= 1:
        return 1

    def _can_share_vehicle(oa: OrderPair, ob: OrderPair) -> bool:
        a_before_b = (
            earliest_d[oa.id] + oa.service_seconds("DELIVERY") + float(dur_matrix[d_nodes[oa.id]][p_nodes[ob.id]])
            <= float(ob.pickup_window_end_sec) + 1e-6
        )
        b_before_a = (
            earliest_d[ob.id] + ob.service_seconds("DELIVERY") + float(dur_matrix[d_nodes[ob.id]][p_nodes[oa.id]])
            <= float(oa.pickup_window_end_sec) + 1e-6
        )
        if a_before_b or b_before_a:
            return True
        need_w = float(oa.total_weight_kg) + float(ob.total_weight_kg)
        need_a = floor_area_by_oid[oa.id] + floor_area_by_oid[ob.id]
        need_h = max(max_h_by_oid[oa.id], max_h_by_oid[ob.id])
        fa = floor_items_by_oid[oa.id]
        fb = floor_items_by_oid[ob.id]
        for _, v in compat_vehicles:
            if not (optimizer._order_allows_vehicle(oa, v) and optimizer._order_allows_vehicle(ob, v)):
                continue
            if need_w > float(v.payload_limit_kg) + 1e-6:
                continue
            if need_h > float(v.height_cm) + 1e-6:
                continue
            vl = float(v.length_cm)
            vw = float(v.width_cm)
            if need_a > vl * vw + 1e-6:
                continue
            if fa and fb:
                orients_a = [
                    d for d in _item_floor_orientations(fa[0], demo_stacking)
                    if d[0] <= vl + 1e-6 and d[1] <= vw + 1e-6
                ]
                orients_b = [
                    d for d in _item_floor_orientations(fb[0], demo_stacking)
                    if d[0] <= vl + 1e-6 and d[1] <= vw + 1e-6
                ]
                if not any(
                    (la + lb <= vl + 1e-6 and max(wa, wb) <= vw + 1e-6)
                    or (wa + wb <= vw + 1e-6 and max(la, lb) <= vl + 1e-6)
                    for la, wa in orients_a
                    for lb, wb in orients_b
                ):
                    continue
            return True
        return False

    conflicts: List[Set[int]] = [set() for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            if not _can_share_vehicle(cand_orders[i], cand_orders[j]):
                conflicts[i].add(j)
                conflicts[j].add(i)

    best_clique = 1
    by_deg = sorted(range(n), key=lambda idx: len(conflicts[idx]), reverse=True)
    for start in by_deg[: min(8, n)]:
        if len(conflicts[start]) + 1 <= best_clique:
            break
        clique = [start]
        cands = sorted(conflicts[start], key=lambda idx: len(conflicts[idx]), reverse=True)
        for u in cands:
            if all(u in conflicts[v] for v in clique):
                clique.append(u)
        if len(clique) > best_clique:
            best_clique = len(clique)

    # Sound simultaneous-onboard sweep-line lower bound over guaranteed intervals
    # (pickup_window_end_sec < earliest_delivery_sec): all orders active at time t
    # must physically coexist on trucks at instant t.
    max_v_wt = max((float(v.payload_limit_kg) for _, v in compat_vehicles), default=0.0)
    max_v_vol = max(
        (float(v.length_cm) * float(v.width_cm) * float(v.height_cm) for _, v in compat_vehicles),
        default=0.0,
    )
    max_v_area = max(
        (effective_floor_capacity_cm2(v, demo_stacking) for _, v in compat_vehicles),
        default=0.0,
    )
    events: List[Tuple[float, int, float, float, float]] = []
    for o in cand_orders:
        lp = float(o.pickup_window_end_sec)
        ed = earliest_d[o.id]
        if lp + 1e-6 < ed:
            ow = float(o.total_weight_kg)
            ov = sum(float(it.length_cm) * float(it.width_cm) * float(it.height_cm) for it in o.items)
            oa = floor_area_by_oid[o.id]
            events.append((lp, 1, ow, ov, oa))
            events.append((ed, -1, ow, ov, oa))
    if events:
        # Process departures (-1) before arrivals (+1) at identical timestamps.
        events.sort(key=lambda e: (e[0], e[1]))
        cur_wt = 0.0
        cur_vol = 0.0
        cur_area = 0.0
        peak_wt = 0.0
        peak_vol = 0.0
        peak_area = 0.0
        for _, kind, ow, ov, oa in events:
            if kind > 0:
                cur_wt += ow
                cur_vol += ov
                cur_area += oa
                if cur_wt > peak_wt:
                    peak_wt = cur_wt
                if cur_vol > peak_vol:
                    peak_vol = cur_vol
                if cur_area > peak_area:
                    peak_area = cur_area
            else:
                cur_wt -= ow
                cur_vol -= ov
                cur_area -= oa
        if max_v_wt > 1e-6:
            best_clique = max(best_clique, math.ceil((peak_wt - 1e-6) / max_v_wt))
        if max_v_vol > 1e-6:
            best_clique = max(best_clique, math.ceil((peak_vol - 1e-6) / max_v_vol))
        if max_v_area > 1e-6:
            best_clique = max(best_clique, math.ceil((peak_area - 1e-6) / max_v_area))

    return best_clique


def _audit_budget_remaining(optimizer: Any, fallback_rem: float) -> float:
    """Return validation budget remaining up to optimizer._validation_deadline when active."""
    val_deadline = getattr(optimizer, "_validation_deadline", None)
    if val_deadline is not None:
        return max(fallback_rem, val_deadline - time.perf_counter())
    return fallback_rem


def intra_route_cost_polish(
    optimizer: Any,
    best_response: FleetOptimizationResponse,
    deadline: float,
    *,
    on_improve: Optional[Callable[[FleetOptimizationResponse], None]] = None,
) -> FleetOptimizationResponse:
    """Optimize intra-route stop ordering directly by full production rank (catching zero-detour load/salary gains)."""
    best = best_response
    if best.unassigned_orders or time.perf_counter() + 0.04 >= deadline:
        return best

    def _precedence_valid(stops: Sequence[ScheduledStop]) -> bool:
        seen_p: Set[str] = set()
        for s in stops:
            oid = s.allocation_id or s.order_id or ""
            if s.stop_type == "PICKUP":
                seen_p.add(oid)
            elif oid not in seen_p:
                return False
        return True

    use_fast_sched = hasattr(optimizer, "_can_schedule_stops")
    order_nodes = getattr(optimizer, "order_node_indices", None)
    dist_matrix = getattr(optimizer.request, "distance_matrix_meters", None)

    def _tour_dist_m(v_idx: int, stops: Sequence[ScheduledStop]) -> int:
        if order_nodes is None or dist_matrix is None:
            return 0
        prev_n = v_idx
        total = 0
        for st in stops:
            oid = st.allocation_id or st.order_id or ""
            pair_n = order_nodes.get(oid)
            if pair_n is None:
                return 0
            node = pair_n[0 if st.stop_type == "PICKUP" else 1]
            total += int(dist_matrix[prev_n][node])
            prev_n = node
        return total + int(dist_matrix[prev_n][v_idx])

    while time.perf_counter() + 0.04 < deadline:
        routes = optimizer._routes_from_audited_response(best)
        if routes is None or best.unassigned_orders:
            break
        incumbent_rank = optimizer._rank_candidate_for_audit(routes, [])
        best_move: Optional[Tuple[Tuple[int, ...], int, List[ScheduledStop]]] = None

        active_intra = [idx for idx, r in enumerate(routes) if len(r) >= 4]
        for r_pos, v_idx in enumerate(active_intra):
            route = routes[v_idx]
            route_now = time.perf_counter()
            if route_now >= deadline:
                break
            m = len(route)
            rem_routes = max(1, len(active_intra) - r_pos)
            route_slice = (deadline - route_now) / rem_routes
            route_deadline = min(deadline, route_now + route_slice)
            eval_deadline = min(route_deadline, route_now + route_slice * 0.65)
            base_sig = route_stop_signature(route)
            seen_sigs: Set[Tuple[Tuple[str, str], ...]] = {base_sig}
            neighbors: List[Tuple[int, int, List[ScheduledStop]]] = []

            # Order all candidate intra-route moves by surrogate distance first so both short
            # and long routes explore best-detour + holding/surcharge reorganizations anytime.
            first_pos: Dict[str, int] = {}
            last_pos: Dict[str, int] = {}
            for idx_s, st in enumerate(route):
                oid_s = st.allocation_id or st.order_id or ""
                if not oid_s:
                    continue
                if oid_s not in first_pos:
                    first_pos[oid_s] = idx_s
                last_pos[oid_s] = idx_s
            for a in range(m):
                oid_a = route[a].allocation_id or route[a].order_id or ""
                if not oid_a or first_pos.get(oid_a) != a:
                    continue
                max_end = last_pos[oid_a]
                for k in range(a, m):
                    oid_k = route[k].allocation_id or route[k].order_id or ""
                    if first_pos.get(oid_k, -1) < a:
                        break
                    max_end = max(max_end, last_pos.get(oid_k, -1))
                    if k == max_end and 2 <= (k - a + 1) < m:
                        block = route[a : k + 1]
                        reduced_blk = route[:a] + route[k + 1 :]
                        for dst in range(len(reduced_blk) + 1):
                            if dst == a:
                                continue
                            cand = reduced_blk[:dst] + block + reduced_blk[dst:]
                            sig = route_stop_signature(cand)
                            if sig in seen_sigs:
                                continue
                            seen_sigs.add(sig)
                            neighbors.append((_tour_dist_m(v_idx, cand), 0, cand))

            for src in range(m):
                moved = route[src]
                reduced = route[:src] + route[src + 1 :]
                for dst in range(m):
                    if dst == src:
                        continue
                    cand = reduced[:dst] + [moved] + reduced[dst:]
                    if not _precedence_valid(cand):
                        continue
                    sig = route_stop_signature(cand)
                    if sig in seen_sigs:
                        continue
                    seen_sigs.add(sig)
                    neighbors.append((_tour_dist_m(v_idx, cand), 0, cand))

            for i in range(m):
                for j in range(i + 1, m):
                    if route[i].stop_type != route[j].stop_type:
                        continue
                    cand = list(route)
                    cand[i], cand[j] = cand[j], cand[i]
                    if not _precedence_valid(cand):
                        continue
                    sig = route_stop_signature(cand)
                    if sig in seen_sigs:
                        continue
                    seen_sigs.add(sig)
                    neighbors.append((_tour_dist_m(v_idx, cand), 1, cand))

            neighbors.sort(key=lambda item: (item[0], item[1]))
            scored_cands: List[Tuple[Tuple[int, ...], List[ScheduledStop]]] = []
            for _, _, cand in neighbors:
                if time.perf_counter() >= eval_deadline:
                    break
                if use_fast_sched and not optimizer._can_schedule_stops(v_idx, cand):
                    continue
                sched = optimizer._schedule_stops(v_idx, cand)
                if sched is None:
                    continue
                cand_routes = list(routes)
                cand_routes[v_idx] = sched[0]
                cand_rank = optimizer._rank_candidate_for_audit(cand_routes, [])
                if cand_rank < incumbent_rank:
                    scored_cands.append((cand_rank, sched[0]))

            scored_cands.sort(key=lambda item: item[0])
            for cand_rank, sched_stops in scored_cands:
                if time.perf_counter() >= route_deadline:
                    break
                if best_move is not None and cand_rank >= best_move[0]:
                    break
                if optimizer._validate_stops_cached(v_idx, sched_stops):
                    best_move = (cand_rank, v_idx, sched_stops)
                    break

        if best_move is None:
            break
        rem_t = _audit_budget_remaining(optimizer, deadline - time.perf_counter())
        if rem_t <= 0.04:
            break
        cand_routes = list(routes)
        cand_routes[best_move[1]] = best_move[2]
        audited = optimizer._build_final_response(
            cand_routes,
            [],
            include_benchmarks=False,
            spatial_time_budget_seconds=rem_t,
        )
        if optimizer._best_audited_response([best, audited]) is audited:
            best = audited
            if on_improve is not None:
                on_improve(best)
        else:
            break
    return best


def _try_cross_route_order_exchange(
    optimizer: Any,
    best_response: FleetOptimizationResponse,
    deadline: float,
    *,
    on_improve: Optional[Callable[[FleetOptimizationResponse], None]] = None,
) -> FleetOptimizationResponse:
    """First-improvement 1-1 cross-route order exchange scored by surrogate detour and full rank."""
    best = best_response
    if best.unassigned_orders or time.perf_counter() + 0.06 >= deadline:
        return best

    routes = optimizer._routes_from_audited_response(best)
    if routes is None:
        return best
    active = [idx for idx, r in enumerate(routes) if r]
    if len(active) < 2:
        return best

    dist_matrix = optimizer.request.distance_matrix_meters
    demo_stacking = optimizer.request.demo_stacking
    order_node_indices = getattr(optimizer, "order_node_indices", None)
    use_fast_sched = hasattr(optimizer, "_can_schedule_stops")
    spatial_cache: Dict[Tuple[int, Tuple[Tuple[str, str], ...]], bool] = {}

    def _can_sched(v_idx: int, raw: List[ScheduledStop]) -> bool:
        if use_fast_sched:
            return bool(optimizer._can_schedule_stops(v_idx, raw))
        return optimizer._schedule_stops(v_idx, raw) is not None

    def _validate_cached(v_idx: int, stops: List[ScheduledStop]) -> bool:
        key = (v_idx, route_stop_signature(stops))
        cached = spatial_cache.get(key)
        if cached is not None:
            return cached
        ok = bool(optimizer._validate_stops_cached(v_idx, stops))
        spatial_cache[key] = ok
        return ok

    def _stop_node(stop: ScheduledStop, oid: str) -> Optional[int]:
        if order_node_indices is not None and oid in order_node_indices:
            return order_node_indices[oid][0 if stop.stop_type == "PICKUP" else 1]
        return optimizer._stop_node_index(stop)

    def _route_tour_dist(v_idx: int, stops: Sequence[ScheduledStop]) -> Optional[int]:
        prev_n = v_idx
        total = 0
        for s in stops:
            oid = s.allocation_id or s.order_id or ""
            node = _stop_node(s, oid)
            if node is None:
                return None
            total += dist_matrix[prev_n][node]
            prev_n = node
        return total + dist_matrix[prev_n][v_idx]

    while time.perf_counter() < deadline:
        routes = optimizer._routes_from_audited_response(best)
        if routes is None or best.unassigned_orders:
            break
        active = [idx for idx, r in enumerate(routes) if r]
        if len(active) < 2:
            break
        incumbent_rank = optimizer._rank_candidate_for_audit(routes, [])

        route_dists: Dict[int, int] = {}
        route_order_stops: Dict[Tuple[int, str], Tuple[ScheduledStop, ScheduledStop]] = {}
        route_reduced: Dict[Tuple[int, str], Tuple[List[ScheduledStop], List[int], int, List[float], List[float]]] = {}
        route_orders: Dict[int, List[str]] = {}

        for v_idx in active:
            d_val = _route_tour_dist(v_idx, routes[v_idx])
            if d_val is None:
                return best
            route_dists[v_idx] = d_val
            v = optimizer.vehicles[v_idx]
            max_w = v.payload_limit_kg + 1e-6
            max_a = effective_floor_capacity_cm2(v, demo_stacking) + 1e-6
            oids = _route_order_ids(routes[v_idx])
            valid_oids: List[str] = []
            for oid in oids:
                order_obj = optimizer.order_by_id.get(oid)
                if order_obj is None or order_obj.split_group_id:
                    continue
                matched = [
                    s for s in routes[v_idx] if (s.allocation_id or s.order_id) == oid
                ]
                if len(matched) != 2 or matched[0].stop_type != "PICKUP" or matched[1].stop_type != "DELIVERY":
                    continue
                reduced = [s for s in routes[v_idx] if (s.allocation_id or s.order_id) != oid]
                red_dist = _route_tour_dist(v_idx, reduced)
                if red_dist is None:
                    continue
                nodes_seq = [v_idx]
                w_after = [0.0]
                a_after = [0.0]
                cur_w = 0.0
                cur_a = 0.0
                load_ok = True
                for s in reduced:
                    s_oid = s.allocation_id or s.order_id or ""
                    s_node = _stop_node(s, s_oid)
                    if s_node is None:
                        load_ok = False
                        break
                    nodes_seq.append(s_node)
                    s_order = optimizer.order_by_id.get(s_oid)
                    if s_order is not None:
                        w_d = float(s_order.total_weight_kg)
                        a_d = float(sum(it.length_cm * it.width_cm for it in s_order.items))
                        if s.stop_type == "PICKUP":
                            cur_w += w_d
                            cur_a += a_d
                        else:
                            cur_w = max(0.0, cur_w - w_d)
                            cur_a = max(0.0, cur_a - a_d)
                    if cur_w > max_w or cur_a > max_a:
                        load_ok = False
                        break
                    w_after.append(cur_w)
                    a_after.append(cur_a)
                if not load_ok:
                    continue
                nodes_seq.append(v_idx)
                route_order_stops[(v_idx, oid)] = (matched[0], matched[1])
                route_reduced[(v_idx, oid)] = (reduced, nodes_seq, red_dist, w_after, a_after)
                valid_oids.append(oid)
            full_nodes = [v_idx]
            full_w = [0.0]
            full_a = [0.0]
            fw = fa = 0.0
            full_ok = True
            for s in routes[v_idx]:
                s_oid = s.allocation_id or s.order_id or ""
                s_node = _stop_node(s, s_oid)
                if s_node is None:
                    full_ok = False
                    break
                full_nodes.append(s_node)
                s_order = optimizer.order_by_id.get(s_oid)
                if s_order is not None:
                    wd = float(s_order.total_weight_kg)
                    ad = float(sum(it.length_cm * it.width_cm for it in s_order.items))
                    if s.stop_type == "PICKUP":
                        fw += wd
                        fa += ad
                    else:
                        fw = max(0.0, fw - wd)
                        fa = max(0.0, fa - ad)
                if fw > max_w or fa > max_a:
                    full_ok = False
                    break
                full_w.append(fw)
                full_a.append(fa)
            if full_ok:
                full_nodes.append(v_idx)
                route_reduced[(v_idx, "")] = (routes[v_idx], full_nodes, d_val, full_w, full_a)
            route_orders[v_idx] = valid_oids

        insert_pos_cache: Dict[Tuple[int, str, str], List[Tuple[int, List[ScheduledStop]]]] = {}
        sched_cache: Dict[Tuple[int, str, str], List[Tuple[int, List[ScheduledStop]]]] = {}

        def _top_insert_positions(
            v_idx: int, removed_oid: str, inserted_oid: str
        ) -> List[Tuple[int, List[ScheduledStop]]]:
            key = (v_idx, removed_oid, inserted_oid)
            cached = insert_pos_cache.get(key)
            if cached is not None:
                return cached
            red_stops, nodes_seq, red_dist, w_after, a_after = route_reduced[(v_idx, removed_oid)]
            ins_order = optimizer.order_by_id[inserted_oid]
            v = optimizer.vehicles[v_idx]
            if not optimizer._order_allows_vehicle(ins_order, v):
                insert_pos_cache[key] = []
                return []
            ins_p, ins_d = None, None
            for s_idx, oids in route_orders.items():
                if (s_idx, inserted_oid) in route_order_stops:
                    ins_p, ins_d = route_order_stops[(s_idx, inserted_oid)]
                    break
            if ins_p is None or ins_d is None:
                insert_pos_cache[key] = []
                return []
            p_n = _stop_node(ins_p, inserted_oid)
            d_n = _stop_node(ins_d, inserted_oid)
            if p_n is None or d_n is None:
                insert_pos_cache[key] = []
                return []
            ins_w = float(ins_order.total_weight_kg)
            ins_a = float(sum(it.length_cm * it.width_cm for it in ins_order.items))
            max_w = v.payload_limit_kg + 1e-6
            max_a = effective_floor_capacity_cm2(v, demo_stacking) + 1e-6
            m = len(red_stops)
            if ins_w > max_w or ins_a > max_a:
                insert_pos_cache[key] = []
                return []

            cands: List[Tuple[int, int, int]] = []
            best_cyc: Optional[Tuple[int, int, int]] = None
            for p in range(m + 1):
                if w_after[p] + ins_w > max_w or a_after[p] + ins_a > max_a:
                    continue
                edge_p = dist_matrix[nodes_seq[p]][p_n] + dist_matrix[p_n][nodes_seq[p + 1]] - dist_matrix[nodes_seq[p]][nodes_seq[p + 1]]
                cyc_dist = red_dist + dist_matrix[nodes_seq[p]][p_n] + dist_matrix[p_n][d_n] + dist_matrix[d_n][nodes_seq[p + 1]] - dist_matrix[nodes_seq[p]][nodes_seq[p + 1]]
                if best_cyc is None or cyc_dist < best_cyc[0]:
                    best_cyc = (cyc_dist, p, p)
                cands.append((cyc_dist, p, p))
                for q in range(p + 1, m + 1):
                    if w_after[q] + ins_w > max_w or a_after[q] + ins_a > max_a:
                        break
                    d_delta = dist_matrix[nodes_seq[q]][d_n] + dist_matrix[d_n][nodes_seq[q + 1]] - dist_matrix[nodes_seq[q]][nodes_seq[q + 1]]
                    cands.append((red_dist + edge_p + d_delta, p, q))

            cands.sort(key=lambda item: item[0])
            picked_pairs = cands[:24]
            if best_cyc is not None and best_cyc not in picked_pairs:
                picked_pairs.append(best_cyc)
            out: List[Tuple[int, List[ScheduledStop]]] = []
            for est_d, p, q in picked_pairs:
                if p == q:
                    cand_s = red_stops[:p] + [ins_p, ins_d] + red_stops[p:]
                else:
                    cand_s = red_stops[:p] + [ins_p] + red_stops[p:q] + [ins_d] + red_stops[q:]
                out.append((est_d, cand_s))
            insert_pos_cache[key] = out
            return out

        econ_entry_fn = getattr(optimizer, "_scheduled_route_economic_entry", None)
        raw_obj_policy = getattr(optimizer, "_raw_policy", optimizer.policy)
        op_daily_wt = (
            operational_late_daily_weight_vnd(optimizer.objective_request)
            if hasattr(optimizer, "objective_request")
            and getattr(raw_obj_policy, "late_delivery_penalty_mode", None) == "NONE"
            else 0
        )
        grace_sec = int(getattr(raw_obj_policy, "delivery_grace_days", 0)) * SECONDS_PER_DAY
        per_km_rates = [float(getattr(d, "per_km_pay_vnd", 1200)) for d in getattr(optimizer, "drivers", ())]
        driver_rate_spread = (max(per_km_rates) - min(per_km_rates)) if len(per_km_rates) >= 2 else 0.0
        single_cost_cache: Dict[Tuple[int, Tuple[Tuple[str, str], ...]], int] = {}

        def _single_route_proxy_cost(v_idx: int, sched_stops: List[ScheduledStop]) -> int:
            if not sched_stops or econ_entry_fn is None:
                return 0
            sig = route_stop_signature(sched_stops)
            ckey = (v_idx, sig)
            cached_val = single_cost_cache.get(ckey)
            if cached_val is not None:
                return cached_val
            entry = econ_entry_fn(v_idx, sched_stops)
            if entry is None:
                single_cost_cache[ckey] = 10**12
                return 10**12
            late_vnd = 0
            for st in sched_stops:
                if getattr(st, "stop_type", "") == "DELIVERY":
                    oid = getattr(st, "allocation_id", None) or getattr(st, "order_id", None) or ""
                    ord_pair = optimizer.order_by_id.get(oid)
                    if ord_pair is not None:
                        if op_daily_wt > 0:
                            late_sec = max(0, st.arrival_time_sec - (ord_pair.ordered_at_sec + grace_sec))
                            late_vnd += round(op_daily_wt * late_sec / SECONDS_PER_DAY)
                        else:
                            late_vnd += calculate_late_delivery_penalty(ord_pair, st.arrival_time_sec, raw_obj_policy)
            total = int(entry[0]) + int(late_vnd)
            single_cost_cache[ckey] = total
            return total

        def _scheduled_insert_options(
            v_idx: int, removed_oid: str, inserted_oid: str
        ) -> List[Tuple[int, List[ScheduledStop]]]:
            key = (v_idx, removed_oid, inserted_oid)
            cached = sched_cache.get(key)
            if cached is not None:
                return cached
            raw_list = _top_insert_positions(v_idx, removed_oid, inserted_oid)
            out: List[Tuple[int, List[ScheduledStop]]] = []
            seen_sigs: Set[Tuple[Tuple[str, str], ...]] = set()
            for est_d, raw_s in raw_list:
                if time.perf_counter() >= deadline:
                    break
                if not _can_sched(v_idx, raw_s):
                    continue
                sched = optimizer._schedule_stops(v_idx, raw_s)
                if sched is None:
                    continue
                sig = route_stop_signature(sched[0])
                if sig in seen_sigs:
                    continue
                seen_sigs.add(sig)
                out.append((est_d, sched[0]))
                if len(out) >= 12:
                    break
            if len(out) > 1 and econ_entry_fn is not None:
                # Rank schedule-valid options by single-route (operating + exact lateness) cost
                # without discarding feasible backups, so cheaper/3D-valid positions are tried first.
                out.sort(key=lambda item: (_single_route_proxy_cost(v_idx, item[1]), item[0]))
            sched_cache[key] = out
            return out

        cur_route_proxies = {
            v_idx: _single_route_proxy_cost(v_idx, routes[v_idx]) for v_idx in active
        }

        # Enumerate all feasible 1-0 cross-route order relocations ordered by detour,
        # reserving >= 55% of the phase budget for 1-1 swaps purely via clock time.
        reloc_queue: List[Tuple[Tuple[int, int], int, str, int]] = []
        for i in active:
            for o_a in route_orders[i]:
                red_i, _, dist_red_i, _, _ = route_reduced[(i, o_a)]
                empties_i = not red_i
                for j in active:
                    if j == i or (j, "") not in route_reduced:
                        continue
                    ins_j = _top_insert_positions(j, "", o_a)
                    if not ins_j:
                        continue
                    base_ij_dist = route_dists[i] + route_dists[j]
                    surrogate_delta = (dist_red_i + ins_j[0][0]) - base_ij_dist
                    bucket = -1 if empties_i else (0 if surrogate_delta <= 0 else 1)
                    reloc_queue.append(((bucket, surrogate_delta), i, o_a, j))
        reloc_queue.sort(key=lambda item: item[0])

        improved = False
        reloc_now = time.perf_counter()
        reloc_deadline = min(deadline, reloc_now + (deadline - reloc_now) * 0.45)
        pos_reloc_deadline = min(reloc_deadline, reloc_now + (reloc_deadline - reloc_now) * 0.55)
        for (reloc_bucket, _), i, o_a, j in reloc_queue:
            cur_reloc_limit = pos_reloc_deadline if reloc_bucket == 1 else reloc_deadline
            if time.perf_counter() >= cur_reloc_limit:
                break
            red_i = route_reduced[(i, o_a)][0]
            if not red_i:
                sched_i: List[ScheduledStop] = []
            else:
                if not _can_sched(i, red_i):
                    continue
                sched_res_i = optimizer._schedule_stops(i, red_i)
                if sched_res_i is None:
                    continue
                sched_i = sched_res_i[0]
            opts_j = _scheduled_insert_options(j, "", o_a)
            if not opts_j:
                continue
            best_reloc_cand: Optional[List[List[ScheduledStop]]] = None
            best_reloc_rank = incumbent_rank
            sig_i = (i, route_stop_signature(sched_i)) if sched_i else None
            validated_i: Optional[bool] = True if not sched_i else spatial_cache.get(sig_i)
            p_i = _single_route_proxy_cost(i, sched_i) if sched_i else 0
            ed_i = route_reduced[(i, o_a)][2] if sched_i else 0
            cur_reloc_proxy = cur_route_proxies[i] + cur_route_proxies[j]
            cur_reloc_dist = route_dists[i] + route_dists[j]
            for ed_j, sched_j in opts_j:
                if time.perf_counter() >= cur_reloc_limit:
                    break
                sig_j = (j, route_stop_signature(sched_j))
                if sig_j in spatial_cache and not spatial_cache[sig_j]:
                    continue
                if sched_i and econ_entry_fn is not None:
                    p_j = _single_route_proxy_cost(j, sched_j)
                    driver_slack = round(driver_rate_spread * abs(ed_i + ed_j - cur_reloc_dist) / 1000.0)
                    if p_i + p_j >= cur_reloc_proxy + driver_slack and ed_i + ed_j >= cur_reloc_dist:
                        continue
                cand_routes = list(routes)
                cand_routes[i] = sched_i
                cand_routes[j] = sched_j
                cand_rank = optimizer._rank_candidate_for_audit(cand_routes, [])
                if cand_rank >= best_reloc_rank:
                    continue
                if validated_i is None:
                    validated_i = _validate_cached(i, sched_i)
                if not validated_i:
                    break
                if not _validate_cached(j, sched_j):
                    continue
                best_reloc_rank = cand_rank
                best_reloc_cand = cand_routes
                if demo_stacking is None:
                    break
            if best_reloc_cand is not None:
                rem_t = _audit_budget_remaining(optimizer, deadline - time.perf_counter())
                if rem_t <= 0.02:
                    return best
                audited = optimizer._build_final_response(
                    best_reloc_cand,
                    [],
                    include_benchmarks=False,
                    spatial_time_budget_seconds=rem_t,
                )
                if optimizer._best_audited_response([best, audited]) is audited:
                    best = audited
                    if on_improve is not None:
                        on_improve(best)
                    improved = True
                    break
        if improved:
            continue

        # Enumerate all feasible cross-route pairs ordered by distance delta and weight diff.
        pair_queue: List[Tuple[Tuple[int, int, float], int, str, int, str]] = []
        for pos_i, i in enumerate(active):
            for j in active[pos_i + 1 :]:
                base_pair_dist = route_dists[i] + route_dists[j]
                for o_a in route_orders[i]:
                    w_a = float(optimizer.order_by_id[o_a].total_weight_kg)
                    for o_b in route_orders[j]:
                        ins_i = _top_insert_positions(i, o_a, o_b)
                        if not ins_i:
                            continue
                        ins_j = _top_insert_positions(j, o_b, o_a)
                        if not ins_j:
                            continue
                        surrogate_delta = (ins_i[0][0] + ins_j[0][0]) - base_pair_dist
                        w_b = float(optimizer.order_by_id[o_b].total_weight_kg)
                        bucket = 0 if surrogate_delta <= 0 else 1
                        pair_queue.append(
                            ((bucket, surrogate_delta, -abs(w_a - w_b)), i, o_a, j, o_b)
                        )

        pair_queue.sort(key=lambda item: item[0])
        best_pass_cand: Optional[List[List[ScheduledStop]]] = None
        best_pass_rank = incumbent_rank
        pass_lookahead_deadline: Optional[float] = None
        for _, i, o_a, j, o_b in pair_queue:
            now_swap = time.perf_counter()
            if now_swap >= deadline:
                break
            if best_pass_cand is not None:
                if (
                    now_swap >= deadline - max(0.04, (deadline - now_swap) * 0.05)
                    or (pass_lookahead_deadline is not None and now_swap >= pass_lookahead_deadline)
                ):
                    break
            opts_i = _scheduled_insert_options(i, o_a, o_b)
            if not opts_i:
                continue
            opts_j = _scheduled_insert_options(j, o_b, o_a)
            if not opts_j:
                continue
            cur_pair_proxy = cur_route_proxies[i] + cur_route_proxies[j]
            cur_pair_dist = route_dists[i] + route_dists[j]
            pair_combos: List[Tuple[int, int, List[ScheduledStop], List[ScheduledStop]]] = []
            for idx_i, (ed_i, sched_i) in enumerate(opts_i):
                sig_i = (i, route_stop_signature(sched_i))
                if sig_i in spatial_cache and not spatial_cache[sig_i]:
                    continue
                p_i = _single_route_proxy_cost(i, sched_i)
                for idx_j, (ed_j, sched_j) in enumerate(opts_j):
                    sig_j = (j, route_stop_signature(sched_j))
                    if sig_j in spatial_cache and not spatial_cache[sig_j]:
                        continue
                    p_j = _single_route_proxy_cost(j, sched_j)
                    driver_slack = round(driver_rate_spread * abs(ed_i + ed_j - cur_pair_dist) / 1000.0)
                    # Sound dominance pruning: skip swaps worse in both cost+lateness (even with max driver spread) and distance.
                    if econ_entry_fn is not None and p_i + p_j >= cur_pair_proxy + driver_slack and ed_i + ed_j >= cur_pair_dist:
                        continue
                    pair_combos.append((p_i + p_j, ed_i + ed_j, sched_i, sched_j))
            pair_combos.sort(key=lambda item: (item[0], item[1]))
            best_swap_cand: Optional[List[List[ScheduledStop]]] = None
            best_swap_rank = best_pass_rank
            loop_end = pass_lookahead_deadline if pass_lookahead_deadline is not None else deadline
            ranked_evals = 0
            for _, _, sched_i, sched_j in pair_combos:
                if time.perf_counter() >= loop_end:
                    break
                # When 3D stacking is inactive, all schedule-valid combos are spatially feasible;
                # single-route exact cost additive property makes checking beyond top-2 redundant.
                if demo_stacking is None and ranked_evals >= 2 and best_swap_cand is None:
                    break
                sig_i = (i, route_stop_signature(sched_i))
                sig_j = (j, route_stop_signature(sched_j))
                if (sig_i in spatial_cache and not spatial_cache[sig_i]) or (
                    sig_j in spatial_cache and not spatial_cache[sig_j]
                ):
                    continue
                cand_routes = list(routes)
                cand_routes[i] = sched_i
                cand_routes[j] = sched_j
                cand_rank = optimizer._rank_candidate_for_audit(cand_routes, [])
                ranked_evals += 1
                if cand_rank >= best_swap_rank:
                    continue
                if not _validate_cached(i, sched_i):
                    continue
                if not _validate_cached(j, sched_j):
                    continue
                best_swap_rank = cand_rank
                best_swap_cand = cand_routes
                if demo_stacking is not None:
                    break
            if best_swap_cand is not None:
                best_pass_rank = best_swap_rank
                best_pass_cand = best_swap_cand
                if pass_lookahead_deadline is None:
                    rem_after_hit = max(0.0, deadline - time.perf_counter())
                    pass_lookahead_deadline = time.perf_counter() + rem_after_hit * 0.25
        if best_pass_cand is not None:
            rem_t = _audit_budget_remaining(optimizer, deadline - time.perf_counter())
            if rem_t <= 0.02:
                return best
            audited = optimizer._build_final_response(
                best_pass_cand,
                [],
                include_benchmarks=False,
                spatial_time_budget_seconds=rem_t,
            )
            if optimizer._best_audited_response([best, audited]) is audited:
                best = audited
                if on_improve is not None:
                    on_improve(best)
                improved = True

        if not improved:
            break
    return best


def _sorted_active_route_indices(
    optimizer: Any, routes: Sequence[List[ScheduledStop]]
) -> List[int]:
    """Order active route indices from fewest orders / lightest load upward."""
    return sorted(
        (idx for idx, r in enumerate(routes) if r),
        key=lambda idx: (
            len({s.order_id for s in routes[idx] if s.order_id}),
            sum(
                optimizer.order_by_id[s.allocation_id or s.order_id].total_weight_kg
                for s in routes[idx]
                if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id) in optimizer.order_by_id
            ),
        ),
    )


def _upgrade_routes_onto_larger_empty(
    optimizer: Any,
    routes: List[List[ScheduledStop]],
    deadline: float,
) -> Optional[List[List[ScheduledStop]]]:
    """Re-home smaller active routes onto strictly larger idle same-day vehicles."""
    demo_stacking = optimizer.request.demo_stacking
    cur_empty = {
        idx
        for idx, r in enumerate(routes)
        if not r and optimizer._vehicle_has_compatible_driver(optimizer.vehicles[idx])
    }
    if not cur_empty:
        return None
    active = sorted(
        (idx for idx, r in enumerate(routes) if r),
        key=lambda idx: (
            optimizer.vehicles[idx].payload_limit_kg,
            effective_floor_capacity_cm2(optimizer.vehicles[idx], demo_stacking),
        ),
    )
    working: Optional[List[List[ScheduledStop]]] = None
    for target_idx in active:
        if time.perf_counter() >= deadline or not cur_empty:
            break
        cur_v = optimizer.vehicles[target_idx]
        cur_area = effective_floor_capacity_cm2(cur_v, demo_stacking)
        same_day_empty = sorted(
            (
                idx
                for idx in cur_empty
                if optimizer.vehicles[idx].service_day_index == cur_v.service_day_index
            ),
            key=lambda idx: (
                -optimizer.vehicles[idx].payload_limit_kg,
                -effective_floor_capacity_cm2(optimizer.vehicles[idx], demo_stacking),
            ),
        )
        src_stops = (working or routes)[target_idx]
        for up_idx in same_day_empty:
            if time.perf_counter() >= deadline:
                break
            up_v = optimizer.vehicles[up_idx]
            up_area = effective_floor_capacity_cm2(up_v, demo_stacking)
            if up_v.payload_limit_kg < cur_v.payload_limit_kg - 1.0 or up_area < cur_area - 1.0:
                continue
            if up_v.payload_limit_kg <= cur_v.payload_limit_kg + 1.0 and up_area <= cur_area + 1.0:
                continue
            if not _all_orders_allow_vehicle(optimizer, src_stops, up_v):
                continue
            scheduled = optimizer._schedule_stops(up_idx, src_stops)
            if scheduled is None or not optimizer._validate_stops_cached(up_idx, scheduled[0]):
                continue
            if working is None:
                working = copy.deepcopy(routes)
            working[target_idx] = []
            working[up_idx] = scheduled[0]
            cur_empty.remove(up_idx)
            break
    return working


def consolidate_with_vehicle_upgrade(
    optimizer: Any,
    routes: List[List[ScheduledStop]],
    deadline: float,
    *,
    max_steps: Optional[int] = None,
    min_routes_lb: Optional[int] = None,
    skip_vehicle_opt: bool = False,
) -> Optional[List[List[ScheduledStop]]]:
    """Try eliminating routes by direct removal, vehicle upgrade, or multi-route rebalancing."""
    current = copy.deepcopy(routes)
    improved = False
    steps_done = 0
    lower_bound = _min_route_clique_lower_bound(optimizer) if min_routes_lb is None else min_routes_lb
    while time.perf_counter() < deadline:
        if max_steps is not None and steps_done >= max_steps:
            break
        active_indices = _sorted_active_route_indices(optimizer, current)
        if len(active_indices) <= max(1, lower_bound):
            break

        merged_step: Optional[List[List[ScheduledStop]]] = None
        best_step_rank: Optional[Tuple[int, ...]] = None

        rem_step = max(0.0, deadline - time.perf_counter())
        empty_cycle_count = sum(
            1 for idx in active_indices if _is_pure_empty_cycles(current[idx]) is not None
        )
        empty_cycle_frac = empty_cycle_count / max(1, len(active_indices))
        # 0) Fast heterogeneous empty-cycle bin packing consolidation across k-1 slots first.
        if time.perf_counter() + 0.04 < deadline:
            cycle_slice = rem_step * (0.08 + 0.14 * empty_cycle_frac)
            cycle_deadline = min(deadline, time.perf_counter() + cycle_slice)
            merged_step = _try_empty_cycle_consolidation(optimizer, current, active_indices, cycle_deadline)

        # 1) Direct elimination across candidate victim routes (regret3 across all victims first).
        rem_stage1 = max(0.0, deadline - time.perf_counter())
        stage1_deadline = min(deadline, time.perf_counter() + rem_stage1 * 0.25)
        if merged_step is None and time.perf_counter() < stage1_deadline:
            for repair_op in ("regret3", "regret2", "greedy"):
                if time.perf_counter() >= stage1_deadline or merged_step is not None:
                    break
                for victim_idx in active_indices:
                    if time.perf_counter() >= stage1_deadline:
                        break
                    victim_orders = _route_order_ids(current[victim_idx])
                    base = copy.deepcopy(current)
                    base[victim_idx] = []
                    empty_set = _empty_vehicle_indices(base)
                    cand_routes, failed = optimizer._repair(
                        base,
                        victim_orders,
                        repair_op,
                        stage1_deadline,
                        excluded_vehicle_indices=empty_set,
                    )
                    if not failed:
                        rank = optimizer._rank_candidate_for_audit(cand_routes, [])
                        if best_step_rank is None or rank < best_step_rank:
                            best_step_rank = rank
                            merged_step = cand_routes
                        break

        # 2) Only if no direct elimination succeeded, try upgrading a remaining active route first.
        rem_stage2 = max(0.0, deadline - time.perf_counter())
        demo_stacking = optimizer.request.demo_stacking
        has_larger_empty = any(
            not current[up_i]
            and optimizer._vehicle_has_compatible_driver(optimizer.vehicles[up_i])
            and any(
                optimizer.vehicles[up_i].service_day_index == optimizer.vehicles[act_i].service_day_index
                and (
                    optimizer.vehicles[up_i].payload_limit_kg > optimizer.vehicles[act_i].payload_limit_kg + 1.0
                    or effective_floor_capacity_cm2(optimizer.vehicles[up_i], demo_stacking)
                    > effective_floor_capacity_cm2(optimizer.vehicles[act_i], demo_stacking) + 1.0
                )
                for act_i in active_indices
            )
            for up_i in range(len(current))
        )
        stage2_deadline = min(deadline, time.perf_counter() + rem_stage2 * (0.28 if has_larger_empty else 0.15))
        if merged_step is None and time.perf_counter() < stage2_deadline:
            for victim_idx in active_indices:
                if time.perf_counter() >= stage2_deadline or merged_step is not None:
                    break
                victim_orders = _route_order_ids(current[victim_idx])
                base = copy.deepcopy(current)
                base[victim_idx] = []
                remaining_active = [idx for idx in active_indices if idx != victim_idx]
                empty_reps = [
                    idx
                    for idx in representative_empty_indices(optimizer, base)
                    if idx != victim_idx and optimizer._vehicle_has_compatible_driver(optimizer.vehicles[idx])
                ]
                for target_idx in remaining_active:
                    if time.perf_counter() >= stage2_deadline or merged_step is not None:
                        break
                    cur_v = optimizer.vehicles[target_idx]
                    cur_area = effective_floor_capacity_cm2(cur_v, optimizer.request.demo_stacking)
                    target_stops = base[target_idx]
                    # Try compatible same-day larger profiles before cross-day shifts.
                    ordered_reps = sorted(
                        empty_reps,
                        key=lambda idx: (
                            0 if optimizer.vehicles[idx].service_day_index == cur_v.service_day_index else 1,
                            -optimizer.vehicles[idx].payload_limit_kg,
                            -(optimizer.vehicles[idx].length_cm * optimizer.vehicles[idx].width_cm),
                            optimizer.vehicles[idx].service_day_index,
                        ),
                    )
                    for up_idx in ordered_reps:
                        if time.perf_counter() >= stage2_deadline:
                            break
                        up_v = optimizer.vehicles[up_idx]
                        up_area = effective_floor_capacity_cm2(up_v, optimizer.request.demo_stacking)
                        if (
                            up_v.payload_limit_kg <= cur_v.payload_limit_kg + 1.0
                            and up_area <= cur_area + 1.0
                            and up_v.service_day_index >= cur_v.service_day_index
                        ):
                            continue
                        if (
                            up_v.service_day_index != cur_v.service_day_index
                            and not _max_routes_allows_day(
                                optimizer, base, up_v.service_day_index, excluding_index=target_idx
                            )
                        ):
                            continue
                        if not _all_orders_allow_vehicle(optimizer, target_stops, up_v):
                            continue
                        scheduled = optimizer._schedule_stops(up_idx, target_stops)
                        if scheduled is None or not optimizer._validate_stops_cached(up_idx, scheduled[0]):
                            continue
                        upgraded = copy.deepcopy(base)
                        upgraded[target_idx] = []
                        upgraded[up_idx] = scheduled[0]
                        upgraded_empty = _empty_vehicle_indices(upgraded)
                        for repair_op in ("regret3", "greedy"):
                            if time.perf_counter() >= stage2_deadline:
                                break
                            cand_routes, failed = optimizer._repair(
                                copy.deepcopy(upgraded),
                                victim_orders,
                                repair_op,
                                stage2_deadline,
                                excluded_vehicle_indices=upgraded_empty,
                            )
                            if not failed:
                                rank = optimizer._rank_candidate_for_audit(cand_routes, [])
                                if best_step_rank is None or rank < best_step_rank:
                                    best_step_rank = rank
                                    merged_step = cand_routes
                                break
                        if merged_step is not None:
                            break

        # 3) Rebalance two routes jointly (50% remaining) and ripple edge orders across all active routes (remaining 50%).
        if merged_step is None and time.perf_counter() < deadline:
            rem_stage3 = max(0.0, deadline - time.perf_counter())
            stage3_current = (
                _upgrade_routes_onto_larger_empty(
                    optimizer,
                    current,
                    min(deadline, time.perf_counter() + min(0.15, rem_stage3 * 0.12)),
                )
                or current
            )
            stage3_active = _sorted_active_route_indices(optimizer, stage3_current)
            rem_after_up = max(0.0, deadline - time.perf_counter())
            pair_deadline = min(
                deadline,
                time.perf_counter() + (rem_after_up * 0.50 if len(stage3_active) >= 3 else rem_after_up),
            )
            merged_step = _try_pair_route_consolidation(optimizer, stage3_current, stage3_active, pair_deadline)
            if merged_step is None and len(stage3_active) >= 3 and time.perf_counter() < deadline:
                merged_step = _try_multi_route_ripple_consolidation(optimizer, stage3_current, stage3_active, deadline)

        if merged_step is None:
            break
        rem_for_veh = deadline - time.perf_counter()
        if not skip_vehicle_opt and rem_for_veh > 0.25:
            veh_opt = bounded_optimize_production_vehicles(
                optimizer,
                merged_step,
                [],
                min(deadline, time.perf_counter() + min(0.50, rem_for_veh * 0.35)),
            )
            if veh_opt is not None:
                merged_step = veh_opt[1]
        current = merged_step
        improved = True
        steps_done += 1

    return current if improved else None


def _plan_signature(routes: Sequence[Sequence[ScheduledStop]]) -> Tuple[Tuple[Tuple[str, str], ...], ...]:
    return tuple(route_stop_signature(r) for r in routes)


def _served_and_missing(
    optimizer: Any,
    routes: Sequence[Sequence[ScheduledStop]],
) -> Tuple[Set[str], List[str]]:
    served_ids = {
        stop.allocation_id or stop.order_id
        for route in routes
        for stop in route
        if stop.order_id
    }
    missing_ids = [oid for oid in optimizer.order_by_id if oid not in served_ids]
    return served_ids, missing_ids


def spare_budget_lns_polish(
    optimizer: Any,
    best_response: FleetOptimizationResponse,
    deadline: float,
    *,
    allow_layout_toggle: Optional[Callable[[bool], None]] = None,
    on_improve: Optional[Callable[[FleetOptimizationResponse], None]] = None,
) -> FleetOptimizationResponse:
    """Use remaining spare budget for consolidation, repair of partial manifests, and multi-basin VNS/LNS."""
    if not best_response.routes:
        return best_response

    def _response_rank_key(resp: FleetOptimizationResponse) -> Tuple[int, int, int, int, int, int]:
        unassigned_cnt = len({order.order_id for order in resp.unassigned_orders})
        return (unassigned_cnt, *plan_lexicographic_key(resp))

    best = best_response
    if best.planning_objective is None and hasattr(optimizer, "objective_request"):
        apply_planning_objective(optimizer.objective_request, best)
    incumbent_key = _response_rank_key(best)
    incumbent_routes = optimizer._routes_from_audited_response(best)
    if incumbent_routes is None:
        return best

    last_emitted_id: Optional[int] = None

    def _emit_improve(resp: FleetOptimizationResponse) -> None:
        nonlocal last_emitted_id
        if on_improve is None:
            return
        if id(resp) == last_emitted_id:
            return
        last_emitted_id = id(resp)
        on_improve(resp)

    def _with_layout_search(enabled: bool, fn: Callable[[], Any]) -> Any:
        if allow_layout_toggle is None:
            return fn()
        prev_layout = getattr(optimizer, "_allow_layout_search", True)
        allow_layout_toggle(enabled)
        try:
            return fn()
        finally:
            allow_layout_toggle(prev_layout)

    last_polished_budget: Dict[Tuple[Tuple[Tuple[str, str], ...], ...], float] = {}
    last_intra_cost_budget: Dict[Tuple[Tuple[Tuple[str, str], ...], ...], float] = {}
    last_exchanged_budget: Dict[Tuple[Tuple[Tuple[str, str], ...], ...], float] = {}
    last_consolidated_sig: Optional[Tuple[Tuple[Tuple[str, str], ...], ...]] = None
    failed_consolidation_budgets: Dict[Tuple[int, Tuple[Tuple[str, ...], ...]], float] = {}
    failed_route_count_cons: Dict[int, float] = {}
    min_routes_lb = _min_route_clique_lower_bound(optimizer)

    def _can_skip_local_sig(
        cache: Dict[Tuple[Tuple[Tuple[str, str], ...], ...], float],
        sig: Tuple[Tuple[Tuple[str, str], ...], ...],
        planned_sec: float,
    ) -> bool:
        prev = cache.get(sig)
        if prev is None:
            return False
        if prev == float("inf"):
            return True
        return planned_sec <= prev * 1.15

    def _record_local_sig_outcome(
        cache: Dict[Tuple[Tuple[Tuple[str, str], ...], ...], float],
        sig: Tuple[Tuple[Tuple[str, str], ...], ...],
        sub_deadline: float,
        planned_sec: float,
    ) -> None:
        # Mark signature as exhausted (inf) only when search finished before deadline;
        # otherwise record the attempted budget so larger slices can resume later.
        if time.perf_counter() + 0.02 < sub_deadline:
            cache[sig] = float("inf")
        else:
            cache[sig] = max(cache.get(sig, 0.0), planned_sec)

    def _partition_sig(routes: Sequence[Sequence[ScheduledStop]]) -> Tuple[int, Tuple[Tuple[str, ...], ...]]:
        parts = tuple(sorted(tuple(sorted(_route_order_ids(r))) for r in routes if r))
        return (len(parts), parts)

    def _record_best(candidate: FleetOptimizationResponse) -> bool:
        nonlocal best, incumbent_key, incumbent_routes
        if candidate is best:
            return False
        chosen = optimizer._best_audited_response([best, candidate])
        if chosen is not candidate:
            return False
        best = candidate
        incumbent_key = _response_rank_key(best)
        maybe_routes = optimizer._routes_from_audited_response(best)
        if maybe_routes is not None:
            incumbent_routes = maybe_routes
        _emit_improve(best)
        return True

    def _fleet_is_heterogeneous() -> bool:
        by_day: Dict[int, Set[Tuple[float, float, float, int, int]]] = {}
        for v in optimizer.vehicles:
            if not optimizer._vehicle_has_compatible_driver(v):
                continue
            by_day.setdefault(v.service_day_index, set()).add(
                (
                    round(float(v.fixed_operating_cost_vnd or 0.0), 2),
                    round(float(v.fuel_consumption_liters_per_100_km or 0.0), 2),
                    round(float(v.payload_limit_kg), 2),
                    int(v.length_cm),
                    int(v.width_cm),
                )
            )
        return any(len(profiles) > 1 for profiles in by_day.values())

    has_hetero_fleet = _fleet_is_heterogeneous()

    def _try_hetero_vehicle_reopt(*, max_share: float = 0.25) -> None:
        if not has_hetero_fleet or best.unassigned_orders:
            return
        rem_now = deadline - time.perf_counter()
        if rem_now <= 0.18:
            return
        veh_slice = min(total_polish_budget * 0.15, max(rem_now * 0.08, rem_now * max_share))
        veh_dl = min(deadline - 0.08, time.perf_counter() + veh_slice)
        reassigned = bounded_optimize_production_vehicles(
            optimizer, incumbent_routes, [], veh_dl
        )
        if reassigned is not None:
            _try_accept_routes(reassigned[1], [], run_vehicle_opt=False)

    def _run_local_stop_polish(budget_share: float, *, max_cap_sec: Optional[float] = None) -> bool:
        cur_sig = _plan_signature(incumbent_routes)
        rem_t = deadline - time.perf_counter()
        guard = min(0.12, max(0.05, rem_t * 0.10))
        if rem_t <= guard + 0.12:
            return False
        slice_sec = rem_t * budget_share
        if max_cap_sec is not None:
            slice_sec = min(slice_sec, max_cap_sec)
        planned_sec = max(0.15, slice_sec)
        if _can_skip_local_sig(last_polished_budget, cur_sig, planned_sec):
            return False
        local_deadline = min(deadline - guard, time.perf_counter() + planned_sec)
        sub_best = optimizer._base_polish_audited_response(best, local_deadline)
        _record_local_sig_outcome(last_polished_budget, cur_sig, local_deadline, planned_sec)
        if _record_best(sub_best):
            _try_hetero_vehicle_reopt(max_share=0.22)
            return True
        return False

    def _run_intra_cost_polish(budget_share: float, *, max_cap_sec: Optional[float] = None) -> bool:
        if best.unassigned_orders:
            return False
        cur_sig = _plan_signature(incumbent_routes)
        rem_t = deadline - time.perf_counter()
        guard = min(0.12, max(0.05, rem_t * 0.10))
        if rem_t <= guard + 0.08:
            return False
        slice_sec = rem_t * budget_share
        if max_cap_sec is not None:
            slice_sec = min(slice_sec, max_cap_sec)
        planned_sec = max(0.12, slice_sec)
        if _can_skip_local_sig(last_intra_cost_budget, cur_sig, planned_sec):
            return False
        intra_deadline = min(deadline - guard, time.perf_counter() + planned_sec)
        intra_best = _with_layout_search(
            optimizer.request.demo_stacking is not None,
            lambda: intra_route_cost_polish(
                optimizer, best, intra_deadline, on_improve=_emit_improve
            ),
        )
        _record_local_sig_outcome(last_intra_cost_budget, cur_sig, intra_deadline, planned_sec)
        if _record_best(intra_best):
            _try_hetero_vehicle_reopt(max_share=0.22)
            return True
        return False

    def _run_cross_exchange(budget_share: float, *, max_cap_sec: Optional[float] = None) -> bool:
        if best.unassigned_orders:
            return False
        cur_sig = _plan_signature(incumbent_routes)
        rem_t = deadline - time.perf_counter()
        guard = min(0.12, max(0.05, rem_t * 0.10))
        if rem_t <= guard + 0.12:
            return False
        slice_sec = rem_t * budget_share
        if max_cap_sec is not None:
            slice_sec = min(slice_sec, max_cap_sec)
        planned_sec = max(0.18, slice_sec)
        if _can_skip_local_sig(last_exchanged_budget, cur_sig, planned_sec):
            return False
        ex_deadline = min(deadline - guard, time.perf_counter() + planned_sec)
        ex_best = _with_layout_search(
            optimizer.request.demo_stacking is not None,
            lambda: _try_cross_route_order_exchange(
                optimizer, best, ex_deadline, on_improve=_emit_improve
            ),
        )
        _record_local_sig_outcome(last_exchanged_budget, cur_sig, ex_deadline, planned_sec)
        if _record_best(ex_best):
            _try_hetero_vehicle_reopt(max_share=0.30)
            return True
        return False

    def _try_accept_routes(
        cand_routes: List[List[ScheduledStop]],
        unassigned_ids: List[str],
        *,
        run_vehicle_opt: bool = True,
    ) -> bool:
        now_t = time.perf_counter()
        if now_t >= deadline:
            return False
        rem_polish = deadline - now_t
        reduced_routes = sum(bool(r) for r in cand_routes) < sum(bool(r) for r in incumbent_routes)
        if run_vehicle_opt and not reduced_routes and not unassigned_ids and rem_polish > 0.25:
            veh_slice = max(0.35, min(2.0, rem_polish * 0.30))
            veh_deadline = min(deadline - 0.12, now_t + veh_slice)
            reassigned = bounded_optimize_production_vehicles(
                optimizer, cand_routes, [], veh_deadline
            )
            if reassigned is not None:
                cand_routes = reassigned[1]
        cand_rank = optimizer._rank_candidate_for_audit(cand_routes, unassigned_ids)
        if cand_rank >= incumbent_key:
            return False
        remaining = _audit_budget_remaining(optimizer, deadline - time.perf_counter())
        if remaining <= 0.10:
            return False
        audited = optimizer._build_final_response(
            cand_routes, unassigned_ids, include_benchmarks=False,
            spatial_time_budget_seconds=remaining,
        )
        saved = _record_best(audited)
        # Audit & record route-count drops immediately before optional vehicle tuning,
        # so multi-step consolidation breakthroughs are never lost to tight sub-deadlines.
        if saved and reduced_routes and run_vehicle_opt and not unassigned_ids:
            rem_after = deadline - time.perf_counter()
            if rem_after > 0.35:
                veh_deadline = min(deadline - 0.12, time.perf_counter() + min(0.85, rem_after * 0.25))
                reassigned = bounded_optimize_production_vehicles(
                    optimizer, incumbent_routes, [], veh_deadline
                )
                if reassigned is not None:
                    tuned_rank = optimizer._rank_candidate_for_audit(reassigned[1], [])
                    rem_tune = _audit_budget_remaining(optimizer, deadline - time.perf_counter())
                    if tuned_rank < incumbent_key and rem_tune > 0.10:
                        tuned_audited = optimizer._build_final_response(
                            reassigned[1], [], include_benchmarks=False,
                            spatial_time_budget_seconds=rem_tune,
                        )
                        _record_best(tuned_audited)
        return saved

    def _run_consolidation(source_routes: List[List[ScheduledStop]], step_deadline: float) -> bool:
        nonlocal last_consolidated_sig
        if sum(bool(r) for r in source_routes) <= max(1, min_routes_lb):
            return False
        src_sig = _plan_signature(source_routes)
        part_sig = _partition_sig(source_routes)
        step_budget = max(0.0, step_deadline - time.perf_counter())
        prev_budget = failed_consolidation_budgets.get(part_sig)
        if prev_budget is not None and step_budget <= prev_budget * 1.15:
            return False
        consolidated = _with_layout_search(
            True,
            lambda: consolidate_with_vehicle_upgrade(
                optimizer,
                source_routes,
                step_deadline,
                max_steps=1,
                min_routes_lb=min_routes_lb,
                skip_vehicle_opt=True,
            ),
        )
        if src_sig == _plan_signature(incumbent_routes):
            last_consolidated_sig = src_sig
        if consolidated is not None:
            return _try_accept_routes(consolidated, [], run_vehicle_opt=True)
        if time.perf_counter() + 0.02 < step_deadline:
            failed_consolidation_budgets[part_sig] = float("inf")
        else:
            failed_consolidation_budgets[part_sig] = max(prev_budget or 0.0, step_budget)
        k_active = sum(bool(r) for r in source_routes)
        failed_route_count_cons[k_active] = max(failed_route_count_cons.get(k_active, 0.0), step_budget)
        return False

    # 1. Try heterogeneous-fleet route consolidation first (dropping a full route dominates
    #    same-count swaps), one drop at a time so each reduction is audited & published.
    total_orders = len(optimizer.orders)
    has_stacking_policy = optimizer.request.demo_stacking is not None
    now_t = time.perf_counter()
    rem_cons = deadline - now_t
    total_polish_budget = max(0.5, rem_cons)
    cons_guard = rem_cons * 0.10
    cons_improved = False
    was_partial_at_start = bool(best.unassigned_orders)
    cons_attempted_on_complete = False
    if (
        not best.unassigned_orders
        and sum(bool(r) for r in incumbent_routes) > max(1, min_routes_lb)
        and rem_cons > cons_guard
    ):
        cons_attempted_on_complete = True
        first_share = 0.28 if has_stacking_policy else 0.36
        cons_deadline = min(deadline - cons_guard, now_t + rem_cons * first_share)
        while (
            not best.unassigned_orders
            and sum(bool(r) for r in incumbent_routes) > max(1, min_routes_lb)
            and time.perf_counter() + 0.05 < cons_deadline
        ):
            if not _run_consolidation(incumbent_routes, cons_deadline):
                break
            cons_improved = True
            rem_loop = deadline - time.perf_counter()
            cons_deadline = min(deadline - cons_guard, time.perf_counter() + rem_loop * 0.45)
    if (
        not cons_improved
        and not best.unassigned_orders
        and time.perf_counter() < deadline - total_polish_budget * 0.08
    ):
        _try_accept_routes(incumbent_routes, [], run_vehicle_opt=True)

    # 2. Run stop/pair/route local polish + cost-aware intra polish + cross-route exchange,
    #    preserving >= 30% of polish budget for multi-basin LNS whenever N > 2.
    step3_reserve = (total_polish_budget * 0.30) if total_orders > 2 else 0.0
    step2_end = deadline - step3_reserve
    step2_min_slice = max(0.08, total_polish_budget * 0.03)
    def _step2_cap(frac: float) -> float:
        return min(total_polish_budget * frac, max(0.0, step2_end - time.perf_counter()))

    if time.perf_counter() + step2_min_slice < step2_end:
        _run_local_stop_polish(0.24, max_cap_sec=_step2_cap(0.10))
    if time.perf_counter() + step2_min_slice < step2_end:
        _run_intra_cost_polish(0.20, max_cap_sec=_step2_cap(0.09))
    if (
        time.perf_counter() + step2_min_slice < step2_end
        and _run_cross_exchange(0.58, max_cap_sec=_step2_cap(0.28))
    ):
        if time.perf_counter() + step2_min_slice < step2_end:
            _run_local_stop_polish(0.22, max_cap_sec=_step2_cap(0.08))
        if time.perf_counter() + step2_min_slice < step2_end:
            _run_intra_cost_polish(0.18, max_cap_sec=_step2_cap(0.07))

    # 3. Anytime multi-basin VNS/LNS ruin-and-recreate using remaining spare time.
    if total_orders <= 2 and not best.unassigned_orders:
        return best

    lns_iter = 0
    cycle_stalls = 0
    restarts = 0
    cycle_limit = max(5, min(9, (total_orders + 1) // 2))
    max_restarts = 1 if total_orders <= 3 else None
    max_removable = max(1, total_orders - 1)
    min_rem = min(max_removable, max(2 if total_orders > 2 else 1, round(total_orders * 0.15)))
    max_rem = max(min_rem, min(max_removable, round(total_orders * 0.35)))
    stall_max_rem = max(max_rem, min(max_removable, round(total_orders * 0.50)))
    iter_guard = min(total_polish_budget * 0.05, max(0.04, (deadline - time.perf_counter()) * 0.04))
    lay_timeouts = 0
    anchor_routes = copy.deepcopy(incumbent_routes)
    destroy_ops = (
        optimizer._destroy_related,
        optimizer._destroy_cluster,
        optimizer._destroy_string,
        optimizer._destroy_worst,
    )
    kick_repairs = ("regret3", "regret2", "greedy")

    while time.perf_counter() + iter_guard < deadline:
        if cycle_stalls >= cycle_limit:
            restarts += 1
            if (max_restarts is not None and restarts > max_restarts) or (
                time.perf_counter() + iter_guard * 2.0 >= deadline
            ):
                break
            cur_active_cnt = sum(bool(r) for r in incumbent_routes)
            rem_esc = deadline - time.perf_counter()
            esc_slice = rem_esc * 0.35
            if (
                not best.unassigned_orders
                and cur_active_cnt > max(1, min_routes_lb)
                and esc_slice > failed_route_count_cons.get(cur_active_cnt, 0.0) * 1.15
                and rem_esc > iter_guard * 2.0
            ):
                esc_deadline = min(deadline - iter_guard, time.perf_counter() + esc_slice)
                if _plan_signature(incumbent_routes) != last_consolidated_sig:
                    if _run_consolidation(incumbent_routes, esc_deadline):
                        anchor_routes = copy.deepcopy(incumbent_routes)
                        cycle_stalls = 0
                        continue
                if _plan_signature(anchor_routes) != _plan_signature(incumbent_routes):
                    if _run_consolidation(anchor_routes, esc_deadline):
                        anchor_routes = copy.deepcopy(incumbent_routes)
                        cycle_stalls = 0
                        continue
            if not best.unassigned_orders:
                if _run_local_stop_polish(0.24, max_cap_sec=total_polish_budget * 0.14):
                    anchor_routes = copy.deepcopy(incumbent_routes)
                    cycle_stalls = 0
                    continue
                if _run_intra_cost_polish(0.20, max_cap_sec=total_polish_budget * 0.08):
                    anchor_routes = copy.deepcopy(incumbent_routes)
                    cycle_stalls = 0
                    continue
                if _run_cross_exchange(0.36, max_cap_sec=total_polish_budget * 0.20):
                    _run_local_stop_polish(0.20, max_cap_sec=total_polish_budget * 0.10)
                    anchor_routes = copy.deepcopy(incumbent_routes)
                    cycle_stalls = 0
                    continue

            # Diversified kick (threshold-accepting perturbation into another basin at <= active route count).
            kick_base = copy.deepcopy(incumbent_routes if restarts % 3 == 0 else anchor_routes)
            _, kick_missing = _served_and_missing(optimizer, kick_base)
            kick_rem = min(
                max_removable,
                max(min_rem + 1, round(total_orders * (0.35 if restarts % 2 else 0.48))),
            )
            destroy_fn = destroy_ops[restarts % len(destroy_ops)]
            destroyed_k, removed_k = destroy_fn(kick_base, kick_rem)
            pool_k = list(dict.fromkeys([*kick_missing, *removed_k]))
            rem_now = deadline - time.perf_counter()
            if pool_k and rem_now > iter_guard * 1.5:
                kick_deadline = min(deadline - iter_guard, time.perf_counter() + rem_now * 0.30)
                repair_k = kick_repairs[restarts % len(kick_repairs)]
                kick_use_layout = has_stacking_policy and lay_timeouts < 3
                kicked, failed_k = _with_layout_search(
                    kick_use_layout,
                    lambda: optimizer._repair(destroyed_k, pool_k, repair_k, kick_deadline),
                )
                if time.perf_counter() < deadline:
                    if not failed_k or (kick_missing and len(set(failed_k)) <= len(kick_missing)):
                        if _try_accept_routes(kicked, failed_k, run_vehicle_opt=not failed_k):
                            anchor_routes = copy.deepcopy(incumbent_routes)
                            cycle_stalls = 0
                            continue
                        inc_cost, _, _ = optimizer._evaluate_plan_cost(incumbent_routes, list(best_unassigned := [o.order_id for o in best.unassigned_orders]))
                        cand_cost, _, _ = optimizer._evaluate_plan_cost(kicked, failed_k)
                        if (
                            len(set(failed_k)) <= len(set(best_unassigned))
                            and sum(bool(r) for r in kicked) <= sum(bool(r) for r in incumbent_routes)
                            and cand_cost <= int(max(1, inc_cost) * 1.02)
                        ):
                            anchor_routes = kicked
                            cycle_stalls = 0
                            continue
            anchor_routes = copy.deepcopy(incumbent_routes)
            cycle_stalls = 0
            continue

        lns_iter += 1
        rem_lns = deadline - time.perf_counter()
        base_routes = copy.deepcopy(anchor_routes)
        active = [i for i, r in enumerate(base_routes) if r]
        if not active:
            break

        served_ids, missing_ids = _served_and_missing(optimizer, base_routes)
        stall_ratio = min(1.0, cycle_stalls / max(1, cycle_limit - 1))
        sweep_ratio = ((lns_iter - 1) % 4) / 3.0
        eff_ratio = max(stall_ratio, sweep_ratio)
        eff_max_rem = (
            stall_max_rem
            if (cycle_stalls >= max(1, cycle_limit // 3) or lns_iter % 4 in (0, 3))
            else max_rem
        )
        remove_count = min(len(served_ids), round(min_rem + (eff_max_rem - min_rem) * eff_ratio))
        use_layout = (
            has_stacking_policy
            and (
                (
                    lay_timeouts < 2
                    and (
                        lns_iter % 2 == 0
                        or remove_count <= max(2, round(total_orders * 0.25))
                    )
                )
                or (
                    lay_timeouts == 2
                    and lns_iter % 3 == 0
                    and remove_count <= max(2, round(total_orders * 0.30))
                )
            )
        )
        step_share = 0.18 if use_layout else 0.12
        step_budget = min(rem_lns * 0.45, total_polish_budget * step_share)
        step_deadline = min(deadline - iter_guard, time.perf_counter() + step_budget)

        op_kind = lns_iter % 5
        preserve_routes_excl = (
            _empty_vehicle_indices(base_routes)
            if (not missing_ids and lns_iter % 2 == 1)
            else None
        )
        if lns_iter == 1 and missing_ids:
            destroyed = base_routes
            removed = []
            repair_op = "regret2"
            excluded = None
        elif op_kind == 0 and not missing_ids and len(active) >= 2:
            destroyed, removed = optimizer._destroy_route(base_routes, remove_count)
            if (
                len(removed) < remove_count
                and ((lns_iter // 5) % 2 == 1 or cycle_stalls >= 1)
            ):
                destroyed, extra_rem = optimizer._destroy_related(
                    destroyed, remove_count - len(removed)
                )
                removed = list(dict.fromkeys([*removed, *extra_rem]))
            repair_op = "regret3" if (lns_iter // 5) % 2 == 0 else "regret2"
            base_part_check = failed_consolidation_budgets.get(_partition_sig(base_routes), 0.0)
            excluded = (
                _empty_vehicle_indices(destroyed)
                if len(active) > max(1, min_routes_lb)
                and base_part_check < float("inf")
                else preserve_routes_excl
            )
        elif op_kind == 1:
            destroyed, removed = optimizer._destroy_worst(base_routes, remove_count)
            repair_op = "regret3" if (lns_iter // 5) % 2 == 0 else "regret2"
            excluded = preserve_routes_excl
        elif op_kind == 2:
            destroyed, removed = optimizer._destroy_related(base_routes, remove_count)
            repair_op = "regret2" if (lns_iter // 5) % 2 == 0 else "regret3"
            excluded = preserve_routes_excl
        elif op_kind == 3:
            destroyed, removed = optimizer._destroy_string(base_routes, remove_count)
            repair_op = ("regret3", "regret2", "greedy")[(lns_iter // 5) % 3]
            excluded = preserve_routes_excl
        else:
            destroyed, removed = optimizer._destroy_cluster(base_routes, remove_count)
            repair_op = "regret3" if (lns_iter // 5) % 2 == 0 else "regret2"
            excluded = preserve_routes_excl

        repair_pool = list(dict.fromkeys([*missing_ids, *removed]))
        if not repair_pool:
            cycle_stalls += 1
            continue

        repaired, failed = _with_layout_search(
            use_layout,
            lambda: optimizer._repair(
                destroyed,
                repair_pool,
                repair_op,
                step_deadline,
                excluded_vehicle_indices=excluded,
            ),
        )
        if use_layout and failed and time.perf_counter() + 0.01 >= step_deadline:
            lay_timeouts += 1
        elif use_layout and not failed:
            lay_timeouts = 0
        # If forced route-elimination failed on active-only routes, try multi-route/vehicle-upgrade consolidation
        # only when this partition hasn't failed at >= budget and low-k route drops haven't already failed.
        base_part_sig = _partition_sig(base_routes)
        base_cons_budget = max(0.0, step_deadline - time.perf_counter())
        prev_base_budget = failed_consolidation_budgets.get(base_part_sig)
        k_cons_done = base_cons_budget <= failed_route_count_cons.get(len(active), 0.0) * 1.15
        if (
            failed
            and excluded is not None
            and not missing_ids
            and len(active) > max(1, min_routes_lb)
            and (
                not k_cons_done
                or (prev_base_budget is None and len(failed_consolidation_budgets) < 4)
            )
            and (
                prev_base_budget is None
                or (
                    prev_base_budget != float("inf")
                    and base_cons_budget > prev_base_budget * 1.15
                )
            )
            and time.perf_counter() + 0.08 < step_deadline
        ):
            upgraded = _with_layout_search(
                True,
                lambda: consolidate_with_vehicle_upgrade(
                    optimizer,
                    base_routes,
                    step_deadline,
                    max_steps=1,
                    min_routes_lb=min_routes_lb,
                    skip_vehicle_opt=True,
                ),
            )
            if upgraded is not None:
                repaired, failed = upgraded, []
            else:
                if time.perf_counter() < step_deadline - 0.03:
                    failed_consolidation_budgets[base_part_sig] = float("inf")
                else:
                    failed_consolidation_budgets[base_part_sig] = max(
                        prev_base_budget or 0.0, base_cons_budget
                    )
                failed_route_count_cons[len(active)] = max(
                    failed_route_count_cons.get(len(active), 0.0), base_cons_budget
                )

        if time.perf_counter() >= deadline:
            cycle_stalls += 1
            continue
        if (not missing_ids and failed) or (missing_ids and len(set(failed)) > len(missing_ids)):
            cycle_stalls += 1
            continue

        accepted = _try_accept_routes(
            repaired, failed, run_vehicle_opt=(not failed and lns_iter % 2 == 1)
        )
        if accepted:
            cycle_stalls = 0
            anchor_routes = copy.deepcopy(incumbent_routes)
            if total_orders <= 2 and not best.unassigned_orders:
                break
            if (
                was_partial_at_start
                and not cons_attempted_on_complete
                and not best.unassigned_orders
                and sum(bool(r) for r in incumbent_routes) > max(1, min_routes_lb)
                and (deadline - time.perf_counter()) > iter_guard * 4.0
            ):
                cons_attempted_on_complete = True
                rem_comp = deadline - time.perf_counter()
                _run_consolidation(
                    incumbent_routes,
                    min(deadline - iter_guard * 2.0, time.perf_counter() + rem_comp * 0.35),
                )
            if (
                not best.unassigned_orders
                and (deadline - time.perf_counter()) > iter_guard * 3.0
            ):
                _run_local_stop_polish(0.20, max_cap_sec=total_polish_budget * 0.10)
                _run_intra_cost_polish(0.15, max_cap_sec=total_polish_budget * 0.07)
                if _run_cross_exchange(0.28, max_cap_sec=total_polish_budget * 0.18):
                    _run_local_stop_polish(0.18, max_cap_sec=total_polish_budget * 0.08)
                    _run_intra_cost_polish(0.14, max_cap_sec=total_polish_budget * 0.06)
                anchor_routes = copy.deepcopy(incumbent_routes)
        else:
            cycle_stalls += 1

    if not best.unassigned_orders and time.perf_counter() + iter_guard < deadline:
        _run_local_stop_polish(0.50)
        _run_intra_cost_polish(0.40, max_cap_sec=total_polish_budget * 0.12)
        if time.perf_counter() + iter_guard < deadline and _run_cross_exchange(0.55, max_cap_sec=total_polish_budget * 0.25):
            _run_local_stop_polish(0.50, max_cap_sec=total_polish_budget * 0.15)
            _run_intra_cost_polish(0.45, max_cap_sec=total_polish_budget * 0.12)
    return best
