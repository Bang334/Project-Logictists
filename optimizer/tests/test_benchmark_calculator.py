from app.baseline_calculator import BaselineCostCalculator
from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
)
from app.routing_solver import FleetRoutingSolver
from typing import List


def _request(
    *,
    vehicles: List[FleetVehicle],
    orders: List[OrderPair],
    distances: List[List[float]],
    durations: List[List[float]],
    holding_rate: int = 0,
) -> FleetOptimizationRequest:
    return FleetOptimizationRequest(
        job_id="benchmark-regression",
        vehicles=vehicles,
        drivers=[
            DriverOption(
                id=f"driver-{index}",
                full_name=f"Driver {index}",
                license_class="C",
                fixed_salary_monthly_vnd=0,
                trip_base_pay_vnd=0,
                per_km_pay_vnd=0,
            )
            for index in range(1, len(vehicles) + 1)
        ],
        orders=orders,
        policy=CostPolicy(
            fuel_price_per_liter_vnd=20_000,
            monthly_working_minutes=10_560,
            cargo_holding_cost_vnd_per_ton_hour=holding_rate,
        ),
        max_time_seconds=2,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )


def _vehicle(index: int, *, length_cm: float = 100, width_cm: float = 100):
    depot = LocationPoint(
        id=f"depot-{index}", name=f"Depot {index}", latitude=21, longitude=105
    )
    return FleetVehicle(
        id=f"vehicle-{index}",
        plate_number=f"TEST-{index}",
        length_cm=length_cm,
        width_cm=width_cm,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=depot,
        fuel_consumption_liters_per_100_km=10,
        fixed_operating_cost_vnd=100_000,
    )


def _order(index: int, *, length_cm: float = 10, width_cm: float = 10, weight=10):
    return OrderPair(
        id=f"order-{index}",
        order_number=f"ORDER-{index}",
        pickup_location=LocationPoint(
            id=f"p{index}", name=f"P{index}", latitude=21, longitude=105
        ),
        delivery_location=LocationPoint(
            id=f"d{index}", name=f"D{index}", latitude=21, longitude=105
        ),
        items=[
            CargoItem(
                id=f"item-{index}",
                order_id=f"order-{index}",
                length_cm=length_cm,
                width_cm=width_cm,
                height_cm=50,
                weight_kg=weight,
                can_rotate=False,
            )
        ],
        service_time_sec=0,
    )


def test_baseline_preserves_distinct_service_durations_and_timing_breakdown():
    vehicle = _vehicle(1)
    order = _order(1).model_copy(update={
        "pickup_service_time_sec": 60,
        "delivery_service_time_sec": 120,
    })
    matrix = [[0 if i == j else 30 for j in range(3)] for i in range(3)]
    request = _request(vehicles=[vehicle], orders=[order], distances=matrix, durations=matrix)
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    route = calculator._evaluate_actions(vehicle, 0, calculator._actions_for_order(order))

    assert not route.violations
    pickup, delivery = route.stops
    assert (pickup.arrival_time_sec, pickup.departure_time_sec, pickup.service_time_sec) == (30, 90, 60)
    assert (delivery.arrival_time_sec, delivery.departure_time_sec, delivery.service_time_sec) == (120, 240, 120)
    assert all(stop.travel_time_sec == 30 and stop.waiting_time_sec == 0 for stop in route.stops)
    assert route.duration_seconds == 270


def test_direct_dedicated_benchmark_uses_the_same_cargo_holding_cost_component():
    vehicle = _vehicle(1)
    order = _order(1, weight=1_000)
    distances = [
        [0, 1_000, 1_000],
        [1_000, 0, 1_000],
        [1_000, 1_000, 0],
    ]
    durations = [
        [0, 60, 60],
        [60, 0, 3_600],
        [60, 3_600, 0],
    ]
    request = _request(
        vehicles=[vehicle],
        orders=[order],
        distances=distances,
        durations=durations,
        holding_rate=1_000,
    )
    calculator = BaselineCostCalculator(
        request, FleetRoutingSolver(request).nodes
    )

    metric = calculator.compute_direct_dedicated()

    assert metric.is_feasible is True
    assert metric.cargo_holding_cost_vnd == 1_000
    assert metric.total_cost_vnd == (
        metric.fuel_cost_vnd
        + metric.vehicle_fixed_cost_vnd
        + metric.driver_cost_vnd
        + metric.cargo_holding_cost_vnd
    )


def test_direct_dedicated_runs_two_trips_in_one_shift_and_drives_directly_to_next_pickup():
    vehicle = _vehicle(1).model_copy(update={"available_end_sec": 600})
    orders = [_order(1), _order(2)]
    # Matrix order is depot, pickup 1, delivery 1, pickup 2, delivery 2.
    matrix = [[0 if i == j else 60 for j in range(5)] for i in range(5)]
    matrix[2][3] = 10
    matrix[4][1] = 300
    request = _request(vehicles=[vehicle], orders=orders, distances=matrix, durations=matrix)
    metric = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).compute_direct_dedicated()

    assert metric.is_feasible
    assert metric.vehicles_used == 2 and metric.physical_vehicle_count == 1
    assert metric.planning_span_days == 1
    first, second = metric.routes
    assert first.route_id != second.route_id
    assert first.driver_id == second.driver_id
    assert [stop.allocation_id for stop in first.stops] == ['order-1', 'order-1']
    assert [stop.allocation_id for stop in second.stops] == ['order-2', 'order-2']
    assert first.end_time_sec == second.start_time_sec
    assert first.return_travel_time_sec == 0
    assert second.stops[0].travel_time_sec == 10
    assert second.return_travel_time_sec == 60
    assert metric.total_distance_km == 0.25
    assert first.end_location == second.depot == orders[0].delivery_location
    assert second.end_location == vehicle.depot
    assert metric.fuel_cost_vnd == 500


