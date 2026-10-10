"""Standardized Cost Evaluator for Hybrid ALNS ported from algo_lab."""

from typing import Dict, List, Tuple
from .models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
)

SECONDS_PER_DAY = 86400


def calculate_route_cost(
    vehicle: FleetVehicle,
    driver: DriverOption,
    stops: List[ScheduledStop],
    order_by_id: Dict[str, OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
) -> Tuple[RouteCostBreakdown, float, float]:
    """Evaluates the full cost breakdown, total distance (km), and duration (minutes)."""
    if not stops:
        return RouteCostBreakdown(), 0.0, 0.0

    total_distance_meters = 0.0
    total_travel_seconds = 0.0
    base_fuel_liters = 0.0
    load_fuel_surcharge_liters = 0.0
    cargo_distance_kg_m = 0.0

    depot_node_idx = node_id_to_index.get(vehicle.depot.id, 0)
    prev_node_idx = depot_node_idx
    onboard_weight_kg = 0.0

    for stop in stops:
        curr_node_idx = node_id_to_index.get(stop.location_id, 0)
        leg_dist = distance_matrix[prev_node_idx][curr_node_idx]
        leg_dur = duration_matrix[prev_node_idx][curr_node_idx]

        total_distance_meters += leg_dist
        total_travel_seconds += leg_dur

        base_leg_liters = (
            (leg_dist / 100_000.0) * vehicle.fuel_consumption_liters_per_100_km
        )
        load_ratio = min(
            1.0, max(0.0, onboard_weight_kg / max(1.0, vehicle.payload_limit_kg))
        )
        base_fuel_liters += base_leg_liters
        load_fuel_surcharge_liters += (
            base_leg_liters
            * (vehicle.load_fuel_surcharge_percent_at_full_payload / 100.0)
            * load_ratio
        )
        cargo_distance_kg_m += onboard_weight_kg * leg_dist

        onboard_weight_kg = stop.current_weight_kg
        prev_node_idx = curr_node_idx

    end_depot = vehicle.end_depot or vehicle.depot
    end_depot_node_idx = node_id_to_index.get(end_depot.id, depot_node_idx)
    return_dist = distance_matrix[prev_node_idx][end_depot_node_idx]
    return_dur = duration_matrix[prev_node_idx][end_depot_node_idx]
    total_distance_meters += return_dist
    total_travel_seconds += return_dur

    return_base_liters = (
        (return_dist / 100_000.0) * vehicle.fuel_consumption_liters_per_100_km
    )
    return_load_ratio = min(
        1.0, max(0.0, onboard_weight_kg / max(1.0, vehicle.payload_limit_kg))
    )
    base_fuel_liters += return_base_liters
    load_fuel_surcharge_liters += (
        return_base_liters
        * (vehicle.load_fuel_surcharge_percent_at_full_payload / 100.0)
        * return_load_ratio
    )
    cargo_distance_kg_m += onboard_weight_kg * return_dist

    fuel_price = policy.fuel_price_per_liter_vnd
    base_fuel_cost = round(base_fuel_liters * fuel_price)
    load_fuel_surcharge = round(load_fuel_surcharge_liters * fuel_price)
    fuel_cost = base_fuel_cost + load_fuel_surcharge

    total_distance_km = round(total_distance_meters / 1000.0, 2)
    first_idx = node_id_to_index.get(stops[0].location_id, depot_node_idx)
    first_leg_dur = duration_matrix[depot_node_idx][first_idx]
    route_start_sec = max(
        float(vehicle.available_start_sec),
        stops[0].arrival_time_sec - first_leg_dur,
    )
    route_end_sec = max(route_start_sec, stops[-1].departure_time_sec + return_dur)
    scheduled_duration_seconds = route_end_sec - route_start_sec
    total_duration_seconds = max(total_travel_seconds, scheduled_duration_seconds)
    total_duration_minutes = round(total_duration_seconds / 60.0, 1)

    salary_allocation = round(
        driver.fixed_salary_monthly_vnd
        * total_duration_minutes
        / max(1, policy.monthly_working_minutes)
    )
    trip_pay = driver.trip_base_pay_vnd + round(driver.per_km_pay_vnd * total_distance_km)
    driver_total_pay = salary_allocation + trip_pay

    pickup_stops = {s.order_id: s for s in stops if s.stop_type == "PICKUP" and s.order_id}
    delivery_stops = {s.order_id: s for s in stops if s.stop_type == "DELIVERY" and s.order_id}
    cargo_time_kg_sec = 0.0

    for order_id, pickup_s in pickup_stops.items():
        delivery_s = delivery_stops.get(order_id)
        order = order_by_id.get(order_id)
        if delivery_s and order:
            order_weight = order.total_weight_kg
            onboard_sec = max(0, delivery_s.arrival_time_sec - pickup_s.departure_time_sec)
            cargo_time_kg_sec += order_weight * onboard_sec

    cargo_ton_hours = cargo_time_kg_sec / (1000.0 * 3600.0)
    cargo_holding_cost = round(
        cargo_ton_hours * policy.cargo_holding_cost_vnd_per_ton_hour
    )

    late_penalty = 0
    for stop in stops:
        if stop.stop_type == "DELIVERY" and stop.order_id in order_by_id:
            order = order_by_id[stop.order_id]
            if stop.arrival_time_sec > order.delivery_window_end_sec:
                late_sec = stop.arrival_time_sec - order.delivery_window_end_sec
                if policy.late_delivery_penalty_mode == "PERCENT_ORDER_VALUE_PER_DAY":
                    daily = order.order_value_vnd * (policy.late_delivery_penalty_value / 100.0)
                else:
                    daily = policy.late_delivery_penalty_value
                late_penalty += round(daily * late_sec / SECONDS_PER_DAY)

    total_cost = (
        fuel_cost
        + vehicle.fixed_operating_cost_vnd
        + driver_total_pay
        + cargo_holding_cost
        + late_penalty
    )

    breakdown = RouteCostBreakdown(
        base_fuel_cost_vnd=base_fuel_cost,
        load_fuel_surcharge_vnd=load_fuel_surcharge,
        fuel_cost_vnd=fuel_cost,
        fixed_vehicle_cost_vnd=vehicle.fixed_operating_cost_vnd,
        driver_salary_allocation_vnd=salary_allocation,
        driver_trip_pay_vnd=trip_pay,
        driver_total_pay_vnd=driver_total_pay,
        cargo_holding_cost_vnd=cargo_holding_cost,
        late_delivery_penalty_vnd=late_penalty,
        total_cost_vnd=total_cost,
    )

    return breakdown, total_distance_km, total_duration_minutes
