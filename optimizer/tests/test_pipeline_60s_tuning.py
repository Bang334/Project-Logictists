"""Regression tests for 60/240/0/0 pipeline budget, concurrency, and multi-day basin selection."""

from __future__ import annotations

from types import SimpleNamespace

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import PlanningObjectiveBreakdown
from app.multi_start import MultiStartFleetOptimizer, _run_hybrid_seed_worker, _select_worker_best_plan
from test_benchmark_contract import comparison_request
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
