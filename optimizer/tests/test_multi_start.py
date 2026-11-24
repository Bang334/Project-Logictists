import time

import pytest
from app.models import (
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    CargoItem,
    ScheduledStop,
    SpatialValidationResult,
    UnassignedOrder,
)
from app.multi_start import (
    MultiStartFleetOptimizer,
    is_fully_served,
    select_ranked_candidates,
)
from app.search_strategies import SEARCH_STRATEGIES, SearchStrategy


@pytest.mark.parametrize("refinement_times_out, compare_horizons", [(False, False), (True, False), (False, True)])
def test_one_seed_ending_does_not_discard_its_checkpoint_or_another_seed(
    monkeypatch, refinement_times_out, compare_horizons,
):
    from concurrent.futures import Future
    import app.multi_start as module
    from test_benchmark_contract import comparison_request

    seen = []

    class ImmediatePool:
        def __init__(self, max_workers):
            assert max_workers == 2

        def submit(self, worker, *args):
            future = Future()
            future.set_result(worker(*args))
            return future

        def shutdown(self, **kwargs):
            pass

    def worker(request, _objective_request, seed, _budget, warm_plan=None):
        seen.append((seed, bool(request["early_stop_patience"])))
        if seed == 0 and warm_plan and refinement_times_out:
            return seed, None, None, "Hết thời gian tìm sâu"
        cost = 100 - seed * 10 - (5 if warm_plan and seed == 1 else 0)
        plan = _mock_plan("contract", "SUCCESS", cost, ["part-0", "part-1"])
        plan.routes[0].route_id = f"route-{seed}"
        if seed == 0 and warm_plan:
            plan.diagnostics = ["Seed 0 dừng sớm sau 1 phương án hợp lệ liên tiếp không cải thiện."]
        score = cost - (20 if compare_horizons and seed == 1 and warm_plan else 0)
        trips = 2 if compare_horizons and seed == 1 and warm_plan else 1
        return seed, plan.model_dump(), {"selection_score_vnd": score, "active_route_count": trips}, None

    # This test isolates the two workers; the independent direct seed is covered separately.
    monkeypatch.setattr(MultiStartFleetOptimizer, "_search_direct_span", lambda *args: None)
    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(module, "_run_hybrid_seed_worker", worker)
    monkeypatch.setattr(module, "is_fully_served", lambda plan, *_args, **_kwargs: plan.status == "SUCCESS")

    request = comparison_request().model_copy(update={"early_stop_patience": 1, "hybrid_seed_count": 2})
    if compare_horizons:
        vehicle = request.vehicles[0]
        request.vehicles.append(vehicle.model_copy(update={"id": "day-1", "service_day_index": 1}))
        for field in ("distance_matrix_meters", "duration_matrix_seconds"):
            matrix = getattr(request, field)
            node_order = [0, 0, *range(1, len(matrix))]
            setattr(request, field, [[matrix[i][j] for j in node_order] for i in node_order])
    batch = MultiStartFleetOptimizer(request).solve()

    assert seen == [(0, False), (1, False), (0, True), (1, True)]
    assert batch.solver_run_count == 2
    assert batch.candidates[0].search_strategy.endswith("(seed 1)")
    if compare_horizons:
        assert batch.candidates[0].result.planning_objective.selection_score_vnd == 65
    assert batch.candidates[1].result.total_cost_vnd == 100
    assert any("dừng sớm" in note for note in batch.candidates[1].result.diagnostics) is not refinement_times_out


def _mock_spatial_valid() -> SpatialValidationResult:
    return SpatialValidationResult(
        is_valid=True,
        max_weight_kg=1000.0,
        max_area_cm2=20000.0,
        step_states=[],
    )


def _mock_plan(
    job_id: str,
    status: str,
    cost: int,
    order_ids: list,
    unassigned_count: int = 0,
    spatial_valid: bool = True,
) -> FleetOptimizationResponse:
    spatial = _mock_spatial_valid()
    spatial.is_valid = spatial_valid
    stops = []
    for seq, oid in enumerate(order_ids, 1):
        previous_departure = 0 if seq == 1 else 100 * (seq - 1) + 30
        arrival = 100 * seq
        stops.append(
            ScheduledStop(
                sequence=seq,
                location_id=f"loc-{oid}",
                location_name=f"Loc {oid}",
                stop_type="PICKUP",
                order_id=oid,
                latitude=21.0,
                longitude=105.8,
                arrival_time_sec=arrival,
                departure_time_sec=arrival + 30,
                travel_time_sec=arrival - previous_departure,
                waiting_time_sec=0,
                service_time_sec=30,
            )
        )
    for stop in stops:
        stop.items_loaded = [f"{stop.order_id}-it"]
    for oid in order_ids:
        previous = stops[-1].departure_time_sec
        stops.append(ScheduledStop(
            sequence=len(stops) + 1,
            location_id=f"delivery-{oid}",
            location_name=f"Delivery {oid}",
            latitude=21.0,
            longitude=105.8,
            stop_type="DELIVERY",
            order_id=oid,
            items_unloaded=[f"{oid}-it"],
            arrival_time_sec=previous + 100,
            departure_time_sec=previous + 130,
            travel_time_sec=100,
            waiting_time_sec=0,
            service_time_sec=30,
        ))
    route = OptimizedRoute(
        vehicle_id="veh-1",
        start_time_sec=0,
        end_time_sec=stops[-1].departure_time_sec,
        plate_number="29C-12345",
        vehicle_length_cm=400,
        vehicle_width_cm=200,
        total_distance_km=10.0,
        total_duration_minutes=20.0,
        return_travel_time_sec=0,
        return_waiting_time_sec=0,
        stops=stops,
        spatial_validation=spatial,
    )
    unassigned = [
        UnassignedOrder(
            order_id=f"unassigned-{i}",
            order_number=f"ORD-U-{i}",
            reason_code="REASON",
            reason_message="msg",
        )
        for i in range(unassigned_count)
    ]
    return FleetOptimizationResponse(
        job_id=job_id,
        status=status,
        routes=[route],
        unassigned_orders=unassigned,
        total_cost_vnd=cost,
    )


