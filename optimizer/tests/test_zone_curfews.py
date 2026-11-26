from __future__ import annotations

from app.hybrid_alns.models import (
    CargoItem as ALNSCargoItem,
    CostPolicy as ALNSCostPolicy,
    DriverOption as ALNSDriverOption,
    FleetVehicle as ALNSFleetVehicle,
    LocationPoint as ALNSLocationPoint,
    OrderPair as ALNSOrderPair,
)
from app.hybrid_alns.solver import HybridALNSSolver
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import (
    CargoItem,
    CostPolicy,
    CurfewWindow,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    advance_past_curfews,
    default_stacking_policy,
)


def _box_item(item_id: str, order_id: str = "O1", weight_kg: float = 100.0) -> CargoItem:
    return CargoItem(
        id=item_id,
        order_id=order_id,
        description=f"Item {item_id}",
        length_cm=80.0,
        width_cm=60.0,
        height_cm=60.0,
        weight_kg=weight_kg,
        cargo_kind="STANDARD",
        allow_upper_tier=True,
    )


def _location(loc_id: str, name: str, lat: float, lng: float) -> LocationPoint:
    return LocationPoint(id=loc_id, name=name, latitude=lat, longitude=lng)


def test_advance_past_curfews_respects_vehicle_payload_and_service_overlap():
    curfews = [
        CurfewWindow(start_sec=6 * 3600, end_sec=9 * 3600, max_payload_kg=2500.0),
        CurfewWindow(start_sec=16 * 3600, end_sec=20 * 3600, max_payload_kg=2500.0),
    ]
    # Light truck (<= 2500 kg) is unaffected.
    assert advance_past_curfews(7 * 3600, 600, 2450.0, curfews) == 7 * 3600
    # Heavy truck (> 2500 kg) arriving inside 06:00-09:00 must wait until 09:00.
    assert advance_past_curfews(7 * 3600, 600, 5200.0, curfews) == 9 * 3600
    # Heavy truck arriving at 05:55 with 10 min service overlaps 06:00 -> pushed to 09:00.
    assert advance_past_curfews(5 * 3600 + 55 * 60, 600, 5200.0, curfews) == 9 * 3600
    # Heavy truck arriving at 05:50 with 10 min service finishes right at 06:00 -> allowed.
    assert advance_past_curfews(5 * 3600 + 50 * 60, 600, 5200.0, curfews) == 5 * 3600 + 50 * 60


def test_optimizer_assigns_light_truck_for_curfew_locked_delivery():
    depot = _location("DEPOT", "Depot", 21.03, 105.90)
    pickup = _location("P1", "Kho Bac", 21.05, 105.91)
    delivery = _location("D1", "Hoan Kiem", 21.02, 105.85)

    # Delivery must happen 07:00-08:30, which is completely inside heavy-truck curfew 06:00-09:00.
    order = OrderPair(
        id="O1",
        order_number="ORD-CURFEW-1",
        pickup_location=pickup,
        delivery_location=delivery,
        pickup_window_start_sec=6 * 3600,
        pickup_window_end_sec=8 * 3600,
        delivery_window_start_sec=7 * 3600,
        delivery_window_end_sec=8 * 3600 + 1800,
        service_time_sec=600,
        items=[_box_item("I1", "O1", 400.0)],
        delivery_curfew_windows=[
            CurfewWindow(start_sec=6 * 3600, end_sec=9 * 3600, max_payload_kg=2500.0)
        ],
    )

    heavy = FleetVehicle(
        id="V-HEAVY",
        source_vehicle_id="SRC-HEAVY",
        plate_number="29D-5500",
        depot=depot,
        length_cm=600.0,
        width_cm=220.0,
        height_cm=220.0,
        payload_limit_kg=5500.0,
        available_start_sec=6 * 3600,
        available_end_sec=22 * 3600,
        fixed_operating_cost_vnd=100_000.0,
        fuel_consumption_liters_per_100_km=12.0,
    )
    light = FleetVehicle(
        id="V-LIGHT",
        source_vehicle_id="SRC-LIGHT",
        plate_number="29C-2450",
        depot=depot,
        length_cm=420.0,
        width_cm=190.0,
        height_cm=190.0,
        payload_limit_kg=2450.0,
        available_start_sec=6 * 3600,
        available_end_sec=22 * 3600,
        fixed_operating_cost_vnd=300_000.0,
        fuel_consumption_liters_per_100_km=14.0,
    )
    drivers = [
        DriverOption(
            id="DRV-1",
            source_driver_id="SRC-DRV-1",
            full_name="Tai xe 1",
            fixed_salary_monthly_vnd=9_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=3_000,
        ),
        DriverOption(
            id="DRV-2",
            source_driver_id="SRC-DRV-2",
            full_name="Tai xe 2",
            fixed_salary_monthly_vnd=9_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=3_000,
        ),
    ]

    # 4x4 matrix: V-HEAVY depot(0), V-LIGHT depot(1), P1(2), D1(3)
    dist_m = [
        [0.0, 0.0, 4000.0, 8000.0],
        [0.0, 0.0, 4000.0, 8000.0],
        [4000.0, 4000.0, 0.0, 9000.0],
        [8000.0, 8000.0, 9000.0, 0.0],
    ]
    dur = [
        [0.0, 0.0, 600.0, 1200.0],
        [0.0, 0.0, 600.0, 1200.0],
        [600.0, 600.0, 0.0, 1200.0],
        [1200.0, 1200.0, 1200.0, 0.0],
    ]
    policy = CostPolicy(
        fuel_price_per_liter_vnd=24_000,
        monthly_working_minutes=12_480,
    )

    req = FleetOptimizationRequest(
        job_id="test-curfew-1",
        vehicles=[heavy, light],
        drivers=drivers,
        orders=[order],
        demo_stacking=default_stacking_policy(),
        policy=policy,
        max_time_seconds=3,
        search_time_seconds=3,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur,
    )

    res = PackingAwareHybridALNSOptimizer(req).solve()
    assert len(res.routes) == 1, "Order should be served by light truck despite heavy truck being cheaper"
    assert res.unassigned_orders == []
    assert res.routes[0].vehicle_id == "SRC-LIGHT"
    deliv_stop = next(s for s in res.routes[0].stops if s.stop_type == "DELIVERY")
    assert 7 * 3600 <= deliv_stop.arrival_time_sec <= 8 * 3600 + 1800


