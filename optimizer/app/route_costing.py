from typing import Dict, List, Tuple

from .models import (
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
)


def calculate_driver_cost(
    request: FleetOptimizationRequest,
    driver: DriverOption,
    duration_minutes: float,
    distance_km: float,
) -> Tuple[int, int, int]:
    fixed_salary_allocation = round(
        driver.fixed_salary_monthly_vnd
        * duration_minutes
        / request.policy.monthly_working_minutes
    )
    trip_pay = driver.trip_base_pay_vnd + round(driver.per_km_pay_vnd * distance_km)
    return (
        fixed_salary_allocation + trip_pay,
        fixed_salary_allocation,
        trip_pay,
    )


def calculate_route_economic_metrics(
    request: FleetOptimizationRequest,
    nodes: List[dict],
    order_by_id: Dict[str, OrderPair],
    vehicle: FleetVehicle,
    stops: List[ScheduledStop],
) -> Tuple[int, int, int, float, float]:
    """Calculate the same traceable leg costs for every candidate method."""
    node_index_by_id = {node["id"]: index for index, node in enumerate(nodes)}
    vehicle_index = next(
        index
        for index, candidate in enumerate(request.vehicles)
        if candidate.id == vehicle.id
    )
    previous_node = vehicle_index
    onboard_weight_kg = 0.0
    base_fuel_liters = 0.0
    load_fuel_surcharge_liters = 0.0
    cargo_distance_kg_m = 0.0

    for stop in stops:
        node_index = node_index_by_id[stop.location_id]
        distance_meters = request.distance_matrix_meters[previous_node][node_index]
        base_leg_liters = (
            distance_meters
            / 100_000
            * vehicle.fuel_consumption_liters_per_100_km
        )
        load_ratio = min(
            1.0, max(0.0, onboard_weight_kg / vehicle.payload_limit_kg)
        )
        base_fuel_liters += base_leg_liters
        load_fuel_surcharge_liters += (
            base_leg_liters
            * vehicle.load_fuel_surcharge_percent_at_full_payload
            / 100
            * load_ratio
        )
        cargo_distance_kg_m += onboard_weight_kg * distance_meters
        onboard_weight_kg = stop.current_weight_kg
        previous_node = node_index

    return_distance_meters = request.distance_matrix_meters[previous_node][vehicle_index]
    return_base_liters = (
        return_distance_meters
        / 100_000
        * vehicle.fuel_consumption_liters_per_100_km
    )
    return_load_ratio = min(
        1.0, max(0.0, onboard_weight_kg / vehicle.payload_limit_kg)
    )
    base_fuel_liters += return_base_liters
    load_fuel_surcharge_liters += (
        return_base_liters
        * vehicle.load_fuel_surcharge_percent_at_full_payload
        / 100
        * return_load_ratio
    )
    cargo_distance_kg_m += onboard_weight_kg * return_distance_meters

    pickup_by_order = {
        stop.order_id: stop
        for stop in stops
        if stop.order_id and stop.stop_type == "PICKUP"
    }
    delivery_by_order = {
        stop.order_id: stop
        for stop in stops
        if stop.order_id and stop.stop_type == "DELIVERY"
    }
    cargo_time_kg_seconds = 0.0
    for order_id, pickup in pickup_by_order.items():
        delivery = delivery_by_order.get(order_id)
        order = order_by_id.get(order_id)
        if delivery is None or order is None:
            continue
        order_weight_kg = sum(item.weight_kg for item in order.items)
        onboard_seconds = max(
            0, delivery.arrival_time_sec - pickup.departure_time_sec
        )
        cargo_time_kg_seconds += order_weight_kg * onboard_seconds

    fuel_price = request.policy.fuel_price_per_liter_vnd
    base_fuel_cost = round(base_fuel_liters * fuel_price)
    load_fuel_surcharge = round(load_fuel_surcharge_liters * fuel_price)
    cargo_time_ton_hours = cargo_time_kg_seconds / (1000 * 3600)
    cargo_holding_cost = round(
        cargo_time_ton_hours
        * request.policy.cargo_holding_cost_vnd_per_ton_hour
    )
    return (
        base_fuel_cost,
        load_fuel_surcharge,
        cargo_holding_cost,
        round(cargo_distance_kg_m / 1_000_000, 3),
        round(cargo_time_ton_hours, 3),
    )


def build_route_cost_breakdown(
    request: FleetOptimizationRequest,
    nodes: List[dict],
    order_by_id: Dict[str, OrderPair],
    vehicle: FleetVehicle,
    driver: DriverOption,
    stops: List[ScheduledStop],
    distance_km: float,
    duration_minutes: float,
) -> RouteCostBreakdown:
    (
        base_fuel_cost,
        load_fuel_surcharge,
        cargo_holding_cost,
        cargo_distance_ton_km,
        cargo_time_ton_hours,
    ) = calculate_route_economic_metrics(
        request, nodes, order_by_id, vehicle, stops
    )
    _, fixed_salary_allocation, trip_pay = calculate_driver_cost(
        request, driver, duration_minutes, distance_km
    )
    fuel_cost = base_fuel_cost + load_fuel_surcharge
    total_cost = (
        fuel_cost
        + vehicle.fixed_operating_cost_vnd
        + fixed_salary_allocation
        + trip_pay
        + cargo_holding_cost
    )
    return RouteCostBreakdown(
        base_fuel_cost_vnd=base_fuel_cost,
        load_fuel_surcharge_vnd=load_fuel_surcharge,
        fuel_cost_vnd=fuel_cost,
        cargo_holding_cost_vnd=cargo_holding_cost,
        cargo_distance_ton_km=cargo_distance_ton_km,
        cargo_time_ton_hours=cargo_time_ton_hours,
        vehicle_fixed_cost_vnd=vehicle.fixed_operating_cost_vnd,
        driver_fixed_salary_allocation_vnd=fixed_salary_allocation,
        driver_trip_pay_vnd=trip_pay,
        total_cost_vnd=total_cost,
    )
