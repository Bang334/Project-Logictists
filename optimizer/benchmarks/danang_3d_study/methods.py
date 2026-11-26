"""Alternative 3D-aware VRP/PDPTW algorithms evaluated under the same production 3D validator and objective."""
import time
from typing import Dict, List, Optional, Sequence, Tuple

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import FleetOptimizationRequest, FleetOptimizationResponse, ScheduledStop
from app.ortools_seed import extract_ortools_seed_pool
from app.planning_objective import apply_planning_objective
from app.stacking import effective_floor_capacity_cm2


def summarize_response(name: str, resp: FleetOptimizationResponse, elapsed_sec: float) -> Dict[str, object]:
    peaks: List[int] = []
    all_3d_valid = True
    total_dist = 0.0
    for r in resp.routes:
        if not r.spatial_validation.is_valid:
            all_3d_valid = False
        total_dist += float(r.total_distance_km)
        on = set()
        mx = 0
        for s in r.stops:
            oid = s.allocation_id or s.order_id or ""
            if s.stop_type == "PICKUP":
                on.add(oid)
            else:
                on.discard(oid)
            mx = max(mx, len(on))
        peaks.append(mx)

    obj = resp.planning_objective
    return {
        "method": name,
        "status": resp.status,
        "elapsed_sec": round(elapsed_sec, 2),
        "served_orders": len(resp.routes) and (150 - len(resp.unassigned_orders)) or 0,
        "unassigned_orders": len(resp.unassigned_orders),
        "routes": len(resp.routes),
        "span_days": obj.planning_span_days if obj else None,
        "physical_vehicles": obj.physical_vehicle_count if obj else None,
        "total_distance_km": round(total_dist, 2),
        "operating_cost_vnd": obj.operating_cost_vnd if obj else None,
        "driver_idle_salary_vnd": obj.driver_idle_salary_allocation_vnd if obj else None,
        "late_penalty_vnd": obj.operational_late_penalty_vnd if obj else None,
        "selection_score_vnd": obj.selection_score_vnd if obj else None,
        "peaks_gt_1": sum(1 for p in peaks if p > 1),
        "max_peak": max(peaks, default=0),
        "all_3d_valid": all_3d_valid,
    }


def run_prod_hybrid_alns(request: FleetOptimizationRequest, budget_sec: float) -> Tuple[FleetOptimizationResponse, float]:
    t0 = time.perf_counter()
    eng = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=budget_sec, should_split_orders=False, include_benchmarks=False
    )
    resp = eng.solve()
    apply_planning_objective(request, resp)
    return resp, time.perf_counter() - t0


def run_ortools_pdptw_repair(request: FleetOptimizationRequest, budget_sec: float) -> Tuple[FleetOptimizationResponse, float]:
    t0 = time.perf_counter()
    seed_pool, _ = extract_ortools_seed_pool(
        request,
        routing_seconds=min(6.0, budget_sec * 0.45),
        stagnation_seconds=1.2,
        should_split_orders=False,
    )
    remaining = max(2.0, budget_sec - (time.perf_counter() - t0))
    eng = PackingAwareHybridALNSOptimizer(
        request,
        time_budget_seconds=remaining,
        ortools_seed_pool=seed_pool,
        should_split_orders=False,
        include_benchmarks=False,
    )
    resp = eng.solve()
    apply_planning_objective(request, resp)
    return resp, time.perf_counter() - t0


def _order_floor_area(order) -> float:
    return sum(item.length_cm * item.width_cm for item in order.items)


def _route_peak_floor_ok(
    eng: PackingAwareHybridALNSOptimizer, v_idx: int, stops: List[ScheduledStop]
) -> bool:
    max_area = effective_floor_capacity_cm2(eng.vehicles[v_idx], eng.request.demo_stacking)
    area = 0.0
    for st in stops:
        oid = st.allocation_id or st.order_id or ""
        order = eng.order_by_id.get(oid)
        if order is None:
            continue
        oa = _order_floor_area(order)
        if st.stop_type == "PICKUP":
            area += oa
            if area > max_area + 1.0:
                return False
        else:
            area = max(0.0, area - oa)
    return True


