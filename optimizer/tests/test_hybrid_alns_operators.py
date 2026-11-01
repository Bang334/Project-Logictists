import pytest
from app.hybrid_alns.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    ScheduledStop,
)
from app.hybrid_alns.solver import HybridALNSSolver


def test_vehicle_reassignment_swaps_to_cheaper_idle_vehicle():
    """Verify _best_vehicle_reassignment moves a route to a cheaper vehicle when idle."""
    v_expensive = FleetVehicle(
        id="v-expensive",
        plate_number="EXP-01",
        length_cm=400.0,
        width_cm=200.0,
        height_cm=200.0,
        payload_limit_kg=2000.0,
        depot=LocationPoint(id="depot", name="Depot", latitude=10.0, longitude=106.0),
        door_position="BACK",
        fuel_consumption_liters_per_100_km=25.0,
        load_fuel_surcharge_percent_at_full_payload=0.0,
        fixed_operating_cost_vnd=500_000,
    )
    v_cheap = FleetVehicle(
        id="v-cheap",
        plate_number="CHP-01",
        length_cm=300.0,
        width_cm=180.0,
        height_cm=180.0,
        payload_limit_kg=1000.0,
        depot=LocationPoint(id="depot", name="Depot", latitude=10.0, longitude=106.0),
        door_position="BACK",
        fuel_consumption_liters_per_100_km=10.0,
        load_fuel_surcharge_percent_at_full_payload=0.0,
        fixed_operating_cost_vnd=150_000,
    )
    driver = DriverOption(
        id="d-1",
        full_name="Driver 1",
        license_class="C",
        fixed_salary_monthly_vnd=0,
        trip_base_pay_vnd=50_000,
        per_km_pay_vnd=1_000,
    )
    order = OrderPair(
        id="order-1",
        order_number="ORD-01",
        pickup_location=LocationPoint(id="p-1", name="P1", latitude=10.05, longitude=106.05),
        delivery_location=LocationPoint(id="d-1", name="D1", latitude=10.10, longitude=106.10),
        pickup_window_start_sec=0,
        pickup_window_end_sec=3600,
        delivery_window_start_sec=1800,
        delivery_window_end_sec=7200,
        items=[
            CargoItem(
                id="item-1",
                order_id="order-1",
                length_cm=100.0,
                width_cm=80.0,
                height_cm=80.0,
                weight_kg=100.0,
            )
        ],
    )
    policy = CostPolicy(
        fuel_price_per_liter_vnd=20_000,
        monthly_working_minutes=10_000,
        cargo_holding_cost_vnd_per_ton_hour=0,
        unassigned_order_penalty_vnd=1_000_000,
        late_delivery_penalty_mode="PER_HOUR",
        late_delivery_penalty_value=0,
    )
    node_map = {"depot": 0, "p-1": 1, "d-1": 2}
    dist = [[0, 10000, 15000], [10000, 0, 8000], [15000, 8000, 0]]
    dur = [[0, 600, 900], [600, 0, 500], [900, 500, 0]]

    solver = HybridALNSSolver(
        vehicles=[v_expensive, v_cheap],
        drivers=[driver, driver],
        orders=[order],
        policy=policy,
        distance_matrix=dist,
        duration_matrix=dur,
        node_id_to_index=node_map,
        time_limit_sec=2.0,
    )

    # Place order on expensive vehicle initially
    p, d = solver._make_stops(order)
    initial_routes = [[p, d], []]
    reassigned = solver._best_vehicle_reassignment(initial_routes, [], deadline=999999999.0)
    assert reassigned is not None
    cost, routes, unassigned = reassigned
    assert not unassigned
    assert routes[0] == []  # expensive vehicle is now empty
    assert len(routes[1]) == 2  # cheap vehicle now has the stops
    assert cost < solver._plan_cost(initial_routes, [])
