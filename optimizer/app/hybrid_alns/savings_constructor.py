"""Clarke-Wright parallel savings & physical-fleet-aware route constructor."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from ..interprovincial import location_identity, resolve_vehicle_end_node_index
from ..models import OrderPair, ScheduledStop
from ..stacking import effective_floor_capacity_cm2


@dataclass
class _Chain:
    chain_id: int
    order_ids: List[str]
    stops: List[ScheduledStop]
    day_index: int
    depot_id: str
    proto_v_idx: int
    peak_weight_kg: float
    total_weight_kg: float
    min_allowed_payload_kg: float
    route_end_sec: int


def _order_depot_travel_score(
    engine: Any,
    order: OrderPair,
    depot_v_idx: int,
) -> Tuple[float, float, float]:
    p_node, d_node = engine.order_node_indices[order.id]
    dist_m = engine.request.distance_matrix_meters
    end_idx = resolve_vehicle_end_node_index(
        engine.vehicles,
        engine.orders,
        depot_v_idx,
        engine.vehicles[depot_v_idx],
        getattr(engine, "_node_id_to_index", None),
    )
    return (
        float(dist_m[depot_v_idx][p_node]),
        float(dist_m[p_node][d_node]),
        0.0 if end_idx is None else float(dist_m[d_node][end_idx]),
    )


def _overlap_distance_m(
    dist_m: Sequence[Sequence[float]],
    depot_idx: int,
    p_a: int,
    d_a: int,
    p_b: int,
    d_b: int,
    end_idx: Optional[int] = -1,
) -> float:
    resolved_end = depot_idx if end_idx == -1 else end_idx
    tail_a = 0.0 if resolved_end is None else dist_m[d_a][resolved_end]
    tail_b = 0.0 if resolved_end is None else dist_m[d_b][resolved_end]
    return min(
        dist_m[depot_idx][p_a] + dist_m[p_a][p_b] + dist_m[p_b][d_a] + dist_m[d_a][d_b] + tail_b,
        dist_m[depot_idx][p_a] + dist_m[p_a][p_b] + dist_m[p_b][d_b] + dist_m[d_b][d_a] + tail_a,
        dist_m[depot_idx][p_b] + dist_m[p_b][p_a] + dist_m[p_a][d_b] + dist_m[d_b][d_a] + tail_a,
        dist_m[depot_idx][p_b] + dist_m[p_b][p_a] + dist_m[p_a][d_a] + dist_m[d_a][d_b] + tail_b,
    )


def _seed_lambdas(engine: Any) -> Tuple[float, float, bool]:
    variant = abs(int(getattr(engine, "random_seed", 0))) % 5
    if variant == 1:
        return 1.28, 1.15, True
    if variant == 2:
        return 0.94, 1.32, True
    if variant == 3:
        return 1.15, 1.05, True
    if variant == 4:
        return (
            engine.rng.uniform(0.92, 1.25),
            engine.rng.uniform(0.95, 1.30),
            variant % 2 == 0,
        )
    return 1.00, 1.05, True


def _chain_peak_weight_kg(engine: Any, stops: Sequence[ScheduledStop]) -> float:
    cur = 0.0
    peak = 0.0
    for st in stops:
        oid = st.allocation_id or st.order_id or ""
        delta = engine._order_weight_by_id.get(oid, 0.0)
        if st.stop_type == "PICKUP":
            cur += delta
            if cur > peak:
                peak = cur
        else:
            cur = max(0.0, cur - delta)
    return peak


def _vehicle_base_operating_score(engine: Any, v_idx: int) -> float:
    v = engine.vehicles[v_idx]
    return float(v.fixed_operating_cost_vnd) + float(v.fuel_consumption_liters_per_100_km) * 12_000.0


def build_savings_routes(
    engine: Any,
    vehicle_indices: Sequence[int],
    deadline: float,
) -> Tuple[List[List[ScheduledStop]], List[str]]:
    """Construct routes via parallel Clarke-Wright savings with physical-fleet reuse.

    Stage 1 seeds single-order chains on the most cost-effective prototype able to carry them.
    Stage 2 merges chains via sequential & multi-order corridor-overlap savings.
    Stage 3 places largest chains first onto physical trucks (reusing economical trucks across
    days when multi-day span is inevitable), reserving room for leftover insertion in Stage 4.
    """
    routes: List[List[ScheduledStop]] = [[] for _ in engine.vehicles]
    if not engine.orders or not vehicle_indices:
        return routes, [o.id for o in engine.orders]

    now = time.perf_counter()
    if now >= deadline:
        return routes, [o.id for o in engine.orders]

    vehicles_by_day: Dict[int, List[int]] = {}
    for v_idx in vehicle_indices:
        v = engine.vehicles[v_idx]
        if engine._vehicle_has_compatible_driver(v):
            vehicles_by_day.setdefault(v.service_day_index, []).append(v_idx)
    if not vehicles_by_day:
        return routes, [o.id for o in engine.orders]

    sorted_days = sorted(vehicles_by_day)
    protos_by_day: Dict[int, List[int]] = {}
    for d in sorted_days:
        vehicles_by_day[d].sort(
            key=lambda idx: (
                _vehicle_base_operating_score(engine, idx),
                -engine.vehicles[idx].payload_limit_kg,
                -(engine.vehicles[idx].length_cm * engine.vehicles[idx].width_cm),
            )
        )
        seen_proto: Set[Tuple[object, ...]] = set()
        protos: List[int] = []
        # Group economic fuel/cost tier first, breaking ties by largest payload/floor capacity for merging headroom.
        for idx in sorted(
            vehicles_by_day[d],
            key=lambda i: (
                round(engine.vehicles[i].fuel_consumption_liters_per_100_km / 2.0),
                round(engine.vehicles[i].fixed_operating_cost_vnd / 80_000.0),
                -engine.vehicles[i].payload_limit_kg,
                -(engine.vehicles[i].length_cm * engine.vehicles[i].width_cm),
            ),
        ):
            v = engine.vehicles[idx]
            end_depot = getattr(v, "end_depot", None)
            pkey = (
                v.depot.id,
                bool(getattr(v, "return_to_depot", True)),
                end_depot.id if end_depot is not None else None,
                v.payload_limit_kg,
                v.length_cm,
                v.width_cm,
                v.height_cm,
            )
            if pkey not in seen_proto:
                seen_proto.add(pkey)
                protos.append(idx)
        protos_by_day[d] = protos

    fit_cache: Dict[Tuple[str, Tuple[Any, ...]], bool] = {}
    dist_m = engine.request.distance_matrix_meters
    dur_s = engine.request.duration_matrix_seconds
    grace_sec = engine.policy.delivery_grace_days * 86_400
    order_areas = {
        o.id: sum(it.length_cm * it.width_cm for it in o.items)
        for o in engine.orders
    }

    total_budget = max(0.2, deadline - now)
    fit_deadline = min(deadline, now + min(2.0, max(0.35, total_budget * 0.14)))
    merge_deadline = min(deadline, now + min(2.4, max(0.55, total_budget * 0.24)))
    assign_deadline = min(deadline, now + min(3.4, max(0.75, total_budget * 0.34)))

    # 1. Seed each order onto its earliest feasible day & best capacity/cost prototype.
    chains: Dict[int, _Chain] = {}
    order_to_chain: Dict[str, int] = {}
    unassignable: List[str] = []
    ordered_input = sorted(
        engine.orders,
        key=lambda o: (
            o.pickup_window_end_sec // 86_400,
            min(o.delivery_window_end_sec, o.ordered_at_sec + grace_sec),
            o.pickup_window_end_sec,
            o.id,
        ),
    )
    for order in ordered_input:
        if time.perf_counter() >= fit_deadline:
            unassignable.append(order.id)
            continue
        p_tpl, d_tpl = engine._stop_templates_by_order_id[order.id]
        base_stops = [p_tpl.model_copy(), d_tpl.model_copy()]
        placed_chain = False
        w_o = engine._order_weight_by_id[order.id]
        for d in sorted_days:
            spatially_checked: Set[Tuple[Any, ...]] = set()
            for v_idx in protos_by_day[d]:
                v = engine.vehicles[v_idx]
                if not engine._order_allows_vehicle(order, v):
                    continue
                if w_o > v.payload_limit_kg + 0.01:
                    continue
                if not engine._can_schedule_stops(v_idx, base_stops):
                    continue
                if not engine._single_order_fits_vehicle_floor(
                    v_idx, order.id, base_stops, fit_deadline, spatially_checked, fit_cache=fit_cache
                ):
                    continue
                sched = engine._schedule_stops(v_idx, base_stops)
                if sched is None:
                    continue
                cid = len(chains)
                chains[cid] = _Chain(
                    chain_id=cid,
                    order_ids=[order.id],
                    stops=sched[0],
                    day_index=d,
                    depot_id=v.depot.id,
                    proto_v_idx=v_idx,
                    peak_weight_kg=w_o,
                    total_weight_kg=w_o,
                    min_allowed_payload_kg=w_o,
                    route_end_sec=int(sched[0][-1].departure_time_sec),
                )
                order_to_chain[order.id] = cid
                placed_chain = True
                break
            if placed_chain:
                break
        if not placed_chain:
            unassignable.append(order.id)

    # 2. Compute Clarke-Wright sequential and corridor-overlap edges per order separately.
    lambda_seq, lambda_ovl, prefer_overlap = _seed_lambdas(engine)
    edges: List[Tuple[float, str, str, str]] = []
    chains_by_day: Dict[int, List[_Chain]] = {}
    for ch in chains.values():
        chains_by_day.setdefault(ch.day_index, []).append(ch)

    seq_k = 14
    ovl_k = 18
    for _day_idx, day_chains in chains_by_day.items():
        if len(day_chains) < 2:
            continue
        for i_idx, ch_a in enumerate(day_chains):
            oid_a = ch_a.order_ids[0]
            ord_a = engine.order_by_id[oid_a]
            dep_a = ch_a.proto_v_idx
            p_a, d_a = engine.order_node_indices[oid_a]
            dep_to_pa, pa_to_da, da_to_dep = _order_depot_travel_score(engine, ord_a, dep_a)
            veh_a = engine.vehicles[dep_a]
            max_area_a = effective_floor_capacity_cm2(veh_a, engine.request.demo_stacking)
            earl_pa = max(ord_a.pickup_window_start_sec, veh_a.available_start_sec)
            finish_da = ch_a.route_end_sec
            w_a = ch_a.total_weight_kg
            area_a = order_areas[oid_a]

            local_seq: List[Tuple[float, str, str, str]] = []
            local_ovl: List[Tuple[float, str, str, str]] = []
            for j_idx, ch_b in enumerate(day_chains):
                if i_idx == j_idx:
                    continue
                oid_b = ch_b.order_ids[0]
                ord_b = engine.order_by_id[oid_b]
                dep_b = ch_b.proto_v_idx
                p_b, d_b = engine.order_node_indices[oid_b]
                dep_to_pb, pb_to_db, _ = _order_depot_travel_score(engine, ord_b, dep_b)
                veh_b = engine.vehicles[dep_b]
                w_b = ch_b.total_weight_kg

                if finish_da + dur_s[d_a][p_b] <= ord_b.pickup_window_end_sec:
                    s_ab = (da_to_dep + dep_to_pb) - lambda_seq * float(dist_m[d_a][p_b])
                    if s_ab > 0:
                        local_seq.append((s_ab, "seq", oid_a, oid_b))

                area_mult = 2.4 if engine.request.demo_stacking is not None else 1.05
                if (
                    i_idx < j_idx
                    and w_a + w_b <= max(veh_a.payload_limit_kg, veh_b.payload_limit_kg) + 1e-6
                    and area_a + order_areas[oid_b] <= max_area_a * area_mult + 1.0
                ):
                    earl_pb = max(ord_b.pickup_window_start_sec, veh_b.available_start_sec)
                    if earl_pa <= ord_b.delivery_window_end_sec and earl_pb <= ord_a.delivery_window_end_sec:
                        _, _, db_to_dep = _order_depot_travel_score(engine, ord_b, dep_b)
                        end_a = resolve_vehicle_end_node_index(
                            engine.vehicles,
                            engine.orders,
                            dep_a,
                            veh_a,
                            getattr(engine, "_node_id_to_index", None),
                        )
                        sep_dist = dep_to_pa + pa_to_da + da_to_dep + dep_to_pb + pb_to_db + db_to_dep
                        ovl_dist = _overlap_distance_m(dist_m, dep_a, p_a, d_a, p_b, d_b, end_idx=end_a)
                        s_ovl = sep_dist - lambda_ovl * ovl_dist
                        if s_ovl > 0:
                            local_ovl.append((s_ovl * (1.18 if prefer_overlap else 0.92), "ovl", oid_a, oid_b))
            local_seq.sort(key=lambda e: e[0], reverse=True)
            local_ovl.sort(key=lambda e: e[0], reverse=True)
            edges.extend(local_seq[:seq_k])
            edges.extend(local_ovl[:ovl_k])

    edges.sort(key=lambda e: e[0], reverse=True)
    max_orders_per_chain = 14

    def _find_common_proto(day_idx: int, orders_in_chain: List[OrderPair], peak_w: float) -> Optional[int]:
        for cand_v in protos_by_day[day_idx]:
            v = engine.vehicles[cand_v]
            if peak_w > v.payload_limit_kg + 0.01:
                continue
            if all(engine._order_allows_vehicle(o, v) for o in orders_in_chain):
                return cand_v
        return None

    ovl_checks = 0
    max_ovl_checks = max(180, len(engine.orders) * 2)

    for _, kind, oid_a, oid_b in edges:
        if time.perf_counter() >= merge_deadline:
            break
        cid_a = order_to_chain.get(oid_a)
        cid_b = order_to_chain.get(oid_b)
        if cid_a is None or cid_b is None or cid_a == cid_b:
            continue
        ch_a = chains.get(cid_a)
        ch_b = chains.get(cid_b)
        if ch_a is None or ch_b is None:
            continue
        if len(ch_a.order_ids) + len(ch_b.order_ids) > max_orders_per_chain:
            continue

        if kind == "seq":
            if ch_a.order_ids[-1] != oid_a or ch_b.order_ids[0] != oid_b:
                continue
            last_node_a = engine.order_node_indices[ch_a.order_ids[-1]][1]
            first_node_b = engine.order_node_indices[ch_b.order_ids[0]][0]
            first_ord_b = engine.order_by_id[ch_b.order_ids[0]]
            if ch_a.route_end_sec + dur_s[last_node_a][first_node_b] > first_ord_b.pickup_window_end_sec:
                continue
            combined_orders = [engine.order_by_id[oid] for oid in ch_a.order_ids + ch_b.order_ids]
            peak_w = max(ch_a.peak_weight_kg, ch_b.peak_weight_kg)
            common_v = _find_common_proto(ch_a.day_index, combined_orders, peak_w)
            if common_v is None:
                continue
            merged_stops = ch_a.stops + ch_b.stops
            sched = engine._schedule_stops(common_v, merged_stops)
            if sched is None:
                continue
            if common_v != ch_a.proto_v_idx or common_v != ch_b.proto_v_idx:
                if not engine._validate_stops_cached(common_v, sched[0]):
                    continue
            ch_a.order_ids.extend(ch_b.order_ids)
            ch_a.stops = sched[0]
            ch_a.proto_v_idx = common_v
            ch_a.peak_weight_kg = peak_w
            ch_a.total_weight_kg += ch_b.total_weight_kg
            ch_a.route_end_sec = int(sched[0][-1].departure_time_sec)
            for oid in ch_b.order_ids:
                order_to_chain[oid] = cid_a
            chains.pop(cid_b, None)
        elif ovl_checks < max_ovl_checks:
            # Allow multi-order chains to absorb small overlapping chains (1..3 orders).
            if len(ch_b.order_ids) > len(ch_a.order_ids):
                ch_a, ch_b = ch_b, ch_a
                oid_a, oid_b = oid_b, oid_a
            if len(ch_b.order_ids) > 3:
                continue
            combined_orders = [engine.order_by_id[oid] for oid in ch_a.order_ids + ch_b.order_ids]
            combined_w = ch_a.peak_weight_kg + ch_b.peak_weight_kg
            common_v = _find_common_proto(ch_a.day_index, combined_orders, combined_w)
            if common_v is None:
                continue
            ovl_checks += 1

            cur_stops = list(ch_a.stops)
            base_dist = (
                engine._calc_route_distance_km(common_v, ch_a.stops)
                + engine._calc_route_distance_km(common_v, ch_b.stops)
            )
            anchor_p = next(
                (i for i, st in enumerate(cur_stops) if st.stop_type == "PICKUP" and (st.allocation_id or st.order_id) == oid_a),
                max(0, len(cur_stops) - 2),
            )
            merged_ok = True
            for absorb_oid in ch_b.order_ids:
                ord_abs = engine.order_by_id[absorb_oid]
                max_d = len(cur_stops) + 1
                best_step: Optional[Tuple[float, int, List[ScheduledStop]]] = None
                p_candidates = sorted({pos for pos in (anchor_p, anchor_p + 1) if 0 <= pos <= len(cur_stops)})
                for p_pos in p_candidates:
                    for d_pos in sorted({p_pos + 1, min(max_d, p_pos + 2), max_d}):
                        if not (p_pos + 1 <= d_pos <= max_d):
                            continue
                        ok, cand_stops = engine._can_insert_order(
                            common_v, cur_stops, ord_abs, p_pos, d_pos, check_packing=False
                        )
                        if not ok:
                            continue
                        cand_dist = engine._calc_route_distance_km(common_v, cand_stops)
                        if best_step is None or cand_dist < best_step[0]:
                            best_step = (cand_dist, p_pos, cand_stops)
                if best_step is None:
                    merged_ok = False
                    break
                cur_stops = best_step[2]
                anchor_p = best_step[1]

            if not merged_ok:
                continue
            final_dist = engine._calc_route_distance_km(common_v, cur_stops)
            if final_dist >= base_dist - 0.15:
                continue
            seg = engine._extract_active_cycle(cur_stops, max(0, min(anchor_p, len(cur_stops) - 1)))
            if not engine._segment_fits_floor_bound(common_v, seg):
                continue
            sched = engine._schedule_stops(common_v, cur_stops)
            if sched is not None and engine._validate_stops_cached(common_v, sched[0]):
                ch_a.order_ids.extend(ch_b.order_ids)
                ch_a.stops = sched[0]
                ch_a.proto_v_idx = common_v
                ch_a.peak_weight_kg = _chain_peak_weight_kg(engine, sched[0])
                ch_a.total_weight_kg += ch_b.total_weight_kg
                ch_a.route_end_sec = int(sched[0][-1].departure_time_sec)
                for oid in ch_b.order_ids:
                    order_to_chain[oid] = ch_a.chain_id
                chains.pop(ch_b.chain_id, None)

    # 3. Assign largest chains first onto physical trucks, avoiding costly gas-guzzlers when multi-day is forced.
    route_limit = engine.request.policy.max_routes_per_day
    routes_by_day: Dict[int, int] = {}
    used_physical_vehicles: Set[str] = set()
    leftover_orders: List[str] = list(unassignable)

    all_chains = sorted(
        chains.values(),
        key=lambda c: (
            -len(c.order_ids),
            c.day_index,
            -c.total_weight_kg,
        ),
    )
    first_day = sorted_days[0]
    first_day_cap = len(vehicles_by_day[first_day])
    if route_limit is not None:
        first_day_cap = min(first_day_cap, route_limit)
    multi_day_forced = len(sorted_days) > 1 and len(all_chains) > first_day_cap

    def _assign_chain(ch: _Chain) -> bool:
        ch_orders = [engine.order_by_id[oid] for oid in ch.order_ids]
        chain_weight = max(
            _chain_peak_weight_kg(engine, ch.stops),
            max((engine._order_weight_by_id[oid] for oid in ch.order_ids), default=0.0),
        )
        candidate_days = (
            [d for d in sorted_days if d <= ch.day_index + 1]
            if multi_day_forced
            else [d for d in sorted_days if d >= ch.day_index]
        )
        if not candidate_days:
            candidate_days = list(sorted_days)

        depot_dist_cache: Dict[str, float] = {}
        candidates: List[Tuple[int, float, int, float, int]] = []
        for target_day in candidate_days:
            if route_limit is not None and routes_by_day.get(target_day, 0) >= route_limit:
                continue
            for v_idx in vehicles_by_day.get(target_day, []):
                if routes[v_idx]:
                    continue
                v = engine.vehicles[v_idx]
                if chain_weight > v.payload_limit_kg + 0.01:
                    continue
                if not all(engine._order_allows_vehicle(o, v) for o in ch_orders):
                    continue
                phys_id = v.source_vehicle_id or v.id
                reuse_priority = 0 if (phys_id in used_physical_vehicles or target_day == first_day) else 1
                dist_key = (
                    v.depot.id,
                    getattr(v, "return_to_depot", True),
                    location_identity(v.end_depot) if v.end_depot is not None else None,
                )
                dist_km = depot_dist_cache.get(dist_key)
                if dist_km is None:
                    dist_km = engine._calc_route_distance_km(v_idx, ch.stops)
                    depot_dist_cache[dist_key] = dist_km
                est_cost = (
                    v.fixed_operating_cost_vnd
                    + (v.fuel_consumption_liters_per_100_km / 100.0) * dist_km * engine.policy.fuel_price_per_liter_vnd
                )
                candidates.append(
                    (
                        0 if multi_day_forced else target_day,
                        est_cost + (0.0 if phys_id in used_physical_vehicles else 140_000.0),
                        reuse_priority,
                        -v.payload_limit_kg,
                        v_idx,
                    )
                )
        candidates.sort()
        failed_profiles: Set[Tuple[object, ...]] = set()
        for _, _, _, _, v_idx in candidates:
            if time.perf_counter() >= assign_deadline:
                return False
            v = engine.vehicles[v_idx]
            profile = (v.service_day_index, v.depot.id, v.payload_limit_kg, v.length_cm, v.width_cm, v.height_cm, v.available_start_sec, v.available_end_sec)
            if profile in failed_profiles:
                continue
            sched = engine._schedule_stops(v_idx, ch.stops)
            if sched is None or not engine._validate_stops_cached(v_idx, sched[0]):
                failed_profiles.add(profile)
                continue
            routes[v_idx] = sched[0]
            target_day = v.service_day_index
            routes_by_day[target_day] = routes_by_day.get(target_day, 0) + 1
            used_physical_vehicles.add(v.source_vehicle_id or v.id)
            return True
        return False

    total_day01_slots = sum(
        min(len(vehicles_by_day[d]), route_limit) if route_limit is not None else len(vehicles_by_day[d])
        for d in sorted_days[:2]
    )
    assigned_routes_count = 0
    for ch in all_chains:
        # Defer all singletons when consolidated multi-order chains exist so Stage 4 packs them into active routes first.
        if len(ch.order_ids) == 1 and assigned_routes_count >= 1:
            leftover_orders.extend(ch.order_ids)
            continue
        if time.perf_counter() >= assign_deadline or not _assign_chain(ch):
            leftover_orders.extend(ch.order_ids)
        else:
            assigned_routes_count += 1

    # 4. Delegate remaining singletons to active-cycle overlap/tail insertion with cross-day economical truck reuse.
    if leftover_orders and time.perf_counter() < deadline:
        leftover_set = set(leftover_orders)
        ordered_leftover = [o for o in engine._ordered_seed_orders() if o.id in leftover_set]
        seen_leftover = {o.id for o in ordered_leftover}
        for oid in leftover_orders:
            if oid not in seen_leftover:
                ordered_leftover.append(engine.order_by_id[oid])
        missing = engine._append_delivery_cycles(
            routes,
            vehicle_indices,
            deadline,
            allow_overlap=True,
            orders_override=ordered_leftover,
            cross_day_economy=True,
        )
        return routes, missing

    assigned_set = set(engine._assigned_order_ids(routes))
    missing = [o.id for o in engine.orders if o.id not in assigned_set]
    return routes, missing
