"""Unit tests for cross-seed CP-SAT route recombination."""

from __future__ import annotations

from app.cross_seed_partitioning import solve_cross_seed_set_partitioning
from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
)


def _loc(loc_id: str) -> LocationPoint:
    return LocationPoint(id=loc_id, name=loc_id, latitude=16.05, longitude=108.20)


def _route_for_orders(
    *,
    vehicle: FleetVehicle,
    orders: list[OrderPair],
    cost_vnd: int,
    driver_salary_vnd: int = 100_000,
    start_sec: int = 28_800,
    end_sec: int = 32_400,
    spatial_valid: bool = True,
) -> OptimizedRoute:
    stops = []
    seq = 1
    prev_dep = start_sec
    for order in orders:
        pickup_arr = prev_dep + 240
        pickup_dep = pickup_arr + 60
        stops.append(
            ScheduledStop(
                sequence=seq,
                stop_type="PICKUP",
                location_id=order.pickup_location.id,
                location_name=order.pickup_location.name,
                order_id=order.id,
                allocation_id=order.id,
                latitude=order.pickup_location.latitude,
                longitude=order.pickup_location.longitude,
                arrival_time_sec=pickup_arr,
                departure_time_sec=pickup_dep,
                travel_time_sec=240,
                waiting_time_sec=0,
                service_time_sec=60,
                items_loaded=[it.id for it in order.items],
                items_unloaded=[],
            )
        )
        seq += 1
        deliv_arr = pickup_dep + 240
        deliv_dep = deliv_arr + 60
        stops.append(
            ScheduledStop(
                sequence=seq,
                stop_type="DELIVERY",
                location_id=order.delivery_location.id,
                location_name=order.delivery_location.name,
                order_id=order.id,
                allocation_id=order.id,
                latitude=order.delivery_location.latitude,
                longitude=order.delivery_location.longitude,
                arrival_time_sec=deliv_arr,
                departure_time_sec=deliv_dep,
                travel_time_sec=240,
                waiting_time_sec=0,
                service_time_sec=60,
                items_loaded=[],
                items_unloaded=[it.id for it in order.items],
            )
        )
        seq += 1
        prev_dep = deliv_dep
    route_end_sec = max(end_sec, prev_dep + 60)
    return OptimizedRoute(
        route_id=vehicle.id,
        vehicle_id=vehicle.source_vehicle_id or vehicle.id,
        service_day_index=vehicle.service_day_index,
        plate_number=vehicle.plate_number,
        vehicle_length_cm=vehicle.length_cm,
        vehicle_width_cm=vehicle.width_cm,
        vehicle_height_cm=vehicle.height_cm,
        start_time_sec=start_sec,
        end_time_sec=route_end_sec,
        total_distance_km=20.0,
        total_duration_minutes=(route_end_sec - start_sec) / 60.0,
        return_travel_time_sec=route_end_sec - prev_dep,
        return_waiting_time_sec=0,
        stops=stops,
        spatial_validation=SpatialValidationResult(
            is_valid=spatial_valid,
            max_weight_kg=100.0,
            max_area_cm2=5000.0,
            step_states=[],
        ),
        cost=RouteCostBreakdown(
            base_fuel_cost_vnd=cost_vnd - driver_salary_vnd,
            load_fuel_surcharge_vnd=0,
            fuel_cost_vnd=cost_vnd - driver_salary_vnd,
            cargo_holding_cost_vnd=0,
            late_delivery_penalty_vnd=0,
            cargo_distance_ton_km=1.0,
            cargo_time_ton_hours=0.5,
            vehicle_fixed_cost_vnd=0,
            driver_fixed_salary_allocation_vnd=driver_salary_vnd,
            driver_trip_pay_vnd=0,
            total_cost_vnd=cost_vnd,
        ),
    )


