"""Regression tests for 60/240/0/0 pipeline budget, concurrency, and multi-day basin selection."""

from __future__ import annotations

from types import SimpleNamespace

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import PlanningObjectiveBreakdown
from app.multi_start import (
    MultiStartFleetOptimizer,
    _run_hybrid_pool_worker,
    _run_hybrid_seed_worker,
    _select_worker_best_plan,
)
from test_benchmark_contract import comparison_request
from test_cross_seed_partitioning import _route_for_orders, _sample_problem
from test_multi_start import _mock_plan


def _plan_with_objective(
    *,
    job_id: str,
    cost: int,
    score: int,
    route_count: int,
):
    plan = _mock_plan(job_id, "SUCCESS", cost, ["part-0", "part-1"])
    base_route = plan.routes[0]
    for idx in range(1, route_count):
        plan.routes.append(base_route.model_copy(update={"route_id": f"route-{job_id}-{idx}", "stops": []}))
    plan.planning_objective = PlanningObjectiveBreakdown(
        planning_span_days=2,
        operating_cost_vnd=cost,
        driver_active_salary_allocation_vnd=0,
        driver_calendar_salary_vnd=0,
        driver_idle_salary_allocation_vnd=score - cost,
        operational_late_penalty_vnd=0,
        selection_score_vnd=score,
        extra_order_trips=0,
        active_route_count=route_count,
        physical_vehicle_count=route_count,
    )
    return plan


def test_select_worker_best_plan_prefers_lowest_objective_in_multiday(monkeypatch):
    req = comparison_request()
    expected = {o.id: {it.id for it in o.items} for o in req.orders}
    monkeypatch.setattr("app.multi_start.is_fully_served", lambda *_a, **_k: True)
    monkeypatch.setattr("app.multi_start.apply_planning_objective", lambda _req, p: p.planning_objective)

    compact_costlier = _plan_with_objective(job_id="compact", cost=20_000_000, score=22_000_000, route_count=1)
    cheaper_extra_trip = _plan_with_objective(job_id="econ", cost=18_000_000, score=19_500_000, route_count=2)
    setattr(compact_costlier, "_audited_alternatives", [cheaper_extra_trip])

    chosen_multi, obj_multi = _select_worker_best_plan(
        compact_costlier, req, expected, None, compare_horizons=True,
    )
    assert chosen_multi is cheaper_extra_trip
    assert obj_multi.selection_score_vnd == 19_500_000

    chosen_single, _ = _select_worker_best_plan(
        compact_costlier, req, expected, None, compare_horizons=False,
    )
    assert chosen_single is compact_costlier


def test_inject_objective_audit_candidate_retains_best_score_in_tight_limit():
    compact_1 = ((0, 0, 8, 33_500_000, 33_500_000, 8), [["r1"]], [])
    compact_2 = ((0, 0, 9, 33_000_000, 33_000_000, 9), [["r2"]], [])
    compact_3 = ((0, 0, 10, 32_500_000, 32_500_000, 10), [["r3"]], [])
    best_obj = ((0, 0, 12, 31_200_000, 31_200_000, 12), [["r4"]], [])
    fallback = compact_3

    selected = PackingAwareHybridALNSOptimizer._select_audit_candidates(
        [compact_1, compact_2, compact_3, best_obj], limit=3, fallback=fallback,
    )
    assert best_obj not in selected

    enriched = PackingAwareHybridALNSOptimizer._inject_objective_audit_candidate(
        selected, [compact_1, compact_2, compact_3, best_obj], limit=3, fallback=fallback,
    )
    assert len(enriched) == 3
    assert best_obj in enriched
    assert fallback in enriched
    assert compact_1 in enriched


