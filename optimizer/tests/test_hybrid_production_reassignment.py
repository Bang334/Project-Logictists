"""Final vehicle changes must respect the confirmed company objective."""
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from test_benchmark_contract import comparison_request


def test_cheaper_operating_assignment_cannot_replace_better_company_plan():
    request = comparison_request()
    vehicle = request.vehicles[0]
    request.vehicles = [vehicle.model_copy(update={
        "id": f"v-{i}", "source_vehicle_id": f"physical-{i}",
        "depot": vehicle.depot.model_copy(update={"id": f"depot-{i}"}),
        "available_start_sec": 28800, "available_end_sec": 61200,
        "fixed_operating_cost_vnd": 1000 if i == 0 else 0,
        "fuel_consumption_liters_per_100_km": 1 if i == 0 else 150,
    }) for i in range(2)]
    request.drivers = [request.drivers[0].model_copy(update={
        "id": f"driver-{i}", "source_driver_id": f"driver-{i}",
        "fixed_salary_monthly_vnd": 1_000_000_000,
    }) for i in range(2)]
    positions = [10000, 100, 0, 0, 0, 0]
    request.distance_matrix_meters = [[abs(a-b) for b in positions] for a in positions]
    request.duration_matrix_seconds = [[abs(a-b)//10 for b in positions] for a in positions]
    for order in request.orders:
        order.source_order_id = order.id
        order.split_group_id = None
    engine = PackingAwareHybridALNSOptimizer(request, include_benchmarks=False)
    stops = []
    for order in engine.orders:
        valid, stops = engine._can_insert_order(0, stops, order, len(stops), len(stops)+1)
        assert valid
    routes = [stops, []]
    reassigned = engine._try_vehicle_reassignment(routes, [])
    assert reassigned is not None
    original_key = engine._rank_candidate_for_audit(routes, [])
    changed_key = engine._rank_candidate_for_audit(reassigned[1], [])
    assert changed_key[-2] < original_key[-2], "Operating cost really falls"
    assert changed_key > original_key, "Calendar salary removes that apparent saving"
    assert engine._production_vehicle_reassignment(routes, []) is None


def test_company_improving_vehicle_change_is_retained(monkeypatch):
    engine = PackingAwareHybridALNSOptimizer(comparison_request(), include_benchmarks=False)
    routes, missing = engine._repair_greedy_insert([[]], [o.id for o in engine.orders], randomize=False)
    assert not missing
    candidate = (1, routes, [])
    monkeypatch.setattr(engine, "_try_vehicle_reassignment", lambda *args: candidate)
    ranks = iter([(0, 0, 1, 10, 10, 1), (0, 0, 1, 20, 20, 1)])
    monkeypatch.setattr(engine, "_rank_candidate_for_audit", lambda *args: next(ranks))
    assert engine._production_vehicle_reassignment(routes, []) is candidate


def test_initial_matching_keeps_cost_preference_when_an_unused_driver_exists():
    request = comparison_request()
    request.vehicles = [request.vehicles[0].model_copy(update={"id": f"v-{i}"}) for i in range(2)]
    request.drivers = [request.drivers[0].model_copy(update={
        "id": f"driver-{i}", "trip_base_pay_vnd": i * 100000,
    }) for i in range(2)]
    size = len(request.vehicles) + len(request.orders)*2
    request.distance_matrix_meters = [[0]*size for _ in range(size)]
    request.duration_matrix_seconds = [[0]*size for _ in range(size)]
    engine = PackingAwareHybridALNSOptimizer(request)
    assert engine._matched_vehicle_driver_indices() == [(0, 0), (1, 1)]


def test_initial_matching_can_still_augment_to_cover_every_vehicle(monkeypatch):
    import app.hybrid_alns_engine as module
    request = comparison_request()
    request.vehicles = [request.vehicles[0].model_copy(update={
        "id": f"v-{i}", "payload_limit_kg": 1000+i,
    }) for i in range(3)]
    request.drivers = [request.drivers[0].model_copy(update={
        "id": f"driver-{i}", "license_class": f"L{i}",
    }) for i in range(3)]
    size = len(request.vehicles) + len(request.orders)*2
    request.distance_matrix_meters = [[0]*size for _ in range(size)]
    request.duration_matrix_seconds = [[0]*size for _ in range(size)]
    # A graph that requires an alternating path even with the free-first rule.
    eligible = {1000: {"L0", "L1"}, 1001: {"L1", "L2"}, 1002: {"L0", "L1"}}
    monkeypatch.setattr(module, "can_driver_drive_vehicle", lambda license, payload, _: license in eligible[payload])
    engine = PackingAwareHybridALNSOptimizer(request)
    pairs = engine._matched_vehicle_driver_indices()
    assert len(pairs) == 3
    assert len({driver for _, driver in pairs}) == 3
    assert all(request.drivers[d].license_class in eligible[request.vehicles[v].payload_limit_kg] for v, d in pairs)


def test_optimize_production_vehicles_returns_valid_search_state_when_improved():
    request = comparison_request()
    vehicle = request.vehicles[0]
    request.vehicles = [vehicle.model_copy(update={
        "id": f"v-{i}", "source_vehicle_id": f"physical-{i}",
        "depot": vehicle.depot.model_copy(update={"id": f"depot-{i}"}),
        "fixed_operating_cost_vnd": 500_000 if i == 0 else 50_000,
    }) for i in range(2)]
    request.drivers = [request.drivers[0].model_copy(update={
        "id": f"driver-{i}", "source_driver_id": f"driver-{i}",
    }) for i in range(2)]
    size = len(request.vehicles) + len(request.orders) * 2
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(size)] for i in range(size)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(size)] for i in range(size)]
    for order in request.orders:
        order.source_order_id = order.id
        order.split_group_id = None
    engine = PackingAwareHybridALNSOptimizer(request, include_benchmarks=False)
    stops = []
    for order in engine.orders:
        valid, stops = engine._can_insert_order(0, stops, order, len(stops), len(stops) + 1)
        assert valid
    routes = [stops, []]
    optimized = engine._optimize_production_vehicles(routes, [])
    assert optimized is not None
    cost, new_routes, new_unassigned = optimized
    assert isinstance(cost, int)
    assert not new_unassigned
    assert not new_routes[0] and new_routes[1]