def test_is_fully_served_checks_all_orders_and_spatial_validity():
    all_orders = {"o1", "o2"}

    # Valid complete plan
    good = _mock_plan("j1", "SUCCESS", 100_000, ["o1", "o2"])
    assert is_fully_served(good, all_orders) is True

    # Missing an order
    missing = _mock_plan("j1", "SUCCESS", 100_000, ["o1"])
    assert is_fully_served(missing, all_orders) is False

    # Status not SUCCESS
    partial = _mock_plan("j1", "PARTIAL", 100_000, ["o1", "o2"])
    assert is_fully_served(partial, all_orders) is False

    # Has unassigned orders
    has_unassigned = _mock_plan("j1", "SUCCESS", 100_000, ["o1", "o2"], unassigned_count=1)
    assert is_fully_served(has_unassigned, all_orders) is False

    # Spatial validation failed
    spatial_invalid = _mock_plan("j1", "SUCCESS", 100_000, ["o1", "o2"], spatial_valid=False)
    assert is_fully_served(spatial_invalid, all_orders) is False

    # A malformed candidate must be removed before the backend receives the
    # whole batch and rejects otherwise valid alternatives with it.
    timeline_invalid = _mock_plan("j1", "SUCCESS", 100_000, ["o1", "o2"])
    first_stop = timeline_invalid.routes[0].stops[0]
    first_stop.travel_time_sec = 99
    first_stop.waiting_time_sec = 0
    first_stop.service_time_sec = 30
    assert is_fully_served(timeline_invalid, all_orders) is False


def test_select_ranked_candidates_sorts_cheapest_and_deduplicates():
    all_orders = {"o1", "o2"}
    s1, s2, s3, s4 = SEARCH_STRATEGIES[:4]

    # Plan A: cost 500k, orders [o1, o2]
    plan_a = _mock_plan("j", "SUCCESS", 500_000, ["o1", "o2"])
    # Plan B: cost 300k, orders [o2, o1] (cheapest)
    plan_b = _mock_plan("j", "SUCCESS", 300_000, ["o2", "o1"])
    # Plan C: cost 400k, duplicate route structure of Plan A
    plan_c = _mock_plan("j", "SUCCESS", 400_000, ["o1", "o2"])
    # Plan D: cost 200k but partial (unassigned 1 order) -> must be excluded
    plan_d = _mock_plan("j", "PARTIAL", 200_000, ["o1"], unassigned_count=1)

    evaluated = [
        (s1, plan_a, 5000),
        (s2, plan_b, 3000),
        (s3, plan_c, 4000),
        (s4, plan_d, 2000),
    ]

    candidates, fully_served, diagnostics = select_ranked_candidates(
        evaluated, all_orders, max_candidates=3
    )

    assert fully_served == 3
    # Only 2 distinct fully-served plans (Plan C was deduplicated against Plan A / A against C)
    assert len(candidates) == 2

    # #1 should be the cheapest plan (Plan B: 300k)
    assert candidates[0].rank == 1
    assert candidates[0].is_best_found is True
    assert candidates[0].result.total_cost_vnd == 300_000
    assert candidates[0].search_strategy == s2.label

    # #2 should be the next distinct plan (Plan C: 400k)
    assert candidates[1].rank == 2
    assert candidates[1].is_best_found is False
    assert candidates[1].result.total_cost_vnd == 400_000


def test_select_ranked_candidates_prefers_shared_objective_over_route_cost():
    all_orders = {"o1", "o2"}
    compact_strategy, stretched_strategy = SEARCH_STRATEGIES[:2]
    compact = _mock_plan("j", "SUCCESS", 400_000, ["o1", "o2"])
    stretched = _mock_plan("j", "SUCCESS", 300_000, ["o2", "o1"])

    candidates, fully_served, _ = select_ranked_candidates(
        [
            (stretched_strategy, stretched, 2_000_000),
            (compact_strategy, compact, 1_000_000),
        ],
        all_orders,
        max_candidates=2,
    )

    assert fully_served == 2
    assert candidates[0].search_strategy == compact_strategy.label
    assert candidates[0].solver_objective == 1_000_000
    assert candidates[0].result.total_cost_vnd == 400_000


