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
from app.planning_objective import apply_planning_objective


def _route_cost(active_salary_vnd: int, total_cost_vnd: int) -> RouteCostBreakdown:
    return RouteCostBreakdown(
        base_fuel_cost_vnd=100_000,
        load_fuel_surcharge_vnd=0,
        fuel_cost_vnd=100_000,
        cargo_holding_cost_vnd=0,
        late_delivery_penalty_vnd=0,
        cargo_distance_ton_km=0,
        cargo_time_ton_hours=0,
        vehicle_fixed_cost_vnd=50_000,
        driver_fixed_salary_allocation_vnd=active_salary_vnd,
        driver_trip_pay_vnd=100_000,
        total_cost_vnd=total_cost_vnd,
    )


def test_planning_objective_counts_idle_salary_and_operational_lateness():
    depot = LocationPoint(id="depot", name="Kho", latitude=16.0, longitude=108.0)
    vehicles = []
    drivers = []
    for day in range(3):
        vehicles.append(
            FleetVehicle(
                id=f"vehicle::day:{day}",
                source_vehicle_id="vehicle",
                service_day_index=day,
                plate_number="43C-001",
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
        )
        for driver_id, salary in (("driver-a", 10_000_000), ("driver-b", 12_000_000)):
            drivers.append(
                DriverOption(
                    id=f"{driver_id}::day:{day}",
                    source_driver_id=driver_id,
                    service_day_index=day,
                    full_name=driver_id,
                    fixed_salary_monthly_vnd=salary,
                    trip_base_pay_vnd=100_000,
                    per_km_pay_vnd=1000,
                )
            )

    order = OrderPair(
        id="order",
        source_order_id="source-order",
        order_number="ORD-1",
        pickup_location=LocationPoint(id="pickup", name="P", latitude=16.1, longitude=108.1),
        delivery_location=LocationPoint(id="delivery", name="D", latitude=16.2, longitude=108.2),
        items=[
            CargoItem(
                id="item",
                order_id="order",
                length_cm=50,
                width_cm=50,
                height_cm=50,
                weight_kg=100,
            )
        ],
        ordered_at_sec=0,
    )
    delivery_time = 2 * 86_400 + 12 * 3600
    stops = [
        ScheduledStop(
            sequence=1,
            location_id="pickup",
            location_name="P",
            stop_type="PICKUP",
            order_id="source-order",
            allocation_id="order",
            latitude=16.1,
            longitude=108.1,
            arrival_time_sec=2 * 86_400 + 9 * 3600,
            departure_time_sec=2 * 86_400 + 9 * 3600 + 60,
        ),
        ScheduledStop(
            sequence=2,
            location_id="delivery",
            location_name="D",
            stop_type="DELIVERY",
            order_id="source-order",
            allocation_id="order",
            latitude=16.2,
            longitude=108.2,
            arrival_time_sec=delivery_time,
            departure_time_sec=delivery_time + 60,
        ),
    ]
    route = OptimizedRoute(
        route_id=vehicles[-1].id,
        vehicle_id="vehicle",
        service_day_index=2,
        start_time_sec=stops[0].arrival_time_sec,
        end_time_sec=stops[-1].departure_time_sec,
        plate_number="43C-001",
        vehicle_length_cm=500,
        vehicle_width_cm=200,
        driver_id="driver-a",
        total_distance_km=10,
        total_duration_minutes=181,
        stops=stops,
        spatial_validation=SpatialValidationResult(
            is_valid=True,
            max_weight_kg=100,
            max_area_cm2=2500,
        ),
        cost=_route_cost(active_salary_vnd=200_000, total_cost_vnd=450_000),
    )
    request = FleetOptimizationRequest(
        job_id="objective-test",
        vehicles=vehicles,
        drivers=drivers,
        orders=[order],
        policy=CostPolicy(
            fuel_price_per_liter_vnd=23_000,
            monthly_working_minutes=10_560,
            delivery_grace_days=1,
            late_delivery_penalty_mode="NONE",
            unassigned_order_penalty_vnd=1_000_000_000,
        ),
        max_time_seconds=10,
        distance_matrix_meters=[[0] * 5 for _ in range(5)],
        duration_matrix_seconds=[[0] * 5 for _ in range(5)],
    )
    plan = FleetOptimizationResponse(
        job_id=request.job_id,
        status="SUCCESS",
        routes=[route],
        total_cost_vnd=450_000,
    )

    objective = apply_planning_objective(request, plan)

    expected_daily_salary = round((10_000_000 + 12_000_000) * 540 / 10_560)
    expected_late_penalty = round(
        1_000_000 * (delivery_time - 86_400) / 86_400
    )
    assert objective.planning_span_days == 3
    assert objective.driver_active_salary_allocation_vnd == 200_000
    assert objective.driver_calendar_salary_vnd == expected_daily_salary * 3
    assert objective.driver_idle_salary_allocation_vnd == expected_daily_salary * 3 - 200_000
    assert objective.operational_late_penalty_vnd == expected_late_penalty
    assert objective.selection_score_vnd == (
        450_000
        - 200_000
        + expected_daily_salary * 3
        + expected_late_penalty
    )
    assert plan.planning_objective == objective