def test_probe_days_only_narrows_seed_zero(monkeypatch):
    req = comparison_request()
    template_v = req.vehicles[0]
    req.vehicles.append(template_v.model_copy(update={"id": "veh-day1", "service_day_index": 1}))
    for field in ("distance_matrix_meters", "duration_matrix_seconds"):
        m = getattr(req, field)
        order = [0, 0, *range(1, len(m))]
        setattr(req, field, [[m[i][j] for j in order] for i in order])
    # Expand orders >= 12 so compact_days_hint threshold is active.
    base_o = req.orders[0]
    req.orders = [
        base_o.model_copy(update={
            "id": f"ord-{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"ord-{i}",
            "pickup_location": req.orders[i % len(req.orders)].pickup_location,
            "delivery_location": req.orders[i % len(req.orders)].delivery_location,
            "items": [base_o.items[0].model_copy(update={"id": f"it-{i}", "order_id": f"ord-{i}"})],
        })
        for i in range(12)
    ]
    nv = len(req.vehicles) + 2 * len(req.orders)
    req.distance_matrix_meters = [[0 if i == j else 1000 for j in range(nv)] for i in range(nv)]
    req.duration_matrix_seconds = [[0 if i == j else 60 for j in range(nv)] for i in range(nv)]

    observed = []

    class DummyHybrid:
        def __init__(self, r, *, random_seed=0, **_kwargs):
            observed.append((random_seed, len(r.vehicles)))

        def solve(self, hard_deadline=None):
            return _mock_plan("probe-check", "SUCCESS", 10_000, [o.id for o in req.orders])

    monkeypatch.setattr("app.multi_start._estimate_hybrid_lower_bound_days", lambda _r: 1)
    monkeypatch.setattr("app.multi_start._extract_safe_ortools_seed_pool", lambda *_a, **_k: None)
    monkeypatch.setattr("app.multi_start.PackingAwareHybridALNSOptimizer", DummyHybrid)
    monkeypatch.setattr("app.multi_start.is_fully_served", lambda *_a, **_k: True)
    monkeypatch.setattr(
        "app.multi_start.apply_planning_objective",
        lambda _req, p: _plan_with_objective(job_id="x", cost=10_000, score=10_000, route_count=1).planning_objective,
    )

    req_dict = req.model_dump()
    _run_hybrid_seed_worker(req_dict, req_dict, 0, 10.0, None)
    _run_hybrid_seed_worker(req_dict, req_dict, 1, 10.0, None)
    _run_hybrid_seed_worker(req_dict, req_dict, 2, 10.0, None)

    assert observed == [(0, 1), (1, 2), (2, 2)]


def test_worker_audit_grace_keeps_full_search_budget_when_headroom_allows(monkeypatch):
    import time
    req = comparison_request().model_copy(update={"early_stop_patience": 0, "max_time_seconds": 240})
    deadlines = []

    class DummyHybrid:
        def __init__(self, _r, *, time_budget_seconds=0.0, **_kwargs):
            self.budget = time_budget_seconds

        def solve(self, hard_deadline=None):
            deadlines.append(hard_deadline - time.perf_counter())
            return _mock_plan("grace-check", "SUCCESS", 10_000, [o.id for o in req.orders])

    monkeypatch.setattr("app.multi_start._extract_safe_ortools_seed_pool", lambda *_a, **_k: None)
    monkeypatch.setattr("app.multi_start.PackingAwareHybridALNSOptimizer", DummyHybrid)
    monkeypatch.setattr("app.multi_start.is_fully_served", lambda *_a, **_k: True)
    monkeypatch.setattr(
        "app.multi_start.apply_planning_objective",
        lambda _req, _p: _plan_with_objective(job_id="x", cost=10_000, score=10_000, route_count=1).planning_objective,
    )

    req_dict = req.model_dump()
    # Non-adaptive >= 40s worker with plenty of headroom gets audit grace (+6s for <50 orders).
    _run_hybrid_seed_worker(req_dict, req_dict, 0, 55.2, None)
    # Tight budget / warm refinement skips audit grace.
    _run_hybrid_seed_worker(req_dict, req_dict, 0, 12.0, None)
    _run_hybrid_seed_worker(
        req_dict,
        req_dict,
        0,
        55.2,
        _mock_plan("warm", "SUCCESS", 10_000, [o.id for o in req.orders]).model_dump(),
    )

    assert len(deadlines) == 3
    assert 60.0 <= deadlines[0] <= 61.5
    assert 11.0 <= deadlines[1] <= 12.5
    assert 54.0 <= deadlines[2] <= 55.5