def test_select_ranked_candidates_fallback_when_none_fully_served():
    all_orders = {"o1", "o2", "o3"}
    s1, s2 = SEARCH_STRATEGIES[:2]

    # Both plans are incomplete
    plan_1 = _mock_plan("j", "PARTIAL", 300_000, ["o1"], unassigned_count=2)
    plan_2 = _mock_plan("j", "PARTIAL", 400_000, ["o1", "o2"], unassigned_count=1)

    evaluated = [
        (s1, plan_1, 3000),
        (s2, plan_2, 4000),
    ]

    candidates, fully_served, diagnostics = select_ranked_candidates(
        evaluated, all_orders, max_candidates=3
    )

    assert fully_served == 0
    assert candidates == []
    assert diagnostics


def test_multi_start_fleet_optimizer_runs_strategies_and_returns_batch():
    depot = LocationPoint(id="depot", name="Kho", latitude=21.0, longitude=105.8)
    vehicles = [
        FleetVehicle(
            id="truck-1", plate_number="29C-001", length_cm=400,
            width_cm=200, height_cm=200, payload_limit_kg=2000, depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=50_000,
        )
    ]
    drivers = [
        DriverOption(
            id="driver-1", full_name="Tài xế 1",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
    ]
    order = OrderPair(
        id="ord-1", order_number="ORD-01",
        pickup_location=LocationPoint(id="p1", name="P1", latitude=21.01, longitude=105.81),
        delivery_location=LocationPoint(id="d1", name="D1", latitude=21.02, longitude=105.82),
        items=[CargoItem(id="it-1", order_id="ord-1", length_cm=100, width_cm=80, height_cm=60, weight_kg=500)],
        pickup_window_start_sec=0, pickup_window_end_sec=3600,
        delivery_window_start_sec=0, delivery_window_end_sec=3600,
        service_time_sec=60,
    )
    matrix = [[0, 1000, 2000], [1000, 0, 1000], [2000, 1000, 0]]
    durations = [[0, 120, 240], [120, 0, 120], [240, 120, 0]]

    req = FleetOptimizationRequest(
        job_id="test-multi-start-job",
        vehicles=vehicles,
        drivers=drivers,
        orders=[order],
        policy=CostPolicy(fuel_price_per_liter_vnd=23_000, monthly_working_minutes=10_560),
        max_time_seconds=120,
        distance_matrix_meters=matrix,
        duration_matrix_seconds=durations,
    )

    optimizer = MultiStartFleetOptimizer(req)
    started_at = time.monotonic()
    batch = optimizer.solve(max_candidates=3)
    elapsed_seconds = time.monotonic() - started_at

    assert batch.job_id == "test-multi-start-job"
    assert batch.solver_run_count == 1
    assert optimizer.policy.time_budget_seconds == 3
    assert elapsed_seconds < 15
    assert batch.fully_served_candidate_count >= 1
    assert len(batch.candidates) >= 1
    assert batch.candidates[0].rank == 1
    assert batch.candidates[0].is_best_found is True
    assert batch.candidates[0].result.status == "SUCCESS"
    assert any("Vét cạn" in line for line in batch.diagnostics)
    assert any(
        "đã duyệt hết không gian tuyến nhỏ" in line
        for line in batch.candidates[0].result.diagnostics
    )


def test_optimizer_prunes_service_day_slots_that_cannot_serve_any_order():
    depot = LocationPoint(id="depot", name="Kho", latitude=12.25, longitude=109.18)
    vehicles = [
        FleetVehicle(
            id=f"truck-1::day:{day}",
            source_vehicle_id="truck-1",
            service_day_index=day,
            plate_number="79C-001",
            length_cm=500,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=3000,
            depot=depot,
            available_start_sec=day * 86_400 + 8 * 3600,
            available_end_sec=day * 86_400 + 17 * 3600,
            fuel_consumption_liters_per_100_km=12,
            fixed_operating_cost_vnd=50_000,
        )
        for day in range(7)
    ]
    drivers = [
        DriverOption(
            id=f"driver-1::day:{day}",
            source_driver_id="driver-1",
            service_day_index=day,
            full_name="Tài xế 1",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for day in range(7)
    ]
    day_two_start = 2 * 86_400 + 9 * 3600
    order = OrderPair(
        id="ord-day-2",
        order_number="ORD-DAY-2",
        pickup_location=LocationPoint(id="p1", name="P1", latitude=12.26, longitude=109.19),
        delivery_location=LocationPoint(id="d1", name="D1", latitude=12.27, longitude=109.20),
        items=[CargoItem(id="it-1", order_id="ord-day-2", length_cm=80, width_cm=80, height_cm=60, weight_kg=100)],
        pickup_window_start_sec=day_two_start,
        pickup_window_end_sec=day_two_start + 1800,
        delivery_window_start_sec=day_two_start,
        delivery_window_end_sec=day_two_start + 3600,
        service_time_sec=60,
    )
    size = len(vehicles) + 2
    distances = [[i * 100 + j for j in range(size)] for i in range(size)]
    durations = [[i * 10 + j for j in range(size)] for i in range(size)]
    request = FleetOptimizationRequest(
        job_id="prune-days",
        vehicles=vehicles,
        drivers=drivers,
        orders=[order],
        policy=CostPolicy(fuel_price_per_liter_vnd=23_000, monthly_working_minutes=10_560),
        max_time_seconds=120,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )

    optimizer = MultiStartFleetOptimizer(request)

    assert [vehicle.service_day_index for vehicle in optimizer.request.vehicles] == [2]
    assert [driver.service_day_index for driver in optimizer.request.drivers] == [2]
    assert optimizer.pruned_virtual_vehicle_count == 6
    assert optimizer.request.distance_matrix_meters == [
        [202, 207, 208],
        [702, 707, 708],
        [802, 807, 808],
    ]


def test_is_fully_served_enforces_max_routes_per_day():
    plan = _mock_plan("j-max-routes", "SUCCESS", 200_000, ["o1"])
    second_route = plan.routes[0].model_copy(
        update={"route_id": "veh-2", "vehicle_id": "veh-2", "plate_number": "79C-002"}
    )
    second_route.stops = [
        stop.model_copy(
            update={
                "order_id": "o2",
                "allocation_id": "o2",
                "items_loaded": ["o2-it"] if stop.stop_type == "PICKUP" else [],
                "items_unloaded": ["o2-it"] if stop.stop_type == "DELIVERY" else [],
            }
        )
        for stop in second_route.stops
    ]
    two_route_plan = plan.model_copy(update={"routes": [plan.routes[0], second_route]})
    assert is_fully_served(two_route_plan, {"o1", "o2"}, max_routes_per_day=None) is True
    assert is_fully_served(two_route_plan, {"o1", "o2"}, max_routes_per_day=2) is True
    assert is_fully_served(two_route_plan, {"o1", "o2"}, max_routes_per_day=1) is False


def test_optimizer_respects_max_routes_per_day_cap():
    depot = LocationPoint(id="depot", name="Kho", latitude=10.77, longitude=106.70)
    vehicles = [
        FleetVehicle(
            id=f"veh-{idx}",
            source_vehicle_id=f"veh-{idx}",
            service_day_index=0,
            plate_number=f"51C-00{idx}",
            length_cm=220,
            width_cm=150,
            height_cm=150,
            payload_limit_kg=1000,
            depot=depot,
            available_start_sec=0,
            available_end_sec=40_000,
            fuel_consumption_liters_per_100_km=12,
            fixed_operating_cost_vnd=100_000,
        )
        for idx in (1, 2)
    ]
    drivers = [
        DriverOption(
            id=f"drv-{idx}",
            source_driver_id=f"drv-{idx}",
            service_day_index=0,
            full_name=f"Tài xế {idx}",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for idx in (1, 2)
    ]
    orders = [
        OrderPair(
            id=f"ord-{idx}",
            order_number=f"ORD-{idx}",
            pickup_location=LocationPoint(id=f"p-{idx}", name=f"P{idx}", latitude=10.78, longitude=106.71),
            delivery_location=LocationPoint(id=f"d-{idx}", name=f"D{idx}", latitude=10.79, longitude=106.72),
            items=[CargoItem(id=f"item-{idx}", order_id=f"ord-{idx}", length_cm=180, width_cm=130, height_cm=100, weight_kg=600)],
            pickup_window_start_sec=0,
            pickup_window_end_sec=450,
            delivery_window_start_sec=0,
            delivery_window_end_sec=2200,
            service_time_sec=600,
        )
        for idx in (1, 2)
    ]
    size = len(vehicles) + 2 * len(orders)
    distances = [[0 if i == j else 2000 for j in range(size)] for i in range(size)]
    durations = [[0 if i == j else 300 for j in range(size)] for i in range(size)]
    request = FleetOptimizationRequest(
        job_id="max-routes-cap-test",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        policy=CostPolicy(
            fuel_price_per_liter_vnd=23_500,
            monthly_working_minutes=10_560,
            max_routes_per_day=1,
        ),
        max_time_seconds=10,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )

    batch = MultiStartFleetOptimizer(request).solve(max_candidates=2)
    assert batch.candidates == []
    assert batch.fully_served_candidate_count == 0


def test_pickup_only_and_missing_requested_item_are_rejected():
    plan = _mock_plan("regression", "SUCCESS", 100, ["o1"])
    assert is_fully_served(plan, {"o1"}, expected_items={"o1": {"o1-it"}})
    assert not is_fully_served(plan, {"o1"}, expected_items={"o1": {"o1-it", "missing"}})
    plan.routes[0].stops = plan.routes[0].stops[:1]
    plan.routes[0].end_time_sec = plan.routes[0].stops[-1].departure_time_sec
    assert not is_fully_served(plan, {"o1"})

def test_compare_horizons_keeps_two_days_and_a_cheaper_three_day_option():
    late = _mock_plan("job", "SUCCESS", 10, ["a", "b"])
    late.routes[0].service_day_index = 2
    early = _mock_plan("job", "SUCCESS", 20, ["a"])
    second = _mock_plan("job", "SUCCESS", 10, ["b"]).routes[0]
    second.service_day_index = 1
    early.routes.append(second)
    runs = [(SEARCH_STRATEGIES[0], late, 10), (SEARCH_STRATEGIES[1], early, 20)]
    another_late = late.model_copy(deep=True)
    another_late.routes[0].route_id = "other"
    runs.append((SEARCH_STRATEGIES[0], another_late, 12))
    ranked, count, _ = select_ranked_candidates(
        runs, {"a", "b"}, max_candidates=2, compare_horizons=True,
    )
    assert count == 3
    assert [candidate.result for candidate in ranked] == [late, early]


@pytest.mark.parametrize("can_share_vehicle", [True, False])
def test_direct_horizon_groups_orders_only_when_they_fit(can_share_vehicle):
    from test_benchmark_contract import comparison_request

    request = comparison_request()
    truck, driver = request.vehicles[0], request.drivers[0]
    if not can_share_vehicle:
        truck.payload_limit_kg = 15
    for day, order in enumerate(request.orders):
        order.split_group_id = None
        order.source_order_id = order.id
        order.pickup_window_start_sec = day * 86400
        order.delivery_window_start_sec = day * 86400
    request.orders[0].pickup_window_end_sec = 3600
    request.orders[0].delivery_window_end_sec = 3600
    extra = request.orders[0].model_copy(deep=True)
    extra.id = extra.source_order_id = "extra"
    extra.delivery_location.id = "extra-delivery"
    extra.items[0].id = "extra-pkg"
    extra.items[0].order_id = extra.id
    request.orders.append(extra)
    request.vehicles = [truck.model_copy(update={
        "id": f"truck-{day}", "source_vehicle_id": truck.id, "service_day_index": day,
        "available_start_sec": day * 86400, "available_end_sec": day * 86400 + 3600,
    }) for day in range(3)]
    request.drivers = [driver.model_copy(update={
        "id": f"driver-{day}", "source_driver_id": driver.id, "service_day_index": day,
    }) for day in range(3)]
    positions = [0, 0, 0, 0, 10, 0, 5, 0, 12]
    request.distance_matrix_meters = [[abs(a - b) * 1000 for b in positions] for a in positions]
    request.duration_matrix_seconds = [[abs(a - b) * 10 for b in positions] for a in positions]
    optimizer = MultiStartFleetOptimizer(request)
    _, direct = optimizer._direct_benchmark()
    assert direct.is_feasible and direct.planning_span_days == 2
    plan = optimizer._search_direct_span([0, 1], direct, time.perf_counter() + 3)
    assert plan is not None
    assert is_fully_served(plan, {o.id for o in request.orders},
                           expected_items={o.id: {i.id for i in o.items} for o in request.orders})
    assert sorted(route.service_day_index for route in plan.routes) == [0, 1]
    assert len(direct.routes) == 3
    day_one = next(route for route in plan.routes if route.service_day_index == 0)
    peak_onboard = max(
        len({item.order_id for item in step.placed_items})
        for step in day_one.spatial_validation.step_states
    )
    if can_share_vehicle:
        assert peak_onboard == 2
        assert plan.total_distance_km < direct.total_distance_km
        assert plan.total_duration_minutes < direct.total_duration_minutes
    else:
        assert peak_onboard == 1
        assert plan.total_distance_km == direct.total_distance_km


def test_multi_item_fixture_returns_all_ten_orders_and_every_package():
    from benchmark_hybrid_regression import load_request

    request = load_request("scenario_1_multi_item.json")
    batch = MultiStartFleetOptimizer(request).solve()
    expected = {order.id: {item.id for item in order.items} for order in request.orders}
    assert len(expected) == 10
    assert batch.candidates
    assert all(is_fully_served(candidate.result, set(expected), expected_items=expected)
               for candidate in batch.candidates)


def test_multi_start_excludes_direct_warm_start_and_keeps_post_solve_benchmark(monkeypatch):
    from concurrent.futures import Future
    import app.multi_start as module
    from app.models import BenchmarkComparisonResponse
    from test_benchmark_contract import comparison_request

    request = comparison_request()
    template = request.orders[0]
    request.orders = [
        template.model_copy(update={
            "id": f"ord-{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"ord-{i}",
            "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": f"p-{i}"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": f"d-{i}"}),
            "items": [template.items[0].model_copy(update={"id": f"pkg-{i}", "order_id": f"ord-{i}"})],
        })
        for i in range(50)
    ]
    n_nodes = len(request.vehicles) + 2 * len(request.orders)
    request.distance_matrix_meters = [[0 if i == j else 1000 for j in range(n_nodes)] for i in range(n_nodes)]
    request.duration_matrix_seconds = [[0 if i == j else 60 for j in range(n_nodes)] for i in range(n_nodes)]
    request = request.model_copy(update={"early_stop_patience": 0, "search_time_seconds": 12, "max_time_seconds": 14})

    order_ids = [o.id for o in request.orders]
    hybrid_plan = _mock_plan("contract", "SUCCESS", 180_000, list(reversed(order_ids)))
    hybrid_plan.routes[0].route_id = "hybrid-route"

    direct_stub = module.BenchmarkMetric(
        method_name="Direct",
        description="Direct",
        total_cost_vnd=200_000,
        total_distance_km=50.0,
        total_duration_minutes=60.0,
        vehicles_used=50,
        fuel_cost_vnd=50_000,
        vehicle_fixed_cost_vnd=50_000,
        driver_cost_vnd=100_000,
        cargo_holding_cost_vnd=0,
        late_delivery_penalty_vnd=0,
        planning_span_days=2,
        physical_vehicle_count=1,
        is_feasible=True,
    )

    class StubCalculator:
        def build_comparison(
            self,
            _routes,
            _total_cost,
            _total_km,
            _total_min,
            *,
            ortools_is_feasible,
            direct_metric,
        ):
            return BenchmarkComparisonResponse(
                or_tools=direct_metric,
                direct_dedicated=direct_metric,
                savings_vs_direct_vnd=20_000,
                savings_vs_direct_percent=10.0,
            )

    direct_calls = []

    def spy_direct_benchmark(_self):
        direct_calls.append("called")
        return StubCalculator(), direct_stub

    class ImmediatePool:
        def __init__(self, max_workers):
            pass

        def submit(self, worker, *args):
            future = Future()
            future.set_result(worker(*args))
            return future

        def shutdown(self, **kwargs):
            pass

    monkeypatch.setattr(MultiStartFleetOptimizer, "_direct_benchmark", spy_direct_benchmark)
    monkeypatch.setattr(
        MultiStartFleetOptimizer,
        "_search_direct_span",
        lambda *_args: pytest.fail("Direct warm-start candidate search must stay disabled"),
    )
    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(
        module,
        "_run_hybrid_seed_worker",
        lambda _req, _obj, seed, _budget, warm_plan=None: (
            seed,
            hybrid_plan.model_dump(),
            {"selection_score_vnd": 180_000, "active_route_count": 1},
            None,
        ),
    )
    monkeypatch.setattr(module, "is_fully_served", lambda plan, *_args, **_kwargs: plan.status == "SUCCESS")

    batch = MultiStartFleetOptimizer(request).solve(max_candidates=3)
    assert batch.candidates
    assert all("Direct warm-start" not in c.search_strategy for c in batch.candidates)
    assert batch.candidates[0].search_strategy == "Packing-aware Hybrid ALNS (seed 0)"
    assert direct_calls == ["called"]
    assert batch.candidates[0].result.benchmarks is not None
    assert batch.candidates[0].result.benchmarks.direct_dedicated.total_cost_vnd == 200_000

    # Verify _run_direct_span_worker error message helper contract remains intact if called directly.
    real_direct_worker = module._run_direct_span_worker
    monkeypatch.setattr(
        MultiStartFleetOptimizer,
        "_search_direct_span",
        lambda self, slots, direct, dl: None,
    )
    days, plan_out, _, err_msg = real_direct_worker(
        request.model_dump(),
        request.model_dump(),
        direct_stub.model_dump(),
        2,
        1.0,
    )
    assert days == 2
    assert plan_out is None
    assert err_msg == "Packing-aware Hybrid ALNS (Direct warm-start) không trả về tuyến."


def test_auto_multi_seed_runs_three_seeds_on_large_fleet_with_budget_and_multicore(monkeypatch):
    from concurrent.futures import Future
    import app.multi_start as module
    from test_benchmark_contract import comparison_request

    observed_seeds = []

    class ImmediatePool:
        def __init__(self, max_workers):
            self.max_workers = max_workers

        def submit(self, worker, *args):
            future = Future()
            future.set_result(worker(*args))
            return future

        def shutdown(self, **kwargs):
            pass

    request = comparison_request()
    template = request.orders[0]
    request.orders = [
        template.model_copy(update={
            "id": f"ord-{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"ord-{i}",
            "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": f"p-{i}"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": f"d-{i}"}),
            "items": [template.items[0].model_copy(update={"id": f"pkg-{i}", "order_id": f"ord-{i}"})],
        })
        for i in range(90)
    ]
    n_nodes = len(request.vehicles) + 2 * len(request.orders)
    request.distance_matrix_meters = [[0 if i == j else 1000 for j in range(n_nodes)] for i in range(n_nodes)]
    request.duration_matrix_seconds = [[0 if i == j else 60 for j in range(n_nodes)] for i in range(n_nodes)]
    request = request.model_copy(update={
        "hybrid_seed_count": 0,
        "early_stop_patience": 0,
        "search_time_seconds": 60,
        "max_time_seconds": 240,
    })

    plan = _mock_plan("large-auto", "SUCCESS", 100_000, [o.id for o in request.orders])
    monkeypatch.setattr(module.os, "cpu_count", lambda: 8)
    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(MultiStartFleetOptimizer, "_direct_benchmark", lambda self: (None, None))
    monkeypatch.setattr(
        module,
        "_run_hybrid_seed_worker",
        lambda _req, _obj, seed, _budget, warm_plan=None: (
            observed_seeds.append(seed) or seed,
            plan.model_dump(),
            {"selection_score_vnd": 100_000 + seed, "active_route_count": 1},
            None,
        ),
    )
    monkeypatch.setattr(module, "is_fully_served", lambda p, *_a, **_k: p.status == "SUCCESS")

    batch = MultiStartFleetOptimizer(request).solve(max_candidates=3)
    assert batch.candidates
    assert set(observed_seeds) == {0, 1, 2}


def test_extract_safe_ortools_seed_pool_combines_only_when_compatible():
    from app.multi_start import _extract_safe_ortools_seed_pool
    from test_benchmark_contract import comparison_request

    req = comparison_request()
    template = req.orders[0]
    req.orders = [
        template.model_copy(update={
            "id": f"ord-{i}",
            "order_number": f"ORD-{i}",
            "source_order_id": f"ord-{i}",
            "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": f"p-{i}"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": f"d-{i}"}),
            "items": [template.items[0].model_copy(update={"id": f"pkg-{i}", "order_id": f"ord-{i}"})],
        })
        for i in range(4)
    ]
    n_nodes = len(req.vehicles) + 2 * len(req.orders)
    req.distance_matrix_meters = [[0 if i == j else 1000 for j in range(n_nodes)] for i in range(n_nodes)]
    req.duration_matrix_seconds = [[0 if i == j else 60 for j in range(n_nodes)] for i in range(n_nodes)]

    pool_even = _extract_safe_ortools_seed_pool(req, seed=0, available_budget=6.0)
    assert pool_even is not None and any(pool_even[0])
    assert _extract_safe_ortools_seed_pool(req, seed=1, available_budget=6.0) is None
    assert _extract_safe_ortools_seed_pool(req, seed=0, available_budget=2.0) is None


def test_multi_seed_gives_all_seeds_equal_budget_across_waves(monkeypatch):
    from concurrent.futures import Future
    import app.multi_start as module
    from test_benchmark_contract import comparison_request

    observed_budgets = {}

    class ImmediatePool:
        def __init__(self, max_workers):
            self.max_workers = max_workers

        def submit(self, worker, *args):
            future = Future()
            future.set_result(worker(*args))
            return future

        def shutdown(self, **kwargs):
            pass

    plan = _mock_plan("equal-budget", "SUCCESS", 100_000, ["part-0", "part-1"])

    def worker(_req, _obj, seed, budget, warm_plan=None):
        observed_budgets[seed] = budget
        return seed, plan.model_dump(), {"selection_score_vnd": 100_000, "active_route_count": 1}, None

    monkeypatch.setattr(module.os, "cpu_count", lambda: 2)
    monkeypatch.setattr(module.concurrent.futures, "ProcessPoolExecutor", ImmediatePool)
    monkeypatch.setattr(module, "_run_hybrid_seed_worker", worker)
    monkeypatch.setattr(module, "is_fully_served", lambda p, *_a, **_k: p.status == "SUCCESS")

    request = comparison_request().model_copy(
        update={
            "early_stop_patience": 0,
            "hybrid_seed_count": 4,
            "search_time_seconds": 20,
            "max_time_seconds": 30,
        }
    )
    batch = MultiStartFleetOptimizer(request).solve(max_candidates=4)
    assert batch.candidates
    assert set(observed_budgets) == {0, 1, 2, 3}
    assert all(
        observed_budgets[s] == pytest.approx(observed_budgets[0], rel=1e-6)
        for s in (1, 2, 3)
    )


def test_secondary_seed_narrows_to_warm_days_like_seed_zero(monkeypatch):
    import app.multi_start as module
    from test_benchmark_contract import comparison_request

    request = comparison_request()
    vehicle = request.vehicles[0]
    request.vehicles = [
        vehicle.model_copy(
            update={
                "id": f"veh-day-{day}",
                "source_vehicle_id": "phys-0",
                "service_day_index": day,
                "available_start_sec": day * 86_400 + 28_800,
                "available_end_sec": day * 86_400 + 64_800,
            }
        )
        for day in range(3)
    ]
    request.drivers = [
        request.drivers[0].model_copy(
            update={"id": f"drv-day-{day}", "source_driver_id": "drv-0", "service_day_index": day}
        )
        for day in range(3)
    ]
    size = len(request.vehicles) + len(request.orders) * 2
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(size)] for i in range(size)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(size)] for i in range(size)]

    warm_plan = _mock_plan("warm-day-0", "SUCCESS", 100_000, [o.id for o in request.orders])
    warm_plan.routes[0].service_day_index = 0
    seen_vehicle_counts = []

    class SpyHybrid:
        def __init__(self, solver_req, **_kwargs):
            seen_vehicle_counts.append(len(solver_req.vehicles))

        def solve(self, hard_deadline=None):
            return warm_plan

    monkeypatch.setattr(module, "PackingAwareHybridALNSOptimizer", SpyHybrid)
    monkeypatch.setattr(module, "is_fully_served", lambda *_a, **_k: True)
    monkeypatch.setattr(
        module,
        "apply_planning_objective",
        lambda _req, _plan: module.PlanningObjectiveBreakdown(selection_score_vnd=100_000),
    )

    seed, plan_out, _, err = module._run_hybrid_seed_worker(
        request.model_dump(),
        request.model_dump(),
        1,
        10.0,
        warm_plan.model_dump(),
    )
    assert seed == 1
    assert err is None and plan_out is not None
    assert seen_vehicle_counts == [1]