def _sample_problem():
    depot = _loc("depot")
    vehicles = [
        FleetVehicle(
            id=f"v{i}#d0",
            source_vehicle_id=f"v{i}",
            service_day_index=0,
            plate_number=f"43C-00{i}",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=5000,
            available_start_sec=28_800,
            available_end_sec=61_200,
            depot=depot,
            fuel_consumption_liters_per_100_km=12.0,
            fixed_operating_cost_vnd=100_000,
        )
        for i in range(2)
    ]
    drivers = [
        DriverOption(
            id=f"drv{i}#d0",
            source_driver_id=f"drv{i}",
            service_day_index=0,
            full_name=f"Driver {i}",
            license_class="C",
            fixed_salary_monthly_vnd=15_000_000,
            trip_base_pay_vnd=0,
            per_km_pay_vnd=0,
        )
        for i in range(2)
    ]
    orders = [
        OrderPair(
            id=f"o{i}",
            order_number=f"ORD-{i}",
            pickup_location=_loc(f"p{i}"),
            delivery_location=_loc(f"d{i}"),
            items=[CargoItem(id=f"it{i}", order_id=f"o{i}", length_cm=50, width_cm=40, height_cm=40, weight_kg=50)],
        )
        for i in range(2)
    ]
    n = len(vehicles) + 2 * len(orders)
    req = FleetOptimizationRequest(
        job_id="cross-seed-test",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        policy=CostPolicy(fuel_price_per_liter_vnd=24_000, monthly_working_minutes=12_480),
        distance_matrix_meters=[[0 if a == b else 1000 for b in range(n)] for a in range(n)],
        duration_matrix_seconds=[[0 if a == b else 60 for b in range(n)] for a in range(n)],
    )
    expected = {o.id: {it.id for it in o.items} for o in orders}
    return req, vehicles, orders, expected


def test_cross_seed_combines_best_routes_from_two_seeds():
    req, vehicles, orders, expected = _sample_problem()
    # Seed 0 has cheap v0 route for o0, expensive v1 route for o1.
    plan_s0 = FleetOptimizationResponse(
        job_id="cross-seed-test",
        status="SUCCESS",
        total_cost_vnd=1_000_000,
        routes=[
            _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=300_000),
            _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=700_000),
        ],
    )
    # Seed 1 has expensive v0 route for o0, cheap v1 route for o1.
    plan_s1 = FleetOptimizationResponse(
        job_id="cross-seed-test",
        status="SUCCESS",
        total_cost_vnd=1_000_000,
        routes=[
            _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=650_000),
            _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=350_000),
        ],
    )
    res = solve_cross_seed_set_partitioning(req, [plan_s0, plan_s1], expected, compare_horizons=False)
    assert res is not None
    combined, _ = res
    # Driver salary gets recomputed from DriverOption (15M * 60 / 12480 ~= 72,115 per route),
    # while fuel portions (200k + 250k = 450k) pick cheap v0 from Seed 0 and cheap v1 from Seed 1.
    assert len(combined.routes) == 2
    assert combined.total_cost_vnd < 700_000
    assert combined.routes[0].driver_id != combined.routes[1].driver_id


def test_cross_seed_rejects_same_vehicle_plate_conflict_or_invalid_3d():
    req, vehicles, orders, expected = _sample_problem()
    # Both plans only use vehicle 0 -> cannot pick both routes at once.
    v0_o0_invalid = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=200_000, spatial_valid=False)
    v0_o1_valid = _route_for_orders(vehicle=vehicles[0], orders=[orders[1]], cost_vnd=250_000, spatial_valid=True)
    v1_o0_valid = _route_for_orders(vehicle=vehicles[1], orders=[orders[0]], cost_vnd=500_000, spatial_valid=True)
    plan_a = FleetOptimizationResponse(job_id="t", status="SUCCESS", routes=[v0_o0_invalid, v1_o0_valid])
    plan_b = FleetOptimizationResponse(job_id="t", status="SUCCESS", routes=[v0_o1_valid])

    res = solve_cross_seed_set_partitioning(req, [plan_a, plan_b], expected, compare_horizons=False)
    assert res is not None
    combined, _ = res
    # v0_o0_invalid was excluded, so CP-SAT picked v1_o0_valid + v0_o1_valid cleanly.
    assert len(combined.routes) == 2
    assert {r.stops[0].order_id for r in combined.routes} == {"o0", "o1"}
    assert {r.plate_number for r in combined.routes} == {"43C-000", "43C-001"}


