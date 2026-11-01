"""Polish repaired plans using real costs and another full spatial audit."""
import time

import pytest

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.planning_objective import plan_lexicographic_key
from test_benchmark_contract import comparison_request


def make_audited_serial_plan(length=100):
    request = comparison_request()
    request.vehicles[0].length_cm = length
    positions = [0, 0, 10, 0, 20]
    request.distance_matrix_meters = [[abs(a-b)*1000 for b in positions] for a in positions]
    request.duration_matrix_seconds = [[abs(a-b)*100 for b in positions] for a in positions]
    for order in request.orders:
        order.split_group_id = None
        order.source_order_id = order.id
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2, include_benchmarks=False)
    stops = []
    for order in engine.orders:
        valid, stops = engine._can_insert_order(0, stops, order, len(stops), len(stops)+1)
        assert valid
    plan = engine._build_final_response([stops], [], include_benchmarks=False)
    engine._best_audited_response([plan])
    assert not plan.unassigned_orders
    assert all(route.spatial_validation.is_valid for route in plan.routes)
    return engine, plan


def test_post_audit_search_finds_a_real_cheaper_feasible_plan():
    engine, plan = make_audited_serial_plan()
    before = plan.model_dump()
    polished = engine._polish_audited_response(plan, time.perf_counter()+1)
    assert not polished.unassigned_orders
    assert plan_lexicographic_key(polished) < plan_lexicographic_key(plan)
    assert polished.total_cost_vnd < plan.total_cost_vnd
    assert all(route.spatial_validation.is_valid for route in polished.routes)
    assert {cid for route in polished.routes for stop in route.stops for cid in stop.items_unloaded} == {"pkg-0", "pkg-1"}
    assert plan.model_dump() == before



@pytest.mark.parametrize("expired", [False, True])
def test_post_audit_search_keeps_valid_fallback_when_load_cannot_be_combined(expired):
    engine, plan = make_audited_serial_plan(length=60)
    before = plan.model_dump()
    deadline = time.perf_counter() + (-1 if expired else 1)
    polished = engine._polish_audited_response(plan, deadline)
    assert polished.model_dump() == before


def test_post_audit_search_can_consolidate_complete_orders_without_losing_cargo():
    request = comparison_request()
    for order in request.orders:
        order.split_group_id = None
        order.source_order_id = order.id
    request.vehicles.append(request.vehicles[0].model_copy(update={"id": "v2"}))
    request.drivers.append(request.drivers[0].model_copy(update={"id": "driver2"}))
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(6)] for i in range(6)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(6)] for i in range(6)]
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2, include_benchmarks=False)
    routes = []
    for index, order in enumerate(engine.orders):
        valid, stops = engine._can_insert_order(index, [], order, 0, 1)
        assert valid
        routes.append(stops)
    plan = engine._build_final_response(routes, [], include_benchmarks=False)
    engine._best_audited_response([plan])
    assert len(plan.routes) == 2
    before = plan.model_dump()
    polished = engine._polish_audited_response(plan, time.perf_counter()+1)
    assert len(polished.routes) == 1
    assert not polished.unassigned_orders
    assert plan_lexicographic_key(polished) < plan_lexicographic_key(plan)
    assert all(route.spatial_validation.is_valid for route in polished.routes)
    loaded = [item for route in polished.routes for stop in route.stops for item in stop.items_loaded]
    unloaded = [item for route in polished.routes for stop in route.stops for item in stop.items_unloaded]
    assert sorted(loaded) == sorted(unloaded) == ["pkg-0", "pkg-1"]
    assert plan.model_dump() == before


def test_post_audit_search_skips_payload_overflow_before_spatial_packing(monkeypatch):
    request = comparison_request()
    for order in request.orders:
        order.split_group_id = None
        order.source_order_id = order.id
        order.pickup_window_end_sec = 50
        order.delivery_window_start_sec = 60
        for item in order.items:
            item.weight_kg = 60.0
    request.vehicles[0].payload_limit_kg = 100.0
    request.vehicles.append(request.vehicles[0].model_copy(update={"id": "v2", "payload_limit_kg": 100.0}))
    request.drivers.append(request.drivers[0].model_copy(update={"id": "driver2"}))
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(6)] for i in range(6)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(6)] for i in range(6)]
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2, include_benchmarks=False)
    routes = []
    for index, order in enumerate(engine.orders):
        valid, stops = engine._can_insert_order(index, [], order, 0, 1)
        assert valid
        routes.append(stops)
    plan = engine._build_final_response(routes, [], include_benchmarks=False)
    engine._best_audited_response([plan])

    spatial_calls = []
    for checker in engine.checkers:
        orig_validate = checker.validate_route_stops
        monkeypatch.setattr(
            checker,
            "validate_route_stops",
            lambda stops, cargo, _orig=orig_validate: (
                spatial_calls.append(len(stops)) or _orig(stops, cargo)
            ),
        )
    polished = engine._polish_audited_response(plan, time.perf_counter() + 1)
    assert len(polished.routes) == 2
    assert not spatial_calls


def test_ranked_subtrip_moves_finds_closed_multi_order_segment_splice():
    from app.hybrid_alns.stop_moves import ranked_subtrip_moves

    # Route 0: depot=0, then [order-0 (2->3)] closed, then [order-1 (4->6), order-2 (5->7)] closed
    # Route 1: depot=1, then [order-3 (8->9)] where 8 is colocated with 4/5 and 9 is colocated with 6/7
    coords = [0, 0, 10, 10, 100, 100, 110, 110, 100, 110]
    matrix = [[abs(a - b) * 1000 for b in coords] for a in coords]
    routes = [[2, 3, 4, 5, 7, 6], [8, 9]]
    actions = [
        [
            ("o0", "PICKUP"),
            ("o0", "DELIVERY"),
            ("o1", "PICKUP"),
            ("o2", "PICKUP"),
            ("o2", "DELIVERY"),
            ("o1", "DELIVERY"),
        ],
        [("o3", "PICKUP"), ("o3", "DELIVERY")],
    ]
    moves = ranked_subtrip_moves(routes, actions, [0, 1], [0, 1], matrix, time.perf_counter() + 1.0)
    assert any(
        source == 0 and start == 2 and end == 6 and target == 1 and pos == 1 and delta < 0
        for _, delta, source, start, end, target, pos in moves
    )


def test_can_schedule_stops_matches_schedule_stops_feasibility():
    request = comparison_request()
    for order in request.orders:
        order.split_group_id = None
        order.source_order_id = order.id
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1, include_benchmarks=False)
    p0, d0 = engine._stop_templates_by_order_id[engine.orders[0].id]
    p1, d1 = engine._stop_templates_by_order_id[engine.orders[1].id]
    valid_stops = [p0, d0, p1, d1]
    assert engine._can_schedule_stops(0, valid_stops) is (engine._schedule_stops(0, valid_stops) is not None)

    engine.vehicles[0].available_end_sec = 10
    assert not engine._can_schedule_stops(0, valid_stops)
    assert engine._schedule_stops(0, valid_stops) is None