def test_direct_dedicated_uses_next_shift_when_two_trips_do_not_fit_in_one():
    vehicle = _vehicle(1).model_copy(update={"source_vehicle_id": "truck-1", "available_end_sec": 180})
    next_day = vehicle.model_copy(update={
        "id": "vehicle-1-next-day", "service_day_index": 1,
        "available_start_sec": 86_400, "available_end_sec": 86_580,
    })
    matrix = [[0 if i == j else 60 for j in range(6)] for i in range(6)]
    request = _request(vehicles=[vehicle, next_day], orders=[_order(1), _order(2)],
                       distances=matrix, durations=matrix)
    request.drivers[0] = request.drivers[0].model_copy(update={"source_driver_id": "drv-1", "service_day_index": 0})
    request.drivers[1] = request.drivers[1].model_copy(update={"source_driver_id": "drv-1", "service_day_index": 1})
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    comparison = calculator.build_comparison([], 100_000, 0, 0)

    assert comparison.direct_dedicated.is_feasible is True
    assert comparison.direct_dedicated.vehicles_used == 2
    assert comparison.direct_dedicated.physical_vehicle_count == 1
    assert comparison.direct_dedicated.planning_span_days == 2
    assert comparison.savings_vs_direct_vnd is not None


def test_direct_dedicated_reports_no_full_plan_when_available_shift_is_too_short():
    vehicle = _vehicle(1).model_copy(update={"available_end_sec": 180})
    orders = [_order(1), _order(2)]
    matrix = [[0 if i == j else 60 for j in range(5)] for i in range(5)]
    request = _request(vehicles=[vehicle], orders=orders, distances=matrix, durations=matrix)
    comparison = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).build_comparison([], 100_000, 0, 0)

    assert not comparison.direct_dedicated.is_feasible
    assert not comparison.direct_dedicated.routes
    assert comparison.savings_vs_direct_vnd is None


def test_direct_dedicated_assigns_the_large_truck_to_the_order_that_needs_it():
    vehicles = [
        _vehicle(1, length_cm=200),
        _vehicle(2).model_copy(update={"fixed_operating_cost_vnd": 150_000}),
    ]
    vehicles = [vehicle.model_copy(update={"available_end_sec": 180}) for vehicle in vehicles]
    orders = [_order(1), _order(2, length_cm=150)]
    matrix = [[0 if i == j else 60 for j in range(6)] for i in range(6)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    metric = calculator.compute_direct_dedicated()

    assert metric.is_feasible
    assert metric.vehicles_used == 2
    assert metric.vehicle_fixed_cost_vnd == sum(vehicle.fixed_operating_cost_vnd for vehicle in vehicles)


def test_build_comparison_includes_direct_dedicated_without_greedy():
    vehicle = _vehicle(1)
    order = _order(1, weight=500)
    distances = [
        [0, 100, 100],
        [100, 0, 100],
        [100, 100, 0],
    ]
    durations = [
        [0, 60, 60],
        [60, 0, 60],
        [60, 60, 0],
    ]
    request = _request(
        vehicles=[vehicle],
        orders=[order],
        distances=distances,
        durations=durations,
    )
    solver = FleetRoutingSolver(request)
    result = solver.solve()
    calculator = BaselineCostCalculator(request, solver.nodes)

    comparison = calculator.build_comparison(
        result.routes,
        result.total_cost_vnd,
        result.total_distance_km,
        result.total_duration_minutes,
    )

    assert comparison.direct_dedicated is not None
    assert comparison.or_tools is not None
    assert not hasattr(comparison, "greedy_heuristic")
    assert not hasattr(comparison, "savings_vs_greedy_vnd")


def test_cost_optimizer_may_use_one_vehicle_for_eleven_small_orders():
    vehicles = [_vehicle(index, length_cm=1_000, width_cm=200) for index in range(3)]
    orders = [_order(index) for index in range(1, 12)]
    size = len(vehicles) + 2 * len(orders)
    distances = [
        [0 if origin == destination else 100 for destination in range(size)]
        for origin in range(size)
    ]
    durations = [
        [0 if origin == destination else 1 for destination in range(size)]
        for origin in range(size)
    ]
    request = _request(
        vehicles=vehicles,
        orders=orders,
        distances=distances,
        durations=durations,
    )

    result = FleetRoutingSolver(request).solve()

    assert result.status == "SUCCESS"
    assert len(result.routes) == 1
    assert len(result.routes[0].stops) == 22


def test_solver_allows_full_floor_when_spatial_validator_confirms_access():
    vehicle = _vehicle(1)
    order = _order(1, length_cm=100, width_cm=100)
    size = 3
    distances = [
        [0 if origin == destination else 100 for destination in range(size)]
        for origin in range(size)
    ]
    durations = [
        [0 if origin == destination else 1 for destination in range(size)]
        for origin in range(size)
    ]
    request = _request(
        vehicles=[vehicle],
        orders=[order],
        distances=distances,
        durations=durations,
    )

    result = FleetRoutingSolver(request).solve()

    assert result.status == "SUCCESS"
    assert len(result.routes) == 1
    assert result.routes[0].spatial_validation.is_valid is True