def test_cross_seed_combines_single_plan_with_audited_extra_routes():
    req, vehicles, orders, expected = _sample_problem()
    # Single complete baseline plan uses expensive v1; audited extra_routes supplies cheap v1
    # from another basin plus an invalid 3D v0 shortcut that must be ignored.
    plan_s0 = FleetOptimizationResponse(
        job_id="cross-seed-test",
        status="SUCCESS",
        total_cost_vnd=1_000_000,
        routes=[
            _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=300_000),
            _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=700_000),
        ],
    )
    cheap_alt_v1 = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=320_000)
    invalid_alt_v0 = _route_for_orders(
        vehicle=vehicles[0], orders=[orders[0]], cost_vnd=120_000, spatial_valid=False,
    )

    res = solve_cross_seed_set_partitioning(
        req,
        [plan_s0],
        expected,
        compare_horizons=False,
        extra_routes=[cheap_alt_v1, invalid_alt_v0],
    )
    assert res is not None
    combined, _ = res
    assert len(combined.routes) == 2
    assert combined.total_cost_vnd < 700_000
    assert combined.routes[0].driver_id != combined.routes[1].driver_id


def test_cross_seed_reassigns_interchangeable_vehicle_profile_across_seeds():
    req, vehicles, orders, expected = _sample_problem()
    v0, v1 = vehicles[0], vehicles[1]
    # Use realistic backend daily slot IDs for both vehicles and drivers.
    v0 = v0.model_copy(update={"id": "v0::day:0", "source_vehicle_id": "v0"})
    v1 = v1.model_copy(update={"id": "v1::day:0", "source_vehicle_id": "v1"})
    d0 = req.drivers[0].model_copy(update={"id": "drv0::day:0", "source_driver_id": "drv0"})
    d1 = req.drivers[1].model_copy(update={"id": "drv1::day:0", "source_driver_id": "drv1"})
    req = req.model_copy(update={"vehicles": [v0, v1], "drivers": [d0, d1]})

    # Seed 0 puts cheap o0 on v0 and expensive o1 on v1 (score ~ 1,000,000).
    plan_s0 = FleetOptimizationResponse(
        job_id="cross-seed-profile",
        status="SUCCESS",
        total_cost_vnd=1_000_000,
        routes=[
            _route_for_orders(vehicle=v0, orders=[orders[0]], cost_vnd=300_000),
            _route_for_orders(vehicle=v1, orders=[orders[1]], cost_vnd=700_000),
        ],
    )
    # Seed 1 puts cheap o1 ALSO on v0, and expensive o0 on v1.
    plan_s1 = FleetOptimizationResponse(
        job_id="cross-seed-profile",
        status="SUCCESS",
        total_cost_vnd=1_020_000,
        routes=[
            _route_for_orders(vehicle=v1, orders=[orders[0]], cost_vnd=720_000),
            _route_for_orders(vehicle=v0, orders=[orders[1]], cost_vnd=300_000),
        ],
    )

    # Without profile equivalence (v6 baseline), both cheap routes collide on v0.
    disabled = solve_cross_seed_set_partitioning(
        req,
        [plan_s0, plan_s1],
        expected,
        compare_horizons=False,
        allow_vehicle_profile_reassignment=False,
    )
    assert disabled is not None
    disabled_plan, _ = disabled

    # With interchangeable vehicle_profile enabled on the exact same pool,
    # Cross-Seed selects both 300k routes and remaps one cleanly onto v1::day:0 / v1.
    enabled = solve_cross_seed_set_partitioning(
        req,
        [plan_s0, plan_s1],
        expected,
        compare_horizons=False,
        allow_vehicle_profile_reassignment=True,
    )
    assert enabled is not None
    combined, _ = enabled

    assert combined.total_cost_vnd < disabled_plan.total_cost_vnd
    assert len(combined.routes) == 2
    assert {r.route_id for r in combined.routes} == {"v0::day:0", "v1::day:0"}
    assert {r.vehicle_id for r in combined.routes} == {"v0", "v1"}
    assert {r.plate_number for r in combined.routes} == {"43C-000", "43C-001"}
    # Driver IDs are normalized to physical source_driver_id values for backend DB apply.
    assert {r.driver_id for r in combined.routes} == {"drv0", "drv1"}