def test_hybrid_pool_worker_forwards_distinct_audited_alternative_routes(monkeypatch):
    req, vehicles, orders, _expected = _sample_problem()
    winner_route_0 = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=300_000)
    winner_route_1 = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=600_000)
    winner = _mock_plan("winner", "SUCCESS", 900_000, [o.id for o in orders])
    winner.routes = [winner_route_0, winner_route_1]

    alt_valid_route_1 = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=750_000)
    alt_invalid_route_1 = _route_for_orders(
        vehicle=vehicles[1], orders=[orders[1]], cost_vnd=150_000, spatial_valid=False,
    )
    # Alt plan shares winner_route_0 (deduplicated out), has invalid 3D route (filtered out),
    # and carries one distinct valid route (750k); winner (300k + 600k = 900k) wins single-plan ranking.
    alt_plan = _mock_plan("alt", "SUCCESS", 1_200_000, [o.id for o in orders])
    alt_plan.routes = [
        winner_route_0.model_copy(deep=True),
        alt_valid_route_1,
        alt_invalid_route_1,
    ]
    setattr(winner, "_audited_alternatives", [alt_plan])

    class DummyHybrid:
        def __init__(self, *_args, **_kwargs):
            pass

        def solve(self, hard_deadline=None):
            return winner

    monkeypatch.setattr("app.multi_start._extract_safe_ortools_seed_pool", lambda *_a, **_k: None)
    monkeypatch.setattr("app.multi_start.PackingAwareHybridALNSOptimizer", DummyHybrid)
    monkeypatch.setattr("app.multi_start.is_fully_served", lambda *_a, **_k: True)

    req_dict = req.model_dump()
    # Legacy 4-tuple contract remains intact.
    seed4, plan4, obj4, err4 = _run_hybrid_seed_worker(req_dict, req_dict, 0, 10.0, None)
    assert seed4 == 0 and err4 is None and plan4 is not None and obj4 is not None

    # Pool worker 5-tuple forwards only valid distinct alternative routes across IPC.
    seed5, plan5, obj5, alt_dicts, err5 = _run_hybrid_pool_worker(req_dict, req_dict, 0, 10.0, None)
    assert seed5 == 0 and err5 is None and plan5 is not None and obj5 is not None
    assert len(alt_dicts) == 1
    assert alt_dicts[0]["cost"]["total_cost_vnd"] == 750_000