def run_cross_route_savings_3d(request: FleetOptimizationRequest, budget_sec: float) -> Tuple[FleetOptimizationResponse, float]:
    """Build multi-order bundles across orders using Clarke-Wright savings + 3D verification."""
    t0 = time.perf_counter()
    deadline = t0 + budget_sec * 0.65
    eng = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=budget_sec, should_split_orders=False, include_benchmarks=False
    )
    routes: List[List[ScheduledStop]] = [[] for _ in eng.vehicles]
    missing = eng._append_delivery_cycles(routes, list(range(len(eng.vehicles))), deadline)

    # Extract individual cycles (each initially 1 order) and try merging cycles across routes
    dist_mat = request.distance_matrix_meters
    cycles: List[Tuple[int, List[ScheduledStop]]] = []
    for v_idx, rt in enumerate(routes):
        for i in range(0, len(rt), 2):
            if i + 1 < len(rt):
                cycles.append((v_idx, rt[i : i + 2]))

    # Compute pairwise savings between single-order cycles based on pickup/delivery proximity
    pairs: List[Tuple[float, int, int]] = []
    for a in range(len(cycles)):
        va, ca = cycles[a]
        oa = eng.order_by_id[ca[0].allocation_id or ca[0].order_id]
        pa, da = eng.order_node_indices[oa.id]
        direct_a = dist_mat[va][pa] + dist_mat[pa][da] + dist_mat[da][va]
        for b in range(a + 1, len(cycles)):
            vb, cb = cycles[b]
            ob = eng.order_by_id[cb[0].allocation_id or cb[0].order_id]
            pb, db = eng.order_node_indices[ob.id]
            if va != vb and eng.vehicles[va].service_day_index != eng.vehicles[vb].service_day_index:
                continue
            # Combined LIFO or FIFO cost estimate
            combo_1 = dist_mat[va][pa] + dist_mat[pa][pb] + dist_mat[pb][db] + dist_mat[db][da] + dist_mat[da][va]
            combo_2 = dist_mat[va][pa] + dist_mat[pa][pb] + dist_mat[pb][da] + dist_mat[da][db] + dist_mat[db][va]
            best_combo = min(combo_1, combo_2)
            direct_b = dist_mat[vb][pb] + dist_mat[pb][db] + dist_mat[db][vb]
            saving = (direct_a + direct_b) - best_combo
            if saving > 500:
                pairs.append((saving, a, b))
    pairs.sort(reverse=True)

    # Apply cross-route merges directly on routes when feasible in time & 3D packing
    order_to_route: Dict[str, int] = {}
    for v_idx, rt in enumerate(routes):
        for st in rt:
            if st.stop_type == "PICKUP":
                order_to_route[st.allocation_id or st.order_id] = v_idx

    for _, a, b in pairs:
        if time.perf_counter() >= deadline:
            break
        oa_id = cycles[a][1][0].allocation_id or cycles[a][1][0].order_id
        ob_id = cycles[b][1][0].allocation_id or cycles[b][1][0].order_id
        ra_idx = order_to_route.get(oa_id)
        rb_idx = order_to_route.get(ob_id)
        if ra_idx is None or rb_idx is None:
            continue
        ob = eng.order_by_id[ob_id]
        # Try moving ob onto ra_idx right after oa's pickup
        rt_a = routes[ra_idx]
        p_anchor = next(
            (i for i, s in enumerate(rt_a) if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id) == oa_id),
            None,
        )
        if p_anchor is None:
            continue
        base_a = [s for s in rt_a if (s.allocation_id or s.order_id) != ob_id] if ra_idx == rb_idx else list(rt_a)
        first_del = next((i for i in range(p_anchor + 1, len(base_a)) if base_a[i].stop_type == "DELIVERY"), len(base_a))
        merged_ok = False
        for d_pos in (p_anchor + 2, first_del + 1, first_del + 2):
            if d_pos > len(base_a) + 1 or d_pos <= p_anchor + 1:
                continue
            ok, cand = eng._can_insert_order(ra_idx, base_a, ob, p_anchor + 1, d_pos, check_packing=False)
            if not ok:
                continue
            sched = eng._schedule_stops(ra_idx, cand)
            if sched is None:
                continue
            cand = sched[0]
            seg = eng._extract_active_cycle(cand, p_anchor + 1)
            if not _route_peak_floor_ok(eng, ra_idx, seg):
                continue
            if eng._validate_stops_cached(ra_idx, seg) or eng._validate_exact_route(
                ra_idx, seg, min(0.06, deadline - time.perf_counter())
            ):
                routes[ra_idx] = cand
                if ra_idx != rb_idx:
                    routes[rb_idx] = [s for s in routes[rb_idx] if (s.allocation_id or s.order_id) != ob_id]
                    order_to_route[ob_id] = ra_idx
                merged_ok = True
                break
        if merged_ok:
            continue

    routes = eng._consolidate_delivery_cycles(routes, missing, deadline)
    audit_budget = max(3.0, budget_sec - (time.perf_counter() - t0))
    resp = eng._build_final_response(routes, missing, include_benchmarks=False, spatial_time_budget_seconds=audit_budget)
    apply_planning_objective(request, resp)
    return resp, time.perf_counter() - t0