def test_cross_seed_respects_allowed_source_vehicle_ids_and_cost_diffs():
    req, vehicles, orders, expected = _sample_problem()
    # Restrict o1 to v0 only -> cheap v0 route for o1 cannot swap to v1.
    restricted_orders = [
        orders[0],
        orders[1].model_copy(update={"allowed_source_vehicle_ids": ["v0"]}),
    ]
    req = req.model_copy(update={"orders": restricted_orders})
    plan_s0 = FleetOptimizationResponse(
        job_id="cross-seed-restricted",
        status="SUCCESS",
        total_cost_vnd=1_000_000,
        routes=[
            _route_for_orders(vehicle=vehicles[0], orders=[restricted_orders[0]], cost_vnd=300_000),
            _route_for_orders(vehicle=vehicles[1], orders=[restricted_orders[1]], cost_vnd=700_000),
        ],
    )
    plan_s1 = FleetOptimizationResponse(
        job_id="cross-seed-restricted",
        status="SUCCESS",
        total_cost_vnd=900_000,
        routes=[
            _route_for_orders(vehicle=vehicles[1], orders=[restricted_orders[0]], cost_vnd=600_000),
            _route_for_orders(vehicle=vehicles[0], orders=[restricted_orders[1]], cost_vnd=300_000),
        ],
    )
    res = solve_cross_seed_set_partitioning(
        req,
        [plan_s0, plan_s1],
        expected,
        compare_horizons=False,
        allow_vehicle_profile_reassignment=True,
    )
    assert res is not None
    combined, _ = res
    o1_route = next(r for r in combined.routes if any(st.order_id == "o1" for st in r.stops))
    assert o1_route.vehicle_id == "v0"

    # Non-identical operating cost also prevents grouping even without allowed_source_vehicle_ids.
    diff_cost_vehicles = [
        vehicles[0],
        vehicles[1].model_copy(update={"fixed_operating_cost_vnd": 250_000}),
    ]
    req_diff = req.model_copy(update={"vehicles": diff_cost_vehicles, "orders": orders})
    res_diff = solve_cross_seed_set_partitioning(
        req_diff,
        [plan_s0, plan_s1],
        expected,
        compare_horizons=False,
        allow_vehicle_profile_reassignment=True,
    )
    assert res_diff is not None
    combined_diff, _ = res_diff
    o1_diff_route = next(r for r in combined_diff.routes if any(st.order_id == "o1" for st in r.stops))
    assert o1_diff_route.vehicle_id == "v0"