def test_multi_start_returns_cancelled_immediately_when_cancel_event_set():
    import threading
    from fastapi.testclient import TestClient
    from app.main import app
    from test_benchmark_contract import comparison_request

    req = comparison_request()
    cancel_event = threading.Event()
    cancel_event.set()
    batch = MultiStartFleetOptimizer(req, cancel_event=cancel_event).solve(max_candidates=3)
    assert batch.candidates == []
    assert batch.no_plan_status == "NO_COMPLETE_PLAN"
    assert any("hủy" in msg.lower() for msg in batch.diagnostics)

    res = TestClient(app).post("/optimize-fleet/jobs/non-existent-job/cancel")
    assert res.status_code == 200
    assert res.json() == {"job_id": "non-existent-job", "cancelled": False}


def test_salvage_route_jit_start_adjusts_first_stop_waiting_to_pass_is_fully_served(monkeypatch):
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from test_benchmark_contract import comparison_request

    base = comparison_request()
    order = base.orders[0].model_copy(
        update={
            "split_group_id": None,
            "source_order_id": base.orders[0].id,
            "pickup_window_start_sec": 3600,
        }
    )
    veh0 = base.vehicles[0]
    veh1 = veh0.model_copy(update={"id": "v-salvage", "plate_number": "TEST-2"})
    drv0 = base.drivers[0]
    drv1 = drv0.model_copy(update={"id": "driver-2"})
    req = base.model_copy(
        update={
            "demo_stacking": None,
            "orders": [order],
            "vehicles": [veh0, veh1],
            "drivers": [drv0, drv1],
            "distance_matrix_meters": [[0 if i == j else 1000 for j in range(4)] for i in range(4)],
            "duration_matrix_seconds": [[0 if i == j else 1569 for j in range(4)] for i in range(4)],
        }
    )
    optimizer = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=10.0, should_split_orders=False)
    scheduled_v0, _, _ = optimizer._schedule_stops(
        0,
        [
            ScheduledStop(
                sequence=1,
                stop_type="PICKUP",
                order_id=order.id,
                location_id=order.pickup_location.id,
                location_name=order.pickup_location.name,
                latitude=order.pickup_location.latitude,
                longitude=order.pickup_location.longitude,
                arrival_time_sec=0,
                departure_time_sec=0,
                items_loaded=[order.items[0].id],
                items_unloaded=[],
            ),
            ScheduledStop(
                sequence=2,
                stop_type="DELIVERY",
                order_id=order.id,
                location_id=order.delivery_location.id,
                location_name=order.delivery_location.name,
                latitude=order.delivery_location.latitude,
                longitude=order.delivery_location.longitude,
                arrival_time_sec=0,
                departure_time_sec=0,
                items_loaded=[],
                items_unloaded=[order.items[0].id],
            ),
        ],
    )
    # Force primary route (v0) spatial check to fail so salvage constructs route on v-salvage (v1)
    monkeypatch.setattr(
        optimizer,
        "_validate_spatial_actions",
        lambda vehicle_index, _actions, max_time_seconds=None: SpatialValidationResult(
            is_valid=(vehicle_index == 1),
            violation_code=None if vehicle_index == 1 else "PLACEMENT_SEARCH_LIMIT_REACHED",
        ),
    )
    res = optimizer._build_final_response(
        [scheduled_v0, []],
        [],
        include_benchmarks=False,
        spatial_time_budget_seconds=5.0,
    )
    assert res.status == "SUCCESS"
    assert len(res.routes) == 1
    assert res.routes[0].vehicle_id == "v-salvage"
    assert res.routes[0].start_time_sec == 2031
    assert res.routes[0].stops[0].waiting_time_sec == 0
    assert is_fully_served(res, {order.id}, expected_items={order.id: {order.items[0].id}})


