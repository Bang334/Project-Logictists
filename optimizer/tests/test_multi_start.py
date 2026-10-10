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
    assert len(candidates) == 1
    # Fallback picks plan_2 because it has only 1 unassigned order vs 2
    assert candidates[0].result.total_cost_vnd == 400_000
    assert any("Cảnh báo" in d for d in diagnostics)


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