def test_cross_seed_materialization_avoids_cross_day_physical_vehicle_overlap():
    depot = _loc("depot")
    v0_d0 = FleetVehicle(
        id="v0::day:0",
        source_vehicle_id="v0",
        service_day_index=0,
        plate_number="43C-000",
        length_cm=400,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=5000,
        available_start_sec=0,
        available_end_sec=86_400,
        depot=depot,
        fuel_consumption_liters_per_100_km=12.0,
        fixed_operating_cost_vnd=100_000,
    )
    v0_d1 = v0_d0.model_copy(
        update={
            "id": "v0::day:1",
            "service_day_index": 1,
            "available_start_sec": 86_400,
            "available_end_sec": 172_800,
        }
    )
    v1_d1 = v0_d1.model_copy(
        update={
            "id": "v1::day:1",
            "source_vehicle_id": "v1",
            "plate_number": "43C-001",
        }
    )
    vehicles = [v0_d0, v0_d1, v1_d1]
    drivers = [
        DriverOption(
            id="drv0::day:0",
            source_driver_id="drv0",
            service_day_index=0,
            full_name="Driver 0",
            license_class="C",
            fixed_salary_monthly_vnd=15_000_000,
            trip_base_pay_vnd=0,
            per_km_pay_vnd=0,
        ),
        DriverOption(
            id="drv1::day:1",
            source_driver_id="drv1",
            service_day_index=1,
            full_name="Driver 1",
            license_class="C",
            fixed_salary_monthly_vnd=15_000_000,
            trip_base_pay_vnd=0,
            per_km_pay_vnd=0,
        ),
    ]
    orders = [
        OrderPair(
            id=f"o{i}",
            order_number=f"ORD-{i}",
            pickup_location=_loc(f"p{i}"),
            delivery_location=_loc(f"d{i}"),
            items=[CargoItem(id=f"it{i}", order_id=f"o{i}", length_cm=50, width_cm=40, height_cm=40, weight_kg=50)],
        )
        for i in range(2)
    ]
    n = len(vehicles) + 2 * len(orders)
    req = FleetOptimizationRequest(
        job_id="cross-seed-overnight",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        policy=CostPolicy(fuel_price_per_liter_vnd=24_000, monthly_working_minutes=12_480),
        distance_matrix_meters=[[0 if a == b else 1000 for b in range(n)] for a in range(n)],
        duration_matrix_seconds=[[0 if a == b else 60 for b in range(n)] for a in range(n)],
    )
    expected = {o.id: {it.id for it in o.items} for o in orders}

    # Day 0 overnight route on v0::day:0 ends at 95,000s (pinned).
    # Day 1 cheap flexible route for o1 starts on v0::day:1 at 90,000s -> overlaps v0's Day 0 trip,
    # so materialization must move it onto interchangeable v1::day:1!
    overnight_v0 = _route_for_orders(
        vehicle=v0_d0, orders=[orders[0]], cost_vnd=300_000, start_sec=70_000, end_sec=95_000,
    )
    day1_v0_conflict = _route_for_orders(
        vehicle=v0_d1, orders=[orders[1]], cost_vnd=300_000, start_sec=90_000, end_sec=100_000,
    )
    day1_v1_expensive = _route_for_orders(
        vehicle=v1_d1, orders=[orders[1]], cost_vnd=700_000, start_sec=90_000, end_sec=100_000,
    )

    plan_a = FleetOptimizationResponse(job_id="t", status="SUCCESS", routes=[overnight_v0, day1_v1_expensive])
    res = solve_cross_seed_set_partitioning(
        req,
        [plan_a],
        expected,
        compare_horizons=True,
        extra_routes=[day1_v0_conflict],
        allow_vehicle_profile_reassignment=True,
    )
    assert res is not None
    combined, _ = res
    o1_route = next(r for r in combined.routes if any(st.order_id == "o1" for st in r.stops))
    assert o1_route.route_id == "v1::day:1"
    assert o1_route.vehicle_id == "v1"
    assert o1_route.driver_id == "drv1"


def test_solve_cross_seed_with_alns_pool_stubs_triggers_targeted_audit():
    req, vehicles, orders, expected = _sample_problem()
    r0_base = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=600_000)
    r1_base = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=600_000)
    plan_base = FleetOptimizationResponse(job_id="base", status="SUCCESS", routes=[r0_base, r1_base])

    stub_marker = SpatialValidationResult(
        is_valid=False,
        violation_code="UNAUDITED_POOL_STUB",
        step_states=[],
    )
    stub_good = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=250_000).model_copy(
        update={"spatial_validation": stub_marker}
    )
    stub_unselected = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=900_000).model_copy(
        update={"spatial_validation": stub_marker}
    )

    audited_orders = []

    def fake_auditor(cand_route: OptimizedRoute):
        audited_orders.append([s.order_id for s in cand_route.stops if s.stop_type == "PICKUP"])
        return cand_route.model_copy(
            update={
                "spatial_validation": SpatialValidationResult(
                    is_valid=True,
                    max_weight_kg=50.0,
                    max_area_cm2=2000.0,
                    step_states=[],
                )
            }
        )

    res = solve_cross_seed_set_partitioning(
        req,
        [plan_base],
        expected,
        compare_horizons=False,
        alns_pool_stubs=[stub_good, stub_unselected],
        route_auditor=fake_auditor,
    )
    assert res is not None
    combined, _ = res
    assert combined.total_cost_vnd < 1_200_000
    assert all(r.spatial_validation.is_valid for r in combined.routes)
    # Only the chosen stub (o0), NOT already-audited r1_base or stub_unselected, should be audited.
    assert audited_orders == [["o0"]]