def test_later_day_cheap_vehicle_is_compacted_onto_earlier_day_idle_vehicle_to_save_calendar_salary():
    request = comparison_request()
    vehicle = request.vehicles[0]
    # Day 0 has a cheaper B2 truck (busy with order 0) and a slightly more expensive C truck (idle).
    # Day 1 has a copy of the cheaper B2 truck (busy with order 1).
    request.vehicles = [
        vehicle.model_copy(update={
            "id": "v-b2-day0", "source_vehicle_id": "phys-b2", "service_day_index": 0,
            "depot": vehicle.depot.model_copy(update={"id": "depot-0"}),
            "available_start_sec": 28800, "available_end_sec": 64800,
            "payload_limit_kg": 2450.0,
            "fixed_operating_cost_vnd": 80_000,
            "fuel_consumption_liters_per_100_km": 12.5,
        }),
        vehicle.model_copy(update={
            "id": "v-c-day0", "source_vehicle_id": "phys-c", "service_day_index": 0,
            "depot": vehicle.depot.model_copy(update={"id": "depot-1"}),
            "available_start_sec": 28800, "available_end_sec": 64800,
            "payload_limit_kg": 5200.0,
            "fixed_operating_cost_vnd": 120_000,
            "fuel_consumption_liters_per_100_km": 18.5,
        }),
        vehicle.model_copy(update={
            "id": "v-b2-day1", "source_vehicle_id": "phys-b2", "service_day_index": 1,
            "depot": vehicle.depot.model_copy(update={"id": "depot-2"}),
            "available_start_sec": 86400 + 28800, "available_end_sec": 86400 + 64800,
            "payload_limit_kg": 2450.0,
            "fixed_operating_cost_vnd": 80_000,
            "fuel_consumption_liters_per_100_km": 12.5,
        }),
    ]
    base_driver = request.drivers[0]
    request.drivers = [
        base_driver.model_copy(update={
            "id": f"drv-b2-day{day}", "source_driver_id": "phys-drv-b2",
            "service_day_index": day, "license_class": "B2",
            "fixed_salary_monthly_vnd": 9_500_000, "trip_base_pay_vnd": 110_000, "per_km_pay_vnd": 900,
        })
        for day in (0, 1)
    ] + [
        base_driver.model_copy(update={
            "id": f"drv-c-day{day}", "source_driver_id": "phys-drv-c",
            "service_day_index": day, "license_class": "C",
            "fixed_salary_monthly_vnd": 13_000_000, "trip_base_pay_vnd": 170_000, "per_km_pay_vnd": 1200,
        })
        for day in (0, 1)
    ]
    size = len(request.vehicles) + len(request.orders) * 2
    request.distance_matrix_meters = [[0 if i == j else 1000 for j in range(size)] for i in range(size)]
    request.duration_matrix_seconds = [[0 if i == j else 60 for j in range(size)] for i in range(size)]
    for order in request.orders:
        order.source_order_id = order.id
        order.split_group_id = None
        order.pickup_window_start_sec = 0
        order.pickup_window_end_sec = 86400 * 2
        order.delivery_window_start_sec = 0
        order.delivery_window_end_sec = 86400 * 2

    engine = PackingAwareHybridALNSOptimizer(request, include_benchmarks=False)
    ok0, stops0 = engine._can_insert_order(0, [], engine.orders[0], 0, 1)
    ok2, stops2 = engine._can_insert_order(2, [], engine.orders[1], 0, 1)
    assert ok0 and ok2
    # Start with order 0 on Day 0 B2 truck, Day 0 C truck idle, and order 1 on Day 1 B2 truck
    routes = [stops0, [], stops2]
    optimized = engine._optimize_production_vehicles(routes, [])
    assert optimized is not None
    _, new_routes, new_unassigned = optimized
    assert not new_unassigned
    assert new_routes[0] and new_routes[1] and not new_routes[2], (
        "Route on Day 1 B2 truck must move to idle Day 0 C truck to eliminate Day 1 calendar payroll"
    )

