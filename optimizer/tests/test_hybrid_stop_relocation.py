"""Stop-level search must preserve manifests and hard pickup/delivery constraints."""
import time
from dataclasses import replace
import pytest

from app.hybrid_alns.models import CargoItem, CostPolicy, DriverOption, FleetVehicle, LocationPoint, OrderPair
from app.hybrid_alns.solver import HybridALNSSolver


def make_solver(positions=None, post_audit_reserve_sec=0):
    positions = positions if positions is not None else [0, 1, 2, 7, 8, 3, 4]
    locations = [LocationPoint(id=f"n{i}", name=f"Node {i}", latitude=10, longitude=106) for i in range(len(positions))]
    vehicle = FleetVehicle(id="vehicle", plate_number="test", depot=locations[0],
        length_cm=400, width_cm=200, height_cm=200, payload_limit_kg=1000,
        fuel_consumption_liters_per_100_km=10, fixed_operating_cost_vnd=0)
    orders = [OrderPair(id=f"o{i}", order_number=f"o{i}",
        pickup_location=locations[2*i+1], delivery_location=locations[2*i+2],
        pickup_window_end_sec=10000, delivery_window_end_sec=10000,
        service_time_sec=0,
        items=[CargoItem(id=f"c{i}", order_id=f"o{i}", length_cm=20,
            width_cm=20, height_cm=20, weight_kg=10)]) for i in range(len(positions)//2)]
    matrix = [[abs(x-y)*1000 for y in positions] for x in positions]
    solver = HybridALNSSolver([vehicle], [DriverOption(id="d", full_name="test",
        fixed_salary_monthly_vnd=0, trip_base_pay_vnd=0, per_km_pay_vnd=0)], orders,
        CostPolicy(fuel_price_per_liter_vnd=20000, monthly_working_minutes=10000,
            cargo_holding_cost_vnd_per_ton_hour=0), matrix,
        [[value/10 for value in row] for row in matrix],
        {location.id: i for i, location in enumerate(locations)},
        post_audit_reserve_sec=post_audit_reserve_sec)
    stops = [stop for order in orders for stop in solver._make_stops(order)]
    return solver, stops


@pytest.mark.parametrize("reserve", [-1, 3])
def test_post_audit_reservation_cannot_exceed_the_solver_budget(reserve):
    with pytest.raises(ValueError, match="post_audit_reserve_sec"):
        make_solver(post_audit_reserve_sec=reserve)


def test_stop_relocation_improves_real_cost_and_keeps_every_package():
    solver, stops = make_solver()
    original = solver._route_key(stops)
    before = solver._candidate_key([stops], [])
    result = solver._first_improving_stop_relocation([stops], [], time.perf_counter()+1)
    assert result is not None
    _, routes, unassigned = result
    assert not unassigned
    assert solver._candidate_key(routes, []) < before
    assert sorted(solver._route_key(routes[0])) == sorted(original)
    evaluation = solver._evaluate_route(0, routes[0])
    assert evaluation.feasible, evaluation.reason
    assert solver._route_key(stops) == original  # Input is an immutable incumbent.


def test_stop_relocation_cannot_accept_cheaper_delivery_before_pickup():
    solver, stops = make_solver()
    # On this one-order route every non-identity stop move reverses precedence.
    assert solver._first_improving_stop_relocation([[stops[0], stops[1]]], [], time.perf_counter()+1) is None


def test_expired_budget_does_not_modify_or_search_incumbent():
    solver, stops = make_solver()
    original = solver._route_key(stops)
    assert solver._first_improving_stop_relocation([stops], [], time.perf_counter()-1) is None
    assert solver._route_key(stops) == original


def test_small_probe_budget_can_improve_a_later_route(monkeypatch):
    import app.hybrid_alns.solver as module
    solver, stops = make_solver([0, 1, 2, 3, 4, 7, 8, 1, 2, 7, 8, 3, 4])
    solver.vehicles.append(replace(solver.vehicles[0], id="second"))
    solver.drivers.append(replace(solver.drivers[0], id="second-driver"))
    routes = [stops[:6], stops[6:]]
    before = solver._candidate_key(routes, [])
    clock = [0.0]
    original = solver._evaluate_route_without_packing
    def one_probe(index, route):
        result = original(index, route)
        clock[0] = 2.0
        return result
    monkeypatch.setattr(module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(solver, "_evaluate_route_without_packing", one_probe)
    result = solver._first_improving_stop_relocation(routes, [], deadline=1.0)
    assert result is not None
    assert solver._candidate_key(result[1], result[2]) < before
    assert sorted(solver._route_key(result[1][1])) == sorted(solver._route_key(routes[1]))


@pytest.mark.parametrize("salary,holding", [(0, 0), (12000000, 30000)])
def test_pre_audit_ranking_matches_production_cost_and_objective(salary, holding):
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from app.planning_objective import plan_lexicographic_key
    from test_benchmark_contract import comparison_request

    request = comparison_request()
    request.drivers[0].fixed_salary_monthly_vnd = salary
    request.policy.cargo_holding_cost_vnd_per_ton_hour = holding
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1)
    routes, missing = engine._repair_greedy_insert([[]], [o.id for o in engine.orders],
        start_time=time.perf_counter(), randomize=False)
    assert not missing
    key = engine._rank_candidate_for_audit(routes, missing)
    audited = engine._build_final_response(routes, missing, include_benchmarks=False)
    assert not audited.unassigned_orders
    assert all(route.spatial_validation.is_valid for route in audited.routes)
    assert key == (0, *plan_lexicographic_key(audited))