def test_audited_cycle_checkpoint_reserves_audit_budget_and_skips_duplicate_routes(monkeypatch):
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from test_benchmark_contract import comparison_request

    base = comparison_request()
    orders = [
        order.model_copy(update={"split_group_id": None, "source_order_id": order.id})
        for order in base.orders
    ]
    veh0 = base.vehicles[0]
    veh1 = veh0.model_copy(update={"id": "v2", "plate_number": "TEST-2"})
    req = base.model_copy(
        update={
            "orders": orders,
            "vehicles": [veh0, veh1],
            "drivers": [base.drivers[0], base.drivers[0].model_copy(update={"id": "driver2"})],
            "distance_matrix_meters": [[0 if i == j else 100 for j in range(6)] for i in range(6)],
            "duration_matrix_seconds": [[0 if i == j else 10 for j in range(6)] for i in range(6)],
        }
    )
    optimizer = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=5.0, should_split_orders=False)
    sample_stop = ScheduledStop(
        sequence=1,
        stop_type="PICKUP",
        order_id=orders[0].id,
        location_id=orders[0].pickup_location.id,
        location_name=orders[0].pickup_location.name,
        latitude=orders[0].pickup_location.latitude,
        longitude=orders[0].pickup_location.longitude,
        arrival_time_sec=0,
        departure_time_sec=0,
        items_loaded=[orders[0].items[0].id],
        items_unloaded=[],
    )
    construction_windows = []
    audit_calls = 0

    def spy_construct(_sequence, construction_deadline, _vehicle_indices, fit_cache=None):
        construction_windows.append(construction_deadline - time.perf_counter())
        return [[sample_stop], []], []

    def spy_bfr(*_args, **_kwargs):
        nonlocal audit_calls
        audit_calls += 1
        return FleetOptimizationResponse(
            job_id="contract",
            status="PARTIAL",
            routes=[],
            unassigned_orders=[
                UnassignedOrder(
                    order_id=orders[0].id,
                    order_number=orders[0].order_number,
                    reason_code="TEST",
                    reason_message="failed",
                )
            ],
        )

    monkeypatch.setattr(optimizer, "_conservative_cycle_construction", spy_construct)
    monkeypatch.setattr(optimizer, "_build_final_response", spy_bfr)

    started = time.perf_counter()
    res = optimizer._audited_cycle_checkpoint([0, 1], started + 4.0, max_attempts=3)
    assert res is None
    assert len(construction_windows) == 3
    assert construction_windows[0] <= 2.0  # Reserved >= 55% of 4.0s for _build_final_response
    assert audit_calls == 1  # Identical constructed routes skipped duplicate expensive audit