def test_multistart_pool_forwards_worker_alternatives_to_cross_seed(monkeypatch):
    from concurrent.futures import Future
    import app.multi_start as module

    req, vehicles, orders, _expected = _sample_problem()
    # Expand to 8 orders (>= Cross-Seed guard threshold) across 2 vehicles by reusing _route_for_orders.
    base_o = orders[0]
    req.orders = [
        base_o.model_copy(update={
            "id": f"o{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"o{i}",
            "pickup_location": req.orders[i % 2].pickup_location.model_copy(update={"id": f"p{i}"}),
            "delivery_location": req.orders[i % 2].delivery_location.model_copy(update={"id": f"d{i}"}),
            "items": [base_o.items[0].model_copy(update={"id": f"it{i}", "order_id": f"o{i}"})],
        })
        for i in range(8)
    ]
    nv = len(req.vehicles) + 2 * len(req.orders)
    req.distance_matrix_meters = [[0 if a == b else 1000 for b in range(nv)] for a in range(nv)]
    req.duration_matrix_seconds = [[0 if a == b else 60 for b in range(nv)] for a in range(nv)]
    req = req.model_copy(update={"hybrid_seed_count": 2, "early_stop_patience": 0, "search_time_seconds": 10, "max_time_seconds": 30})

    class ImmediatePool:
        def __init__(self, max_workers):
            self.max_workers = max_workers

        def submit(self, fn, *args):
            fut = Future()
            fut.set_result(fn(*args))
            return fut

        def shutdown(self, **kwargs):
            pass

    r0 = _route_for_orders(vehicle=vehicles[0], orders=req.orders[:4], cost_vnd=300_000)
    r1 = _route_for_orders(vehicle=vehicles[1], orders=req.orders[4:], cost_vnd=600_000)
    alt_r0 = _route_for_orders(vehicle=vehicles[0], orders=req.orders[:4], cost_vnd=700_000)
    alt_r1 = _route_for_orders(vehicle=vehicles[1], orders=req.orders[4:], cost_vnd=280_000)

    class FakeHybrid:
        def __init__(self, *_a, **_k):
            pass

        def solve(self, hard_deadline=None):
            # Primary plan wins single-plan ranking (900k < 980k),
            # while alternative basin contributes alt_r1 (280k) for Cross-Seed CP-SAT to win.
            p = _mock_plan("p", "SUCCESS", 900_000, [o.id for o in req.orders])
            p.routes = [r0.model_copy(deep=True), r1.model_copy(deep=True)]
            alt = _mock_plan("alt", "SUCCESS", 980_000, [o.id for o in req.orders])
            alt.routes = [alt_r0.model_copy(deep=True), alt_r1.model_copy(deep=True)]
            setattr(p, "_audited_alternatives", [alt])
            return p

    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(module, "PackingAwareHybridALNSOptimizer", FakeHybrid)
    monkeypatch.setattr(module, "_REAL_HYBRID_OPTIMIZER", FakeHybrid)
    monkeypatch.setattr(module, "PackingAwareILSOptimizer", object())
    monkeypatch.setattr(module, "_extract_safe_ortools_seed_pool", lambda *_a, **_k: None)
    monkeypatch.setattr(MultiStartFleetOptimizer, "_direct_benchmark", lambda self: (None, None))

    batch = MultiStartFleetOptimizer(req).solve()
    assert batch.candidates
    assert batch.candidates[0].search_strategy == "Packing-aware Cross-Seed CP-SAT"
    assert any("Tổ hợp chéo đa seed" in msg for msg in batch.diagnostics)
    assert sum(r.cost.fuel_cost_vnd for r in batch.candidates[0].result.routes) == 380_000


