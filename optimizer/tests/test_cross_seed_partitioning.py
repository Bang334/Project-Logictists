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
    for order in orders:
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
                arrival_time_sec=start_sec + seq * 300,
                departure_time_sec=start_sec + seq * 300 + 60,
                items_loaded=[it.id for it in order.items],
                items_unloaded=[],
            )
        )
        seq += 1
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
                arrival_time_sec=start_sec + seq * 300,
                departure_time_sec=start_sec + seq * 300 + 60,
                items_loaded=[],
                items_unloaded=[it.id for it in order.items],
            )
        )
        seq += 1
    return OptimizedRoute(
        route_id=vehicle.id,
        vehicle_id=vehicle.source_vehicle_id or vehicle.id,
        service_day_index=vehicle.service_day_index,
        plate_number=vehicle.plate_number,
        vehicle_length_cm=vehicle.length_cm,
        vehicle_width_cm=vehicle.width_cm,
        vehicle_height_cm=vehicle.height_cm,
        start_time_sec=start_sec,
        end_time_sec=end_sec,
        total_distance_km=20.0,
        total_duration_minutes=60.0,
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
