"""Polish repaired plans using real costs and another full spatial audit."""
from itertools import permutations
import json
import time
from pathlib import Path

import pytest

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import FleetOptimizationRequest, SpatialValidationResult
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


def test_polish_caps_candidate_audit_and_keeps_incumbent_at_deadline(monkeypatch):
    engine, plan = make_audited_serial_plan()
    before = plan.model_dump()
    now = [0.0]
    budgets = []
    validate = engine._validate_spatial_actions

    def audit(vehicle_index, actions, max_time_seconds=None):
        budgets.append(max_time_seconds)
        result = validate(vehicle_index, actions, max_time_seconds=max_time_seconds)
        now[0] = 1.0
        return result

    monkeypatch.setattr(time, "perf_counter", lambda: now[0])
    monkeypatch.setattr(engine, "_validate_spatial_actions", audit)
    result = engine._polish_audited_response(plan, 0.28)
    assert len(budgets) == 1 and 0 < budgets[0] <= 0.28
    assert result is plan
    assert plan.model_dump() == before


def test_failed_spatial_trial_keeps_verified_plan_without_salvage(monkeypatch):
    engine, plan = make_audited_serial_plan()
    before = plan.model_dump()
    engine.initial_plan = plan
    _, routes, _ = engine._warm_start_state()
    calls = []

    def expire(*_args, **_kwargs):
        calls.append(1)
        return SpatialValidationResult(
            is_valid=False, violation_code="PLACEMENT_SEARCH_LIMIT_REACHED",
        )

    monkeypatch.setattr(engine, "_validate_spatial_actions", expire)
    retained = engine._build_final_response(
        routes, [], include_benchmarks=False,
        polish_checkpoint=(time.perf_counter() + 1, plan),
    )
    assert retained is plan
    assert calls == [1]
    assert plan.model_dump() == before


def test_solve_returns_verified_construction_plan_after_search_deadline(monkeypatch):
    from app import hybrid_alns_engine
    from app.multi_start import is_fully_served

    engine, plan = make_audited_serial_plan()
    now = [10.0]
    expected = {order.id: {item.id for item in order.items} for order in engine.orders}

    def construct(*_args, **_kwargs):
        engine._verified_construction_plan = plan
        now[0] += 3
        return None

    monkeypatch.setattr(hybrid_alns_engine, "LARGE_SEED_ORDER_COUNT", len(engine.orders))
    monkeypatch.setattr(time, "perf_counter", lambda: now[0])
    monkeypatch.setattr(engine, "_build_hybrid_initial_solution", construct)

    result = engine.solve(hard_deadline=12)
    assert result is plan
    assert is_fully_served(result, set(expected), engine.request.policy.max_routes_per_day, expected)


def test_sequential_cycle_checkpoint_serves_ten_multi_item_orders():
    from app.multi_start import is_fully_served
    from benchmark_hybrid_regression import load_request

    request = load_request("scenario_1_multi_item.json")
    original_fleet_size = len(request.vehicles)
    indices = [0, 1, *range(original_fleet_size, original_fleet_size + 2 * len(request.orders))]
    request.distance_matrix_meters = [
        [request.distance_matrix_meters[i][j] for j in indices] for i in indices
    ]
    request.duration_matrix_seconds = [
        [request.duration_matrix_seconds[i][j] for j in indices] for i in indices
    ]
    request.vehicles = request.vehicles[:2]
    request.drivers = request.drivers[:2]
    engine = PackingAwareHybridALNSOptimizer(request, include_benchmarks=False)
    result = engine._audited_cycle_checkpoint([0, 1], time.perf_counter() + 5)
    expected = {order.id: {item.id for item in order.items} for order in request.orders}
    assert result is not None
    assert is_fully_served(result, set(expected), request.policy.max_routes_per_day, expected)
    assert {route.driver_id for route in result.routes} == {driver.id for driver in request.drivers}



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