def run_spatial_regret_insertion(request: FleetOptimizationRequest, budget_sec: float) -> Tuple[FleetOptimizationResponse, float]:
    """Insert orders directly with multi-order 3D checks, filling earlier days & compact vehicles first."""
    t0 = time.perf_counter()
    deadline = t0 + budget_sec * 0.70
    eng = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=budget_sec, should_split_orders=False, include_benchmarks=False
    )
    routes: List[List[ScheduledStop]] = [[] for _ in eng.vehicles]
    routes_by_day: Dict[int, int] = {}
    route_limit = request.policy.max_routes_per_day

    # Sort orders by tightest delivery window then largest cargo area (hardest-first)
    ordered = sorted(
        eng.orders,
        key=lambda o: (o.delivery_window_end_sec, -_order_floor_area(o)),
    )
    unassigned: List[str] = []

    for idx_o, order in enumerate(ordered):
        if time.perf_counter() >= deadline:
            unassigned.extend(o.id for o in ordered[idx_o:])
            break
        p_node = eng.order_node_indices[order.id][0]
        # Prefer active routes on earlier days, then empty vehicles on earlier days
        candidate_vehicles = sorted(
            range(len(eng.vehicles)),
            key=lambda vi: (
                eng.vehicles[vi].service_day_index,
                0 if routes[vi] else 1,
                request.duration_matrix_seconds[
                    eng.order_node_indices[routes[vi][-1].allocation_id][1] if routes[vi] else vi
                ][p_node],
                -eng.vehicles[vi].width_cm * eng.vehicles[vi].length_cm,
            ),
        )
        best_choice: Optional[Tuple[float, int, List[ScheduledStop]]] = None
        probes = 0
        for vi in candidate_vehicles:
            if time.perf_counter() >= deadline or probes >= 16:
                break
            rt = routes[vi]
            day = eng.vehicles[vi].service_day_index
            if not rt and route_limit is not None and routes_by_day.get(day, 0) >= route_limit:
                continue
            if not eng._order_allows_vehicle(order, eng.vehicles[vi]):
                continue
            base_dist = eng._calc_route_distance_km(vi, rt) if rt else 0.0
            # Try appending at end AND inserting into the last active cycle
            positions: List[Tuple[int, int]] = [(len(rt), len(rt) + 1)]
            if len(rt) >= 2:
                last_p = max(i for i, s in enumerate(rt) if s.stop_type == "PICKUP")
                positions.append((last_p + 1, len(rt)))
                positions.append((last_p + 1, len(rt) + 1))
            for p_pos, d_pos in positions:
                ok, cand = eng._can_insert_order(vi, rt, order, p_pos, d_pos, check_packing=False)
                if not ok:
                    continue
                delta_km = eng._calc_route_distance_km(vi, cand) - base_dist
                if best_choice is not None and delta_km >= best_choice[0]:
                    continue
                seg = eng._extract_active_cycle(cand, p_pos)
                if not _route_peak_floor_ok(eng, vi, seg):
                    continue
                probes += 1
                sched = eng._schedule_stops(vi, cand)
                if sched is None:
                    continue
                seg_sched = eng._extract_active_cycle(sched[0], p_pos)
                if eng._validate_stops_cached(vi, seg_sched) or eng._validate_exact_route(
                    vi, seg_sched, min(0.05, deadline - time.perf_counter())
                ):
                    best_choice = (delta_km, vi, sched[0])
                    break
            if best_choice is not None and not rt:
                # Found valid empty vehicle on earliest feasible day
                break

        if best_choice is not None:
            _, chosen_vi, new_rt = best_choice
            if not routes[chosen_vi]:
                day = eng.vehicles[chosen_vi].service_day_index
                routes_by_day[day] = routes_by_day.get(day, 0) + 1
            routes[chosen_vi] = new_rt
        else:
            unassigned.append(order.id)

    audit_budget = max(3.0, budget_sec - (time.perf_counter() - t0))
    resp = eng._build_final_response(routes, unassigned, include_benchmarks=False, spatial_time_budget_seconds=audit_budget)
    apply_planning_objective(request, resp)
    return resp, time.perf_counter() - t0