def test_multistart_records_pre_and_post_merge_cross_seed_telemetry(monkeypatch):
    from concurrent.futures import Future
    import app.multi_start as module

    req, vehicles, orders, _expected = _sample_problem()
    base_o = orders[0]
    req.orders = [
        base_o.model_copy(update={
            "id": f"o{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"o{i}",
            "pickup_location": req.orders[i % 2].pickup_location.model_copy(update={"id": f"p{i}"}),
            "delivery_location": req.orders[i % 2].delivery_location.model_copy(update={"id": f"d{i}"}),
            "items": [base_o.items[0].model_copy(update={"id": f"it{i}", "order_id": f"o{i}"})],
        })
        for i in range(8)
    ]
    nv = len(req.vehicles) + 2 * len(req.orders)
    req.distance_matrix_meters = [[0 if a == b else 1000 for b in range(nv)] for a in range(nv)]
    req.duration_matrix_seconds = [[0 if a == b else 60 for b in range(nv)] for a in range(nv)]
    req = req.model_copy(update={"hybrid_seed_count": 2, "early_stop_patience": 0, "search_time_seconds": 10, "max_time_seconds": 30})

    class ImmediatePool:
        def __init__(self, max_workers):
            self.max_workers = max_workers

        def submit(self, fn, *args):
            fut = Future()
            fut.set_result(fn(*args))
            return fut

        def shutdown(self, **kwargs):
            pass

    r0_cheap = _route_for_orders(vehicle=vehicles[0], orders=req.orders[:4], cost_vnd=300_000)
    r1_exp = _route_for_orders(vehicle=vehicles[1], orders=req.orders[4:], cost_vnd=600_000)
    alt_r0_exp = _route_for_orders(vehicle=vehicles[1], orders=req.orders[:4], cost_vnd=700_000)
    alt_r1_cheap = _route_for_orders(vehicle=vehicles[0], orders=req.orders[4:], cost_vnd=280_000)

    class FakeHybrid:
        def __init__(self, *_a, random_seed=0, **_k):
            self.random_seed = random_seed

        def solve(self, hard_deadline=None):
            if self.random_seed == 0:
                p = _mock_plan("p0", "SUCCESS", 900_000, [o.id for o in req.orders])
                p.routes = [r0_cheap.model_copy(deep=True), r1_exp.model_copy(deep=True)]
                return p
            p1 = _mock_plan("p1", "SUCCESS", 980_000, [o.id for o in req.orders])
            p1.routes = [alt_r0_exp.model_copy(deep=True), alt_r1_cheap.model_copy(deep=True)]
            return p1

    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(module, "PackingAwareHybridALNSOptimizer", FakeHybrid)
    monkeypatch.setattr(module, "_REAL_HYBRID_OPTIMIZER", FakeHybrid)
    monkeypatch.setattr(module, "PackingAwareILSOptimizer", object())
    monkeypatch.setattr(module, "_extract_safe_ortools_seed_pool", lambda *_a, **_k: None)
    monkeypatch.setattr(module.MultiStartFleetOptimizer, "_direct_benchmark", lambda self: (None, None))

    opt = MultiStartFleetOptimizer(req)
    batch = opt.solve()

    assert opt.last_cross_seed_telemetry is not None
    tel = opt.last_cross_seed_telemetry
    assert tel["accepted"] is True
    assert tel["post_merge_score"] < tel["pre_merge_score"]
    assert tel["delta_score"] == tel["post_merge_score"] - tel["pre_merge_score"]
    assert tel["elapsed_sec"] >= 0.0
    assert any("Cross-seed CP-SAT telemetry:" in msg and "pre_best=" in msg and "post_merge=" in msg for msg in batch.diagnostics)
    assert batch.candidates[0].search_strategy == "Packing-aware Cross-Seed CP-SAT"