def test_hybrid_alns_solver_prescreen_cache_parity_with_curfew():
    depot = ALNSLocationPoint(id="DEPOT", name="Depot", latitude=21.03, longitude=105.90)
    pickup = ALNSLocationPoint(id="P1", name="Kho", latitude=21.04, longitude=105.91)
    delivery = ALNSLocationPoint(id="D1", name="Noi thanh", latitude=21.02, longitude=105.85)

    # Delivery window is 07:00-11:00, heavy truck has curfew 06:00-09:00 -> must wait until 09:00.
    order = ALNSOrderPair(
        id="O1",
        order_number="ORD-CURFEW-2",
        pickup_location=pickup,
        delivery_location=delivery,
        pickup_window_start_sec=6 * 3600,
        pickup_window_end_sec=10 * 3600,
        delivery_window_start_sec=7 * 3600,
        delivery_window_end_sec=11 * 3600,
        service_time_sec=600,
        items=[
            ALNSCargoItem(
                id="I1",
                order_id="O1",
                description="Item I1",
                length_cm=80.0,
                width_cm=60.0,
                height_cm=60.0,
                weight_kg=400.0,
            )
        ],
        delivery_curfew_windows=[
            CurfewWindow(start_sec=6 * 3600, end_sec=9 * 3600, max_payload_kg=2500.0)
        ],
    )
    heavy = ALNSFleetVehicle(
        id="V-HEAVY",
        source_vehicle_id="SRC-HEAVY",
        plate_number="29D-5500",
        depot=depot,
        length_cm=600.0,
        width_cm=220.0,
        height_cm=220.0,
        payload_limit_kg=5500.0,
        available_start_sec=6 * 3600,
        available_end_sec=22 * 3600,
        fuel_consumption_liters_per_100_km=12.0,
        fixed_operating_cost_vnd=100_000.0,
    )
    drivers = [
        ALNSDriverOption(
            id="DRV-1",
            source_driver_id="SRC-DRV-1",
            full_name="Tai xe 1",
            fixed_salary_monthly_vnd=9_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=3_000,
        )
    ]
    dist_km = [[0.0, 3.0, 7.0], [3.0, 0.0, 8.0], [7.0, 8.0, 0.0]]
    dur = [[0.0, 600.0, 1200.0], [600.0, 0.0, 1200.0], [1200.0, 1200.0, 0.0]]
    node_id_to_index = {"DEPOT": 0, "P1": 1, "D1": 2}
    policy = ALNSCostPolicy(
        fuel_price_per_liter_vnd=24_000,
        monthly_working_minutes=12_480,
        demo_stacking=default_stacking_policy(),
    )

    sol_cached = HybridALNSSolver(
        vehicles=[heavy],
        drivers=drivers,
        orders=[order],
        policy=policy,
        distance_matrix=dist_km,
        duration_matrix=dur,
        node_id_to_index=node_id_to_index,
        time_limit_sec=2.5,
        post_audit_reserve_sec=0.5,
        random_seed=0,
        enable_repair_option_cache=True,
    ).solve()
    sol_uncached = HybridALNSSolver(
        vehicles=[heavy],
        drivers=drivers,
        orders=[order],
        policy=policy,
        distance_matrix=dist_km,
        duration_matrix=dur,
        node_id_to_index=node_id_to_index,
        time_limit_sec=2.5,
        post_audit_reserve_sec=0.5,
        random_seed=0,
        enable_repair_option_cache=False,
    ).solve()

    assert len(sol_cached.routes) == 1
    assert len(sol_uncached.routes) == 1
    deliv_cached = next(s for s in sol_cached.routes[0].stops if s.stop_type == "DELIVERY")
    deliv_uncached = next(s for s in sol_uncached.routes[0].stops if s.stop_type == "DELIVERY")
    assert deliv_cached.arrival_time_sec >= 9 * 3600
    assert deliv_cached.arrival_time_sec == deliv_uncached.arrival_time_sec