@pytest.mark.parametrize(
    "order_count,vehicle_index,incumbent_nodes,before_km,minimum_km",
    [
        (4, 0, [5, 1, 3, 7, 2, 4, 6, 8], 48, 46),
        (5, 0, [5, 1, 3, 9, 7, 2, 4, 6, 8, 10], 52, 48),
        (7, 0, [3, 1, 13, 11, 5, 9, 12, 10, 4, 7, 2, 6, 14, 8], 58, 54),
        (7, 1, [3, 1, 13, 11, 5, 9, 12, 10, 4, 7, 2, 6, 14, 8], 58, 54),
        (8, 0, [3, 1, 13, 11, 5, 9, 12, 10, 4, 7, 2, 6, 14, 8, 15, 16], 58, 54),
    ],
)
def test_post_audit_improves_short_route_requiring_multiple_stop_changes(
    order_count, vehicle_index, incumbent_nodes, before_km, minimum_km,
):
    # Exact distance references from independent pickup-before-delivery checks.
    coordinates = [
        (0, 0), (4, 1), (4, 9), (2, 4), (10, 3), (6, 1),
        (7, 2), (2, 10), (2, 2), (1, 9), (1, 3),
    ][:2 * order_count + 1]
    if order_count >= 7:
        coordinates = [
            (0, 0), (5, 2), (2, 10), (6, 1), (9, 4), (1, 7), (1, 10),
            (7, 9), (2, 3), (5, 7), (8, 5), (1, 8), (7, 5), (3, 8), (1, 5),
        ]
    fixture_name = "corridor_07_reverse.json" if order_count >= 7 else f"corridor_{order_count:02}_fifo.json"
    fixture = (
        Path(__file__).resolve().parent / "fixtures"
        / fixture_name
    )
    request = FleetOptimizationRequest.model_validate(json.loads(fixture.read_text(encoding="utf8")))
    if order_count == 8:
        extra = request.orders[-1].model_copy(deep=True)
        extra.id = extra.order_number = "extra-order"
        extra.items[0].id = "extra-item"
        extra.items[0].order_id = extra.id
        extra.pickup_location.id = "extra-pickup"
        extra.delivery_location.id = "extra-delivery"
        request.orders.append(extra)
        coordinates.extend([(0, 0), (0, 0)])
    if vehicle_index == 1:
        request.vehicles.insert(0, request.vehicles[0].model_copy(update={"id": "other-truck"}))
        coordinates.insert(0, (50, 50))
        for order in request.orders:
            order.allowed_source_vehicle_ids = [request.vehicles[1].id]
    grid_distances = [
        [abs(x - other_x) + abs(y - other_y) for other_x, other_y in coordinates]
        for x, y in coordinates
    ]
    request.distance_matrix_meters = [[km * 1000 for km in row] for row in grid_distances]
    request.duration_matrix_seconds = [[km * 60 for km in row] for row in grid_distances]
    request.drivers[0].fixed_salary_monthly_vnd = 0
    for order in request.orders:
        order.pickup_window_start_sec = order.delivery_window_start_sec = 0
        order.pickup_window_end_sec = order.delivery_window_end_sec = 28_800
        order.pickup_service_time_sec = order.delivery_service_time_sec = 0
        item, = order.items
        item.length_cm = item.width_cm = item.height_cm = 20
        item.weight_kg = 1

    if order_count == 8:
        request.orders[-1].pickup_window_start_sec = 20_000
        for order in request.orders[:-1]:
            order.delivery_window_end_sec = 10_000

    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2, include_benchmarks=False)
    stops = []
    for order in engine.orders:
        valid, stops = engine._can_insert_order(vehicle_index, stops, order, len(stops), len(stops) + 1)
        assert valid
    stops_by_node = {engine._stop_node_index(stop): stop for stop in stops}
    route = [stops_by_node[node + vehicle_index] for node in incumbent_nodes]
    routes = [[]] * vehicle_index + [route]
    incumbent = engine._build_final_response(routes, [], include_benchmarks=False)
    engine._best_audited_response([incumbent])
    assert incumbent.status == "SUCCESS"
    assert incumbent.total_distance_km == before_km

    improved = engine._polish_audited_response(incumbent, time.perf_counter() + 1)
    assert improved.status == "SUCCESS"
    assert improved.total_distance_km == minimum_km
    assert improved.total_cost_vnd == 200_000 + 4_260 * minimum_km
    improved_route, = improved.routes
    assert improved_route.spatial_validation.is_valid
    expected_items = {item.id for order in request.orders for item in order.items}
    for field in ("items_loaded", "items_unloaded"):
        actual_items = [item for stop in improved_route.stops for item in getattr(stop, field)]
        assert sorted(actual_items) == sorted(expected_items)

@pytest.mark.parametrize("seed", range(6))
def test_window_sequences_match_permutation_reference(seed):
    import random
    from app.hybrid_alns.stop_moves import ranked_short_route_sequences

    # A was picked before this window, B will be delivered after it.
    # C and D have both actions inside. Two visits use the same matrix node.
    nodes = [1, 2, 3, 2, 4, 5]
    actions = [
        ("A", "DELIVERY"), ("C", "PICKUP"), ("B", "PICKUP"),
        ("D", "PICKUP"), ("C", "DELIVERY"), ("D", "DELIVERY"),
    ]
    rng = random.Random(seed)
    distances = [[0 if i == j else rng.randrange(1, 25) for j in range(7)] for i in range(7)]

    def distance(sequence):
        path = [0, *(nodes[index] for index in sequence), 6]
        return sum(distances[a][b] for a, b in zip(path, path[1:]))

    initial = distance(range(len(nodes)))
    permitted = [
        path for path in permutations(range(len(nodes)))
        if path.index(1) < path.index(4) and path.index(3) < path.index(5)
    ]
    expected = sorted(distance(path) - initial for path in permitted if distance(path) < initial)
    moves = ranked_short_route_sequences(
        nodes, actions, 0, distances, time.perf_counter() + 1, end_node=6,
    )
    assert [delta for delta, _ in moves] == expected[:12]
    assert len({path for _, path in moves}) == len(moves)
    assert all(path in permitted and distance(path) - initial == delta for delta, path in moves)


def test_polish_preserves_two_trips_mapped_to_one_vehicle_slot():
    engine, plan = make_audited_serial_plan()
    original, = plan.routes
    # Both trips return to the same truck/day slot. Each carries a distinct order.
    serial_trips = [
        original.model_copy(update={"stops": original.stops[start:start + 2]})
        for start in (0, 2)
    ]
    plan = plan.model_copy(update={"routes": serial_trips})
    before = plan.model_dump()
    assert engine._routes_from_audited_response(plan) is None
    assert engine._polish_audited_response(plan, time.perf_counter() + 1).model_dump() == before