def _build_hybrid_alns_test_fixture(n_orders: int = 12):
    from app.hybrid_alns.models import (
        CargoItem as ALNSCargoItem,
        CostPolicy as ALNSCostPolicy,
        DriverOption as ALNSDriverOption,
        FleetVehicle as ALNSFleetVehicle,
        LocationPoint as ALNSLocationPoint,
        OrderPair as ALNSOrderPair,
    )
    from app.models import default_stacking_policy

    depots = [
        ALNSLocationPoint(id="dep-a", name="Depot A", latitude=10.75, longitude=106.66),
        ALNSLocationPoint(id="dep-b", name="Depot B", latitude=10.80, longitude=106.70),
    ]
    vehicles = [
        ALNSFleetVehicle(
            id=f"v-{d}-{k}",
            source_vehicle_id=f"src-v-{k}",
            plate_number=f"51A-{d}{k}",
            length_cm=420.0,
            width_cm=180.0,
            height_cm=180.0,
            payload_limit_kg=1500.0,
            service_day_index=d,
            available_start_sec=d * 86400 + 21600,
            available_end_sec=d * 86400 + 75600,
            depot=depots[k % 2],
            fuel_consumption_liters_per_100_km=14.0,
            fixed_operating_cost_vnd=300_000,
        )
        for d in range(2)
        for k in range(3)
    ]
    drivers = [
        ALNSDriverOption(
            id=f"drv-{i}",
            source_driver_id=f"src-drv-{i}",
            full_name=f"Driver {i}",
            service_day_index=v.service_day_index,
            fixed_salary_monthly_vnd=9_000_000,
            trip_base_pay_vnd=120_000,
            per_km_pay_vnd=3_000,
        )
        for i, v in enumerate(vehicles)
    ]
    nodes = list(depots)
    orders = []
    for i in range(n_orders):
        day = 0 if i < (n_orders - 2) else 1
        base = day * 86400 + 25200 + (i % 4) * 1800
        p = ALNSLocationPoint(id=f"p-{i}", name=f"P{i}", latitude=10.76 + i * 0.004, longitude=106.65 + (i % 3) * 0.005)
        d = ALNSLocationPoint(id=f"d-{i}", name=f"D{i}", latitude=10.77 + (i % 5) * 0.004, longitude=106.68 + i * 0.003)
        nodes.extend([p, d])
        orders.append(
            ALNSOrderPair(
                id=f"ord-{i}",
                order_number=f"ORD-{i:02d}",
                pickup_location=p,
                delivery_location=d,
                items=[
                    ALNSCargoItem(
                        id=f"itm-{i}",
                        order_id=f"ord-{i}",
                        description=f"Box {i}",
                        length_cm=80.0 + (i % 3) * 15.0,
                        width_cm=60.0,
                        height_cm=60.0,
                        weight_kg=350.0 if i % 4 != 0 else 650.0,
                        can_rotate=True,
                    )
                ],
                pickup_window_start_sec=base,
                pickup_window_end_sec=base + 14400,
                delivery_window_start_sec=base + 1800,
                delivery_window_end_sec=base + 28800,
                pickup_service_time_sec=300,
                delivery_service_time_sec=300,
            )
        )
    node_id_to_index = {n.id: idx for idx, n in enumerate(nodes)}
    n_nodes = len(nodes)
    dist = [[0.0] * n_nodes for _ in range(n_nodes)]
    dur = [[0.0] * n_nodes for _ in range(n_nodes)]
    for i, a in enumerate(nodes):
        for j, b in enumerate(nodes):
            if i == j:
                continue
            km = max(1.5, ((a.latitude - b.latitude) ** 2 + (a.longitude - b.longitude) ** 2) ** 0.5 * 111.0)
            dist[i][j] = round(km, 3)
            dur[i][j] = float(int(round(km * 95.0)))
    policy = ALNSCostPolicy(
        fuel_price_per_liter_vnd=24_000,
        monthly_working_minutes=12_480,
        demo_stacking=default_stacking_policy(),
    )
    return vehicles, drivers, orders, policy, dist, dur, node_id_to_index


def test_repair_option_cache_matches_uncached_exactly():
    import copy
    import time
    from app.hybrid_alns.solver import HybridALNSSolver

    vehicles, drivers, orders, policy, dist, dur, idx_map = _build_hybrid_alns_test_fixture(14)
    solver_uncached = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist, dur, idx_map,
        time_limit_sec=10.0, max_iterations=10, random_seed=7,
        enable_repair_option_cache=False,
    )
    solver_cached = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist, dur, idx_map,
        time_limit_sec=10.0, max_iterations=10, random_seed=7,
        enable_repair_option_cache=True,
    )

    deadline = time.perf_counter() + 30.0
    # Seed initial partial routes on day 0 vehicles then repair remaining + day 1 orders (triggers span change).
    init_routes = [[] for _ in vehicles]
    init_routes, _ = solver_uncached._repair(init_routes, [o.id for o in orders[:5]], "regret2", deadline)
    for op in ("regret2", "regret3", "greedy"):
        r_no, u_no = solver_uncached._repair(copy.deepcopy(init_routes), [o.id for o in orders[5:]], op, time.perf_counter() + 30.0)
        r_yes, u_yes = solver_cached._repair(copy.deepcopy(init_routes), [o.id for o in orders[5:]], op, time.perf_counter() + 30.0)
        assert u_yes == u_no
        assert [
            [(s.stop_type, s.order_id, s.arrival_time_sec, s.departure_time_sec) for s in rt]
            for rt in r_yes
        ] == [
            [(s.stop_type, s.order_id, s.arrival_time_sec, s.departure_time_sec) for s in rt]
            for rt in r_no
        ]