def test_solve_cross_seed_nogood_cuts_rejected_pool_stub_and_retries():
    req, vehicles, orders, expected = _sample_problem()
    v2 = vehicles[1].model_copy(update={"id": "v2#d0", "source_vehicle_id": "v2", "plate_number": "43C-002", "length_cm": 500})
    vehicles.append(v2)
    req = req.model_copy(
        update={
            "vehicles": vehicles,
            "drivers": [
                *req.drivers,
                req.drivers[0].model_copy(update={"id": "drv2#d0", "source_driver_id": "drv2"}),
            ],
            "distance_matrix_meters": [[0 if a == b else 1000 for b in range(7)] for a in range(7)],
            "duration_matrix_seconds": [[0 if a == b else 60 for b in range(7)] for a in range(7)],
        }
    )

    r0_base = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=700_000)
    r1_base = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=700_000)
    plan_base = FleetOptimizationResponse(job_id="base", status="SUCCESS", routes=[r0_base, r1_base])

    # Cheapest stub for o0 on v0 fails 3D audit; retry must cut it and pick good stub on v2 (different box).
    stub_marker = SpatialValidationResult(
        is_valid=False,
        violation_code="UNAUDITED_POOL_STUB",
        step_states=[],
    )
    stub_bad = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=150_000).model_copy(
        update={"spatial_validation": stub_marker}
    )
    stub_good = _route_for_orders(vehicle=v2, orders=[orders[0]], cost_vnd=300_000).model_copy(
        update={"spatial_validation": stub_marker}
    )

    seen_calls = []

    def selective_auditor(cand_route: OptimizedRoute):
        seen_calls.append(cand_route.route_id)
        if cand_route.route_id == "v0#d0":
            return None
        return cand_route.model_copy(
            update={
                "spatial_validation": SpatialValidationResult(
                    is_valid=True,
                    max_weight_kg=50.0,
                    max_area_cm2=2000.0,
                    step_states=[],
                )
            }
        )

    res = solve_cross_seed_set_partitioning(
        req,
        [plan_base],
        expected,
        compare_horizons=False,
        alns_pool_stubs=[stub_bad, stub_good],
        route_auditor=selective_auditor,
        max_audit_retries=3,
    )
    assert res is not None
    combined, _ = res
    assert seen_calls == ["v0#d0", "v2#d0"]
    assert combined.total_cost_vnd < 1_400_000
    assert any(r.route_id == "v2#d0" and r.spatial_validation.is_valid for r in combined.routes)


def test_solve_cross_seed_ignores_stubs_without_route_auditor():
    req, vehicles, orders, expected = _sample_problem()
    r0 = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=600_000)
    r1 = _route_for_orders(vehicle=vehicles[1], orders=[orders[1]], cost_vnd=600_000)
    plan_base = FleetOptimizationResponse(job_id="base", status="SUCCESS", routes=[r0, r1])
    stub = _route_for_orders(vehicle=vehicles[0], orders=[orders[0]], cost_vnd=100_000).model_copy(
        update={
            "spatial_validation": SpatialValidationResult(
                is_valid=False,
                violation_code="UNAUDITED_POOL_STUB",
                step_states=[],
            )
        }
    )
    assert (
        solve_cross_seed_set_partitioning(
            req,
            [plan_base],
            expected,
            compare_horizons=False,
            alns_pool_stubs=[stub],
            route_auditor=None,
        )
        is None
    )
