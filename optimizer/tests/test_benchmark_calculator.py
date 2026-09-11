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
