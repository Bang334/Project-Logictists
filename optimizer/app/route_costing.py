from typing import Dict, List, Optional, Protocol, Tuple

from .models import (
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
)


SECONDS_PER_DAY = 86_400


class DeliveryPenaltyOrder(Protocol):
    ordered_at_sec: int
    order_value_vnd: int


class DeliveryPenaltyPolicy(Protocol):
    delivery_grace_days: int
    late_delivery_penalty_mode: str
    late_delivery_penalty_value: float


def late_delivery_daily_penalty(order: DeliveryPenaltyOrder, policy: DeliveryPenaltyPolicy) -> float:
    if policy.late_delivery_penalty_mode == "FIXED_PER_DAY":
        return policy.late_delivery_penalty_value
    if policy.late_delivery_penalty_mode == "PERCENT_ORDER_VALUE_PER_DAY":
        return order.order_value_vnd * policy.late_delivery_penalty_value / 100
    return 0


def calculate_late_delivery_penalty(
    order: DeliveryPenaltyOrder,
    delivery_time_sec: int,
    policy: DeliveryPenaltyPolicy,
) -> int:
    grace_end_sec = order.ordered_at_sec + policy.delivery_grace_days * SECONDS_PER_DAY
    late_seconds = max(0, delivery_time_sec - grace_end_sec)
    return round(
        late_delivery_daily_penalty(order, policy)
        * late_seconds
        / SECONDS_PER_DAY
    )


def allocate_order_late_penalties(
    request: FleetOptimizationRequest, plan: FleetOptimizationResponse,
) -> None:
    """Charge each customer order once, on its final delivery, even across trips."""
    orders = {order.id: order for order in request.orders}
    final_deliveries: Dict[str, Tuple[int, int, OrderPair]] = {}
    for route_index, route in enumerate(plan.routes):
        for stop in route.stops:
            order = orders.get(stop.allocation_id or stop.order_id or '')
            if stop.stop_type != 'DELIVERY' or order is None:
                continue
            source_id = order.source_order_id or order.id
            previous = final_deliveries.get(source_id)
            if previous is None or stop.arrival_time_sec > previous[0]:
                final_deliveries[source_id] = (stop.arrival_time_sec, route_index, order)
    fees_by_route = [0] * len(plan.routes)
    for delivered_at, route_index, order in final_deliveries.values():
        fees_by_route[route_index] += calculate_late_delivery_penalty(order, delivered_at, request.policy)
    for route, fee in zip(plan.routes, fees_by_route):
        if route.cost is None:
            continue
        delta = fee - route.cost.late_delivery_penalty_vnd
        route.cost.late_delivery_penalty_vnd = fee
        route.cost.total_cost_vnd += delta
        plan.total_cost_vnd += delta


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
    *,
    start_node_index: Optional[int] = None,
    return_to_depot: bool = True,
) -> Tuple[int, int, int, float, float]:
    """Calculate the same traceable leg costs for every candidate method."""
    node_index_by_id = {node["id"]: index for index, node in enumerate(nodes)}
    vehicle_index = next(
        (
            index
            for index, candidate in enumerate(request.vehicles)
            if candidate.id == vehicle.id
        ),
        next(
            index
            for index, candidate in enumerate(request.vehicles)
            if (candidate.source_vehicle_id or candidate.id)
            == (vehicle.source_vehicle_id or vehicle.id)
        ),
    )
    previous_node = vehicle_index if start_node_index is None else start_node_index
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

    return_distance_meters = request.distance_matrix_meters[previous_node][vehicle_index] if return_to_depot else 0
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
        (stop.allocation_id or stop.order_id): stop
        for stop in stops
        if (stop.allocation_id or stop.order_id) and stop.stop_type == "PICKUP"
    }
    delivery_by_order = {
        (stop.allocation_id or stop.order_id): stop
        for stop in stops
        if (stop.allocation_id or stop.order_id) and stop.stop_type == "DELIVERY"
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
    *,
    start_node_index: Optional[int] = None,
    return_to_depot: bool = True,
) -> RouteCostBreakdown:
    (
        base_fuel_cost,
        load_fuel_surcharge,
        cargo_holding_cost,
        cargo_distance_ton_km,
        cargo_time_ton_hours,
    ) = calculate_route_economic_metrics(
        request, nodes, order_by_id, vehicle, stops,
        start_node_index=start_node_index, return_to_depot=return_to_depot,
    )
    _, fixed_salary_allocation, trip_pay = calculate_driver_cost(
        request, driver, duration_minutes, distance_km
    )
    late_delivery_penalty = sum(
        calculate_late_delivery_penalty(
            order_by_id[stop.allocation_id or stop.order_id],
            stop.arrival_time_sec,
            request.policy,
        )
        for stop in stops
        if stop.stop_type == "DELIVERY"
        and (stop.allocation_id or stop.order_id) in order_by_id
    )
    fuel_cost = base_fuel_cost + load_fuel_surcharge
    total_cost = (
        fuel_cost
        + vehicle.fixed_operating_cost_vnd
        + fixed_salary_allocation
        + trip_pay
        + cargo_holding_cost
        + late_delivery_penalty
    )
    return RouteCostBreakdown(
        base_fuel_cost_vnd=base_fuel_cost,
        load_fuel_surcharge_vnd=load_fuel_surcharge,
        fuel_cost_vnd=fuel_cost,
        cargo_holding_cost_vnd=cargo_holding_cost,
        late_delivery_penalty_vnd=late_delivery_penalty,
        cargo_distance_ton_km=cargo_distance_ton_km,
        cargo_time_ton_hours=cargo_time_ton_hours,
        vehicle_fixed_cost_vnd=vehicle.fixed_operating_cost_vnd,
        driver_fixed_salary_allocation_vnd=fixed_salary_allocation,
        driver_trip_pay_vnd=trip_pay,
        total_cost_vnd=total_cost,
    )
