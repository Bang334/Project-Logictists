"""A repaired partial candidate must not hide a complete audited fallback."""
from types import SimpleNamespace
import pytest
import copy

from app.hybrid_alns.advanced_metaheuristics import _AdvancedSearchBase
from app.ils_engine import PackingAwareILSOptimizer
from app.models import UnassignedOrder


def test_native_exports_every_bounded_audited_alternative_for_production_ranking(monkeypatch):
    from test_hybrid_stop_relocation import make_solver
    solver, stops = make_solver()
    solver.time_limit_sec = 0.3
    solver.max_iterations = 0
    pairs = [stops[i:i+2] for i in range(0, len(stops), 2)]
    candidates = []
    for ordering in [(0, 1, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)]:
        routes = [[copy.deepcopy(stop) for i in ordering for stop in pairs[i]]]
        candidates.append((solver._plan_cost(routes, []), routes, []))
    monkeypatch.setattr(solver, "_select_audit_candidates", lambda _, **kwargs: candidates)
    result = solver.solve()
    alternatives = result._candidate_solutions
    assert len(alternatives) == len(candidates)
    assert all(s.solution_audited and s.is_spatial_valid and not s.unassigned_orders for s in alternatives)
    assert len({tuple((st.order_id, st.stop_type) for r in s.routes for st in r.stops) for s in alternatives}) == 4


def test_native_keeps_unpolished_greedy_within_the_same_audit_capacity():
    from app.hybrid_alns.solver import HybridALNSSolver
    candidates = [(cost, [[f"candidate-{cost}"]], []) for cost in range(1, 7)]
    fallback = candidates[-1]
    selected = HybridALNSSolver._select_audit_candidates(
        candidates, limit=4, max_per_route_count=4, fallback=fallback,
    )
    assert fallback in selected
    assert candidates[0] in selected
    assert len(selected) == 4


def test_partial_repair_does_not_discard_complete_fallback(monkeypatch):
    engine = object.__new__(_AdvancedSearchBase)
    engine.orders = []
    monkeypatch.setattr(engine, "_candidate_key", lambda routes, unassigned: (0, 0, 1, routes[0]))
    monkeypatch.setattr(engine, "_plan_signature", lambda routes, unassigned: tuple(routes))
    partial = SimpleNamespace(is_contract_valid=True, is_temporally_valid=True,
        is_spatial_valid=True, unassigned_orders=["missing"], routes=[],
        real_economic_cost_vnd=10, total_distance_km=1)
    complete = SimpleNamespace(is_contract_valid=True, is_temporally_valid=True,
        is_spatial_valid=True, unassigned_orders=[], routes=[],
        real_economic_cost_vnd=20, total_distance_km=2)
    monkeypatch.setattr(engine, "_finalize", lambda routes, *args, **kwargs:
        partial if routes == [10] else complete)
    result = engine._finalize_best_valid([(10, [10], [])], (20, [20], []), 0,
        "regression", spatial_time_limit_sec=1, repair_time_limit_sec=1,
        max_audit_candidates=1)
    assert result is complete


@pytest.mark.parametrize("missing,actual_cost", [(True, 10), (False, 200)])
def test_ils_keeps_seed_when_search_winner_is_worse_after_audit(monkeypatch, missing, actual_cost):
    engine = object.__new__(PackingAwareILSOptimizer)
    engine.vehicles = [object()]
    engine.orders = [SimpleNamespace(id="order")]
    engine.time_limit_sec = 1
    engine.max_iterations = 1
    engine.random_seed = 0
    seed = [["seed"]]
    changed = [["changed"]]
    monkeypatch.setattr(engine, "_repair_greedy_insert", lambda *a, **kw: (seed, []))
    monkeypatch.setattr(engine, "_evaluate_plan_cost", lambda *a: (100, 100, 0))
    monkeypatch.setattr(engine, "_best_relocation", lambda *a: (10, changed, []))
    partial = SimpleNamespace(unassigned_orders=([UnassignedOrder(order_id="missing",
        order_number="missing", reason_code="SPATIAL", reason_message="Audit failed")] if missing else []), routes=[],
        planning_objective=None, total_cost_vnd=actual_cost, diagnostics=[])
    complete = SimpleNamespace(unassigned_orders=[], routes=[],
        planning_objective=None, total_cost_vnd=100, diagnostics=[])
    monkeypatch.setattr(engine, "_build_final_response", lambda routes, unassigned:
        partial if routes == changed else complete)
    assert engine.solve() is complete


def test_construction_fallback_survives_a_full_audit_bucket():
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    candidates = [(cost, [[f"route-{cost}"]], []) for cost in range(1, 6)]
    fallback = candidates[-1]
    selected = PackingAwareHybridALNSOptimizer._select_audit_candidates(
        candidates, limit=3, fallback=fallback,
    )
    assert fallback in selected
    assert len(selected) == 3
    assert candidates[0] in selected


def test_zero_audit_capacity_does_not_admit_a_fallback():
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    fallback = (1, [["route"]], [])
    assert PackingAwareHybridALNSOptimizer._select_audit_candidates(
        [fallback], limit=0, fallback=fallback,
    ) == []


def test_partial_construction_fallback_has_one_slot_without_evicting_every_complete_candidate():
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    complete = [((0, index), [[f"complete-{index}"]], []) for index in range(4)]
    partial = ((1, 0), [["partial"]], ["missing"])
    selected = PackingAwareHybridALNSOptimizer._select_audit_candidates(
        complete + [partial], limit=3, fallback=partial,
    )
    assert len(selected) == 3
    assert partial in selected
    assert complete[0] in selected


def test_final_audited_selection_uses_calendar_objective_before_operating_cost():
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from app.models import RouteCostBreakdown
    from test_benchmark_contract import comparison_request
    request = comparison_request()
    request.vehicles[0].source_vehicle_id = "physical-vehicle"
    request.vehicles[0].available_start_sec = 8 * 3600
    request.vehicles[0].available_end_sec = 17 * 3600
    request.drivers[0].source_driver_id = "physical-driver"
    request.drivers[0].fixed_salary_monthly_vnd = 1_000_000
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1, include_benchmarks=False)
    routes, missing = engine._repair_greedy_insert([[]], [o.id for o in engine.orders], randomize=False)
    assert not missing
    base = engine._build_final_response(routes, [], include_benchmarks=False)
    assert not base.unassigned_orders

    # Both quotes include the same calendar salary, including its idle part.
    # A has higher operating cost but lower non-salary cost and company score.
    def quote(fuel, salary):
        plan = base.model_copy(deep=True)
        plan.total_cost_vnd = fuel + salary
        plan.routes[0].cost = RouteCostBreakdown(
            base_fuel_cost_vnd=fuel, load_fuel_surcharge_vnd=0, fuel_cost_vnd=fuel,
            cargo_holding_cost_vnd=0, late_delivery_penalty_vnd=0,
            cargo_distance_ton_km=0, cargo_time_ton_hours=0,
            vehicle_fixed_cost_vnd=0, driver_fixed_salary_allocation_vnd=salary,
            driver_trip_pay_vnd=0, total_cost_vnd=fuel+salary,
        )
        return plan
    better_company_score = quote(10, 90)
    cheaper_operating_cost = quote(50, 0)
    selected = engine._best_audited_response([cheaper_operating_cost, better_company_score])
    assert selected is better_company_score
    assert selected.planning_objective.selection_score_vnd < cheaper_operating_cost.planning_objective.selection_score_vnd