def test_insertion_prescreen_never_rejects_quick_feasible():
    import time
    from app.hybrid_alns.solver import HybridALNSSolver

    vehicles, drivers, orders, policy, dist, dur, idx_map = _build_hybrid_alns_test_fixture(10)
    solver = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist, dur, idx_map,
        time_limit_sec=5.0, max_iterations=5, random_seed=3,
    )
    routes = [[] for _ in vehicles]
    routes, _ = solver._repair(routes, [o.id for o in orders[:6]], "regret2", time.perf_counter() + 15.0)
    # Remove one order without re-evaluating remaining stops (mimics _remove_orders stale fields)
    destroyed = solver._remove_orders(routes, {orders[1].id})
    for order in orders:
        if order.id == orders[1].id:
            continue
        p_stop, d_stop = solver._make_stops(order)
        p_node = idx_map[p_stop.location_id]
        d_node = idx_map[d_stop.location_id]
        for v_idx, vehicle in enumerate(vehicles):
            cur = destroyed[v_idx]
            ctx = solver._prepare_route_prescreen(vehicle, cur)
            assert ctx is not None
            for p_pos, d_pos in solver._candidate_positions(len(cur)):
                cand = cur[:p_pos] + [p_stop] + cur[p_pos:d_pos - 1] + [d_stop] + cur[d_pos - 1:]
                quick = solver._evaluate_route_without_packing(v_idx, cand)
                if quick.feasible:
                    assert solver._passes_insertion_prescreen(
                        vehicle, cur, order, p_pos, d_pos,
                        p_node, d_node,
                        order.service_seconds("PICKUP"),
                        order.service_seconds("DELIVERY"),
                        ctx,
                    )


def test_packing_cache_shares_box_result_across_depots_and_days(monkeypatch):
    from app.hybrid_alns.packing_checker import FastPackingChecker
    from app.hybrid_alns.solver import HybridALNSSolver

    vehicles, drivers, orders, policy, dist, dur, idx_map = _build_hybrid_alns_test_fixture(4)
    # Vehicle 0 (Depot A, day 0) vs Vehicle 4 (Depot B, day 1) have identical box dimensions
    assert vehicles[0].depot.id != vehicles[4].depot.id
    assert vehicles[0].service_day_index != vehicles[4].service_day_index
    calls = {"count": 0}
    orig_validate = FastPackingChecker.validate_route_stops

    def tracked_validate(self_checker, stops, cargo_by_id):
        calls["count"] += 1
        return orig_validate(self_checker, stops, cargo_by_id)

    monkeypatch.setattr(FastPackingChecker, "validate_route_stops", tracked_validate)
    solver = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist, dur, idx_map,
        time_limit_sec=5.0, max_iterations=5, random_seed=0,
    )
    o = orders[-1]  # day-1 order that fits both depots
    p_stop, d_stop = solver._make_stops(o)
    ev0 = solver._evaluate_route(0, [p_stop, d_stop], allow_layout_search=False)
    ev1 = solver._evaluate_route(4, [p_stop, d_stop], allow_layout_search=False)
    assert ev0.feasible or not ev0.feasible
    assert calls["count"] == 1


def test_hybrid_solver_exports_deduped_diverse_alns_route_pool():
    from app.hybrid_alns.solver import HybridALNSSolver

    vehicles, drivers, orders, policy, dist, dur, idx_map = _build_hybrid_alns_test_fixture(8)
    solver = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist, dur, idx_map,
        time_limit_sec=2.0, max_iterations=25, random_seed=0,
    )
    sol = solver.solve()
    exported = getattr(sol, "_alns_route_pool", [])
    assert exported
    valid_slot_ids = {v.id for v in vehicles}
    seen_route_keys = set()
    for slot_id, stops in exported:
        assert slot_id in valid_slot_ids
        assert stops
        sig = (slot_id, tuple((s.stop_type, s.order_id or "") for s in stops))
        assert sig not in seen_route_keys
        seen_route_keys.add(sig)


def test_multistart_pass2b_pool_stubs_win_with_real_alns_auditor(monkeypatch):
    from concurrent.futures import Future
    from app.alns_engine import ALNSFleetOptimizer
    import app.multi_start as module

    req, vehicles, orders, _expected = _sample_problem()
    base_o = orders[0]
    req.orders = [
        base_o.model_copy(update={
            "id": f"o{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"o{i}",
            "pickup_location": req.orders[i % 2].pickup_location.model_copy(update={"id": f"p{i}"}),
            "delivery_location": req.orders[i % 2].delivery_location.model_copy(update={"id": f"d{i}"}),
            "items": [base_o.items[0].model_copy(update={"id": f"it{i}", "order_id": f"o{i}"})],
        })
        for i in range(8)
    ]
    nv = len(req.vehicles) + 2 * len(req.orders)
    req.distance_matrix_meters = [[0 if a == b else 1000 for b in range(nv)] for a in range(nv)]
    req.duration_matrix_seconds = [[0 if a == b else 60 for b in range(nv)] for a in range(nv)]
    req = req.model_copy(update={"hybrid_seed_count": 2, "early_stop_patience": 0, "search_time_seconds": 10, "max_time_seconds": 30})

    class ImmediatePool:
        def __init__(self, max_workers):
            self.max_workers = max_workers

        def submit(self, fn, *args):
            fut = Future()
            fut.set_result(fn(*args))
            return fut

        def shutdown(self, **kwargs):
            pass

    r0 = _route_for_orders(vehicle=vehicles[0], orders=req.orders[:4], cost_vnd=600_000)
    r1 = _route_for_orders(vehicle=vehicles[1], orders=req.orders[4:], cost_vnd=600_000)
    # Build an authentic pool stub via ALNSFleetOptimizer for vehicle 0 covering orders[4:], wait:
    # vehicle 0 covers orders[4:] cheaper (~180k) while seed plans cost 1.2M total; let vehicle 1 stub cover [4:] cheaply.
    stub_route = ALNSFleetOptimizer(req).build_pool_route_stub(1, list(r1.stops))
    assert stub_route is not None and not stub_route.spatial_validation.is_valid
    stub_dict = stub_route.model_dump()
    stub_dict["_pool_stub"] = True

    class FakeHybrid:
        def __init__(self, *_a, random_seed=0, **_k):
            self.random_seed = random_seed

        def solve(self, hard_deadline=None):
            p = _mock_plan(f"p{self.random_seed}", "SUCCESS", 1_200_000, [o.id for o in req.orders])
            p.routes = [r0.model_copy(deep=True), r1.model_copy(deep=True)]
            if self.random_seed == 0:
                setattr(p, "_alns_pool_route_dicts", [stub_dict])
            return p

    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(module, "PackingAwareHybridALNSOptimizer", FakeHybrid)
    monkeypatch.setattr(module, "_REAL_HYBRID_OPTIMIZER", FakeHybrid)
    monkeypatch.setattr(module, "PackingAwareILSOptimizer", object())
    monkeypatch.setattr(module, "_extract_safe_ortools_seed_pool", lambda *_a, **_k: None)
    monkeypatch.setattr(module.MultiStartFleetOptimizer, "_direct_benchmark", lambda self: (None, None))

    opt = MultiStartFleetOptimizer(req)
    batch = opt.solve()
    assert batch.candidates
    assert batch.candidates[0].search_strategy == "Packing-aware Cross-Seed ALNS-Pool CP-SAT"
    assert opt.last_cross_seed_telemetry is not None
    assert opt.last_cross_seed_telemetry["winning_pass"] == "pass2b_alns_pool"
    assert opt.last_cross_seed_telemetry["pool_stub_count"] == 1
    assert all(
        r.spatial_validation is not None and r.spatial_validation.is_valid
        for r in batch.candidates[0].result.routes
    )
