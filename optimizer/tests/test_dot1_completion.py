"""Tests for Đợt 1 completion: warehouse_location_id, HAZMAT, 2D/3D soft/hard WeightBalance, and VN 2024 48h/week policy."""

from __future__ import annotations

import pytest

from app.alns_engine import ALNSFleetOptimizer
from app.baseline_calculator import BaselineCostCalculator
from app.driver_matcher import DriverMatcher
from app.hybrid_alns.packing_checker import FastPackingChecker
from app.hybrid_alns.route_evaluator import _validate_route_packing_cached, schedule_and_evaluate_route
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.interprovincial import (
    check_cross_day_resource_conflicts,
    is_item_hazmat,
    is_location_accessible_for_vehicle,
    is_order_compatible_with_vehicle_and_warehouses,
    is_temperature_compatible,
    items_have_compatibility_conflict,
    location_identity,
    route_stops_have_cargo_conflict,
    stop_effective_service_seconds,
    vehicle_allows_hazmat,
)
from app.models import (
    CargoItem,
    CostPolicy,
    DemoStackingPolicy,
    DriverOption,
    DrivingRestPolicy,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    default_stacking_policy,
)
from app.multi_start import is_fully_served
from app.packing_rules import (
    build_weight_balance_metrics,
    calculate_route_weight_balance_penalty_vnd,
)
from app.request_preprocessor import split_orders_within_deadline
from app.route_costing import build_route_cost_breakdown
from app.routing_solver import FleetRoutingSolver
from app.stacking import fast_validate_stacked_route, validate_stop_actions


def _loc(
    loc_id: str,
    name: str,
    lat: float,
    lon: float,
    *,
    source_location_id: str | None = None,
    warehouse_location_id: str | None = None,
    docking_time_sec: int = 0,
    allows_hazmat: bool | None = None,
    province_code: str = "79",
    province_name: str = "TP. Hồ Chí Minh",
) -> LocationPoint:
    return LocationPoint(
        id=loc_id,
        source_location_id=source_location_id or loc_id,
        warehouse_location_id=warehouse_location_id,
        name=name,
        latitude=lat,
        longitude=lon,
        province_code=province_code,
        province_name=province_name,
        warehouse_role="WAREHOUSE" if warehouse_location_id else None,
        docking_time_sec=docking_time_sec,
        allows_hazmat=allows_hazmat,
    )


def _item(
    item_id: str,
    order_id: str,
    *,
    l: float = 100.0,
    w: float = 80.0,
    h: float = 80.0,
    kg: float = 400.0,
    required_temperature: str | None = None,
    cargo_group: str | None = None,
    incompatible_cargo_groups: list[str] | None = None,
    is_hazmat: bool = False,
) -> CargoItem:
    return CargoItem(
        id=item_id,
        order_id=order_id,
        length_cm=l,
        width_cm=w,
        height_cm=h,
        weight_kg=kg,
        can_rotate=True,
        cargo_kind="STANDARD",
        required_temperature=required_temperature,
        cargo_group=cargo_group,
        incompatible_cargo_groups=incompatible_cargo_groups or [],
        is_hazmat=is_hazmat,
    )


def _vehicle(
    vid: str,
    depot: LocationPoint,
    *,
    l: float = 420.0,
    w: float = 200.0,
    h: float = 200.0,
    payload_kg: float = 5000.0,
    day: int = 0,
    start_sec: int = 0,
    end_sec: int = 24 * 3600,
    temperature_mode: str = "DRY",
    allows_hazmat: bool = False,
    source_vehicle_id: str | None = None,
) -> FleetVehicle:
    return FleetVehicle(
        id=vid,
        source_vehicle_id=source_vehicle_id or vid,
        service_day_index=day,
        available_start_sec=start_sec,
        available_end_sec=end_sec,
        plate_number=f"51D-{vid}",
        length_cm=l,
        width_cm=w,
        height_cm=h,
        payload_limit_kg=payload_kg,
        depot=depot,
        temperature_mode=temperature_mode,
        allows_hazmat=allows_hazmat,
        fuel_consumption_liters_per_100_km=12.0,
        fixed_operating_cost_vnd=300_000,
    )


def _driver(
    did: str,
    *,
    day: int = 0,
    source_driver_id: str | None = None,
    initial_weekly_driving_sec: int = 0,
    license_class: str = "C",
) -> DriverOption:
    return DriverOption(
        id=did,
        source_driver_id=source_driver_id or did,
        service_day_index=day,
        full_name=f"Tai xe {did}",
        license_class=license_class,
        fixed_salary_monthly_vnd=12_000_000,
        trip_base_pay_vnd=150_000,
        per_km_pay_vnd=1_000,
        initial_weekly_driving_sec=initial_weekly_driving_sec,
    )


def _policy(
    *,
    rest_policy: DrivingRestPolicy | None = None,
    weight_balance_penalty_vnd_per_percent: int = 0,
    enforce_weight_balance: bool = False,
    max_lateral_imbalance_percent: float | None = None,
    max_longitudinal_imbalance_percent: float | None = None,
) -> CostPolicy:
    return CostPolicy(
        fuel_price_per_liter_vnd=24_000,
        monthly_working_minutes=10_560,
        cargo_holding_cost_vnd_per_ton_hour=0,
        unassigned_order_penalty_vnd=1_000_000_000,
        driving_rest_policy=rest_policy,
        weight_balance_penalty_vnd_per_percent=weight_balance_penalty_vnd_per_percent,
        enforce_weight_balance=enforce_weight_balance,
        max_lateral_imbalance_percent=max_lateral_imbalance_percent,
        max_longitudinal_imbalance_percent=max_longitudinal_imbalance_percent,
    )


def test_warehouse_location_id_coalesces_docking_while_preserving_order_stop_id():
    depot = _loc("depot-1", "Depot SG", 10.8, 106.6, warehouse_location_id="wh-depot")
    p1 = _loc(
        "order-stop-1-p",
        "Kho Hub A (Don 1)",
        10.81,
        106.61,
        source_location_id="os-1-p",
        warehouse_location_id="wh-hub-a",
        docking_time_sec=900,
    )
    d1 = _loc("order-stop-1-d", "Khach 1", 10.85, 106.65, source_location_id="os-1-d")
    p2 = _loc(
        "order-stop-2-p",
        "Kho Hub A (Don 2)",
        10.81,
        106.61,
        source_location_id="os-2-p",
        warehouse_location_id="wh-hub-a",
        docking_time_sec=900,
    )
    d2 = _loc("order-stop-2-d", "Khach 2", 10.86, 106.66, source_location_id="os-2-d")

    assert location_identity(p1) == "wh-hub-a"
    assert location_identity(p2) == "wh-hub-a"

    ord1 = OrderPair(
        id="o1",
        order_number="ORD-01",
        pickup_location=p1,
        delivery_location=d1,
        items=[_item("i1", "o1")],
        service_time_sec=300,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
        pickup_window_start_sec=0,
        pickup_window_end_sec=12 * 3600,
        delivery_window_start_sec=0,
        delivery_window_end_sec=12 * 3600,
        order_value_vnd=1_000_000,
        package_contract_version="1",
    )
    ord2 = OrderPair(
        id="o2",
        order_number="ORD-02",
        pickup_location=p2,
        delivery_location=d2,
        items=[_item("i2", "o2")],
        service_time_sec=300,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
        pickup_window_start_sec=0,
        pickup_window_end_sec=12 * 3600,
        delivery_window_start_sec=0,
        delivery_window_end_sec=12 * 3600,
        order_value_vnd=1_000_000,
        package_contract_version="1",
    )

    s1, key1 = stop_effective_service_seconds(ord1, "PICKUP", None)
    s2, key2 = stop_effective_service_seconds(ord2, "PICKUP", key1)
    assert key1 == "wh-hub-a" and key2 == "wh-hub-a"
    assert s1 == 1200  # 300 + 900 docking
    assert s2 == 300   # coalesced docking

    # 5 nodes: depot, p1, d1, p2, d2
    dist = [[5000.0 if i != j else 0.0 for j in range(5)] for i in range(5)]
    dur = [[600.0 if i != j else 0.0 for j in range(5)] for i in range(5)]
    dist[1][3] = dist[3][1] = 0.0
    dur[1][3] = dur[3][1] = 0.0

    req = FleetOptimizationRequest(
        job_id="wh-coalesce-test",
        vehicles=[_vehicle("v1", depot)],
        drivers=[_driver("drv1")],
        orders=[ord1, ord2],
        policy=_policy(),
        max_time_seconds=8,
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )

    for solver_cls in (ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver):
        resp = solver_cls(req).solve()
        assert resp.status == "SUCCESS"
        assert len(resp.routes) == 1
        pickups = [st for st in resp.routes[0].stops if st.stop_type == "PICKUP"]
        assert {st.order_stop_id for st in pickups} == {"os-1-p", "os-2-p"}
        # Consecutive pickups at identical physical warehouse coalesce 900s docking once
        if resp.routes[0].stops[0].stop_type == "PICKUP" and resp.routes[0].stops[1].stop_type == "PICKUP":
            assert [st.service_time_sec for st in pickups] == [1200, 300]


def test_request_preprocessor_preserves_warehouse_and_hazmat_metadata():
    depot = _loc("d1", "Depot", 10.8, 106.6)
    p1 = _loc(
        "o-split-p",
        "Kho Hoa Chat",
        10.81,
        106.61,
        source_location_id="os-split-p",
        warehouse_location_id="wh-chem",
        docking_time_sec=600,
        allows_hazmat=True,
    )
    deliv = _loc("o-split-d", "Kho Nhan", 10.85, 106.65, source_location_id="os-split-d")
    big_order = OrderPair(
        id="o-big",
        order_number="ORD-BIG",
        pickup_location=p1,
        delivery_location=deliv,
        items=[
            _item("big-1", "o-big", l=150, w=120, h=100, kg=2500, is_hazmat=True, cargo_group="HAZMAT"),
            _item("big-2", "o-big", l=150, w=120, h=100, kg=2500, is_hazmat=True, cargo_group="HAZMAT"),
        ],
        service_time_sec=300,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
        order_value_vnd=2_000_000,
        package_contract_version="1",
    )
    veh_1 = _vehicle("v-haz-1", depot, l=300, w=200, h=200, payload_kg=3000, allows_hazmat=True, day=0)
    veh_2 = _vehicle("v-haz-2", depot, l=300, w=200, h=200, payload_kg=3000, allows_hazmat=True, day=1)
    req = FleetOptimizationRequest(
        job_id="split-meta",
        vehicles=[veh_1, veh_2],
        drivers=[_driver("drv-1", day=0), _driver("drv-2", day=1)],
        orders=[big_order],
        demo_stacking=None,
        policy=_policy(),
        distance_matrix_meters=[[1000.0 if i != j else 0.0 for j in range(4)] for i in range(4)],
        duration_matrix_seconds=[[120.0 if i != j else 0.0 for j in range(4)] for i in range(4)],
    )
    outcome = split_orders_within_deadline(req)
    assert outcome.split_order_count == 1
    assert len(outcome.request.orders) == 2
    for part in outcome.request.orders:
        assert part.pickup_location.source_location_id == "os-split-p"
        assert part.pickup_location.warehouse_location_id == "wh-chem"
        assert part.pickup_location.allows_hazmat is True
        assert part.items[0].is_hazmat is True


def test_hazmat_rules_across_unit_checks_and_all_solvers():
    haz_item = _item("h1", "oh", is_hazmat=True, required_temperature="HAZMAT", cargo_group="HAZMAT")
    dry_item = _item("d1", "od")
    veh_dry = _vehicle("vdry", _loc("dp1", "Depot", 10.8, 106.6), temperature_mode="DRY", allows_hazmat=False)
    veh_haz_flag = _vehicle("vhaz", _loc("dp2", "Depot", 10.8, 106.6), temperature_mode="DRY", allows_hazmat=True)
    veh_haz_mode = _vehicle("vhaz2", _loc("dp3", "Depot", 10.8, 106.6), temperature_mode="HAZMAT")

    assert is_item_hazmat(haz_item)
    assert not is_item_hazmat(dry_item)
    assert not vehicle_allows_hazmat(veh_dry)
    assert vehicle_allows_hazmat(veh_haz_flag)
    assert vehicle_allows_hazmat(veh_haz_mode)
    assert not is_temperature_compatible("HAZMAT", "DRY", allows_hazmat=False)
    assert is_temperature_compatible("HAZMAT", "DRY", allows_hazmat=True)
    assert is_temperature_compatible("HAZMAT", "HAZMAT")
    assert items_have_compatibility_conflict([haz_item], [dry_item])

    wh_no_haz = _loc("wh-no", "Kho Cấm Hazmat", 10.81, 106.61, allows_hazmat=False)
    wh_ok_haz = _loc("wh-ok", "Kho OK Hazmat", 10.82, 106.62, allows_hazmat=True)
    assert not is_location_accessible_for_vehicle(wh_no_haz, veh_haz_flag, requires_hazmat=True)
    assert is_location_accessible_for_vehicle(wh_ok_haz, veh_haz_flag, requires_hazmat=True)

    ord_haz = OrderPair(
        id="ord-haz",
        order_number="ORD-HAZ",
        pickup_location=wh_ok_haz,
        delivery_location=_loc("del-h", "Diem Giao H", 10.84, 106.64),
        items=[haz_item],
        service_time_sec=300,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
        order_value_vnd=5_000_000,
        package_contract_version="1",
    )
    ord_dry = OrderPair(
        id="ord-dry",
        order_number="ORD-DRY",
        pickup_location=_loc("p-d", "Kho Thuong", 10.83, 106.63),
        delivery_location=_loc("d-d", "Diem Giao D", 10.85, 106.65),
        items=[dry_item],
        service_time_sec=300,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
        order_value_vnd=2_000_000,
        package_contract_version="1",
    )
    assert not is_order_compatible_with_vehicle_and_warehouses(ord_haz, veh_dry)
    assert is_order_compatible_with_vehicle_and_warehouses(ord_haz, veh_haz_flag)

    # Disallow HAZMAT + regular cargo simultaneously on one trip
    overlapping_stops = [
        ScheduledStop(sequence=1, location_id="wh-ok", location_name="p", stop_type="PICKUP", order_id="ord-haz", allocation_id="ord-haz", latitude=10.8, longitude=106.6, arrival_time_sec=0, departure_time_sec=300),
        ScheduledStop(sequence=2, location_id="p-d", location_name="p2", stop_type="PICKUP", order_id="ord-dry", allocation_id="ord-dry", latitude=10.8, longitude=106.6, arrival_time_sec=400, departure_time_sec=700),
        ScheduledStop(sequence=3, location_id="del-h", location_name="d1", stop_type="DELIVERY", order_id="ord-haz", allocation_id="ord-haz", latitude=10.8, longitude=106.6, arrival_time_sec=800, departure_time_sec=1100),
        ScheduledStop(sequence=4, location_id="d-d", location_name="d2", stop_type="DELIVERY", order_id="ord-dry", allocation_id="ord-dry", latitude=10.8, longitude=106.6, arrival_time_sec=1200, departure_time_sec=1500),
    ]
    assert route_stops_have_cargo_conflict(overlapping_stops, {"ord-haz": ord_haz, "ord-dry": ord_dry})

    # Solvers must assign ord-haz exclusively to veh_haz_flag, never veh_dry
    dist = [[5000.0 if i != j else 0.0 for j in range(6)] for i in range(6)]
    dur = [[300.0 if i != j else 0.0 for j in range(6)] for i in range(6)]
    req = FleetOptimizationRequest(
        job_id="hazmat-routing",
        vehicles=[veh_dry, veh_haz_flag],
        drivers=[_driver("drv-1"), _driver("drv-2")],
        orders=[ord_haz, ord_dry],
        policy=_policy(),
        max_time_seconds=8,
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )
    for solver_cls in (ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver):
        res = solver_cls(req).solve()
        assert res.status == "SUCCESS"
        for route in res.routes:
            route_oids = {s.allocation_id or s.order_id for s in route.stops}
            if "ord-haz" in route_oids:
                assert route.vehicle_id == "vhaz"
            assert not route_stops_have_cargo_conflict(
                route.stops, {"ord-haz": ord_haz, "ord-dry": ord_dry}
            )

    # Warehouse forbids hazmat -> hazmat order unassigned even with certified truck
    ord_haz_blocked = ord_haz.model_copy(update={"pickup_location": wh_no_haz})
    blocked_req = req.model_copy(update={
        "vehicles": [veh_haz_flag],
        "drivers": [_driver("drv-h")],
        "orders": [ord_haz_blocked],
        "distance_matrix_meters": [[0, 1000, 1000], [1000, 0, 1000], [1000, 1000, 0]],
        "duration_matrix_seconds": [[0, 120, 120], [120, 0, 120], [120, 120, 0]],
    })
    for solver_cls in (ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver):
        blocked_res = solver_cls(blocked_req).solve()
        assert [u.order_id for u in blocked_res.unassigned_orders] == ["ord-haz"]


def test_weight_balance_hard_and_soft_2d_3d_and_caching():
    depot = _loc("d1", "Depot", 10.8, 106.6)
    veh = _vehicle("vwb", depot, l=400.0, w=200.0, h=200.0, payload_kg=5000.0)
    p_loc = _loc("pw", "Pickup", 10.81, 106.61)
    d_loc = _loc("dw", "Delivery", 10.82, 106.62)

    # Single off-center heavy box placed at corner (0,0) creates huge lateral & longitudinal imbalance
    heavy_corner = _item("corner", "o-wb", l=80.0, w=50.0, h=80.0, kg=2000.0)
    actions = [
        StopAction(stop_id="pw", sequence=1, stop_type="PICKUP", items_to_load=[heavy_corner]),
        StopAction(stop_id="dw", sequence=2, stop_type="DELIVERY", items_to_unload=["corner"]),
    ]
    stops = [
        ScheduledStop(sequence=1, location_id="pw", location_name="Pickup", stop_type="PICKUP", order_id="o-wb", allocation_id="o-wb", latitude=10.81, longitude=106.61, arrival_time_sec=600, departure_time_sec=900, items_loaded=["corner"], current_weight_kg=2000.0),
        ScheduledStop(sequence=2, location_id="dw", location_name="Delivery", stop_type="DELIVERY", order_id="o-wb", allocation_id="o-wb", latitude=10.82, longitude=106.62, arrival_time_sec=1500, departure_time_sec=1800, items_unloaded=["corner"], current_weight_kg=0.0),
    ]

    # 1. Hard 2D check via CostPolicy & FastPackingChecker (longitudinal + asymmetric lateral)
    strict_2d_cost = _policy(
        enforce_weight_balance=True,
        max_lateral_imbalance_percent=10.0,
        max_longitudinal_imbalance_percent=20.0,
    )
    res_2d = validate_stop_actions(None, veh, actions, cost_policy=strict_2d_cost)
    assert not res_2d.is_valid
    assert res_2d.violation_code == "WEIGHT_BALANCE_EXCEEDED"

    ok_fast_2d, msg_fast_2d = FastPackingChecker(veh, demo_stacking=None, cost_policy=strict_2d_cost).validate_route_stops(
        stops, {"corner": heavy_corner}
    )
    assert not ok_fast_2d
    assert "WEIGHT_BALANCE_EXCEEDED" in msg_fast_2d

    # Asymmetric lateral 2-box test where centering cannot eliminate left/right imbalance
    heavy_left = _item("asym-l", "o-wb", l=390.0, w=100.0, h=80.0, kg=2500.0)
    light_right = _item("asym-r", "o-wb", l=390.0, w=100.0, h=80.0, kg=200.0)
    asym_actions = [
        StopAction(stop_id="pw", sequence=1, stop_type="PICKUP", items_to_load=[heavy_left, light_right]),
        StopAction(stop_id="dw", sequence=2, stop_type="DELIVERY", items_to_unload=["asym-l", "asym-r"]),
    ]
    strict_lat_2d = _policy(enforce_weight_balance=True, max_lateral_imbalance_percent=10.0)
    res_lat_2d = validate_stop_actions(None, veh, asym_actions, cost_policy=strict_lat_2d)
    assert not res_lat_2d.is_valid
    assert res_lat_2d.violation_code == "WEIGHT_BALANCE_EXCEEDED"

    # 2. 3D cache separation between relaxed and strict WeightBalance policy
    relaxed_3d = default_stacking_policy()
    strict_3d = DemoStackingPolicy(
        max_tiers=3,
        lift_clearance_cm=5.0,
        owner_mode="ANY_CUSTOMER",
        enforce_weight_balance=True,
        max_lateral_imbalance_percent=10.0,
        max_longitudinal_imbalance_percent=20.0,
    )
    ok_relaxed, _ = fast_validate_stacked_route(veh, stops, {"corner": heavy_corner}, relaxed_3d)
    assert ok_relaxed
    ok_strict, msg_strict = fast_validate_stacked_route(veh, stops, {"corner": heavy_corner}, strict_3d)
    assert not ok_strict
    assert "WEIGHT_BALANCE_EXCEEDED" in msg_strict

    cache: dict = {}
    ok_c1, _, _ = _validate_route_packing_cached(veh, stops, {"corner": heavy_corner}, _policy(), allow_layout_search=True, packing_cache=cache)
    ok_c2, _, _ = _validate_route_packing_cached(veh, stops, {"corner": heavy_corner}, strict_2d_cost, allow_layout_search=True, packing_cache=cache)
    assert ok_c1 is True
    assert ok_c2 is False

    # 3. Soft penalty propagation across FastPackingChecker, route_costing, and solvers
    soft_pol = _policy(weight_balance_penalty_vnd_per_percent=10_000)
    ok_bal, _, step_balances = FastPackingChecker(veh, demo_stacking=relaxed_3d, cost_policy=soft_pol).validate_route_stops_with_balances(
        stops, {"corner": heavy_corner}
    )
    assert ok_bal
    expected_soft = calculate_route_weight_balance_penalty_vnd(step_balances, soft_pol, relaxed_3d)
    assert expected_soft > 0

    ord_wb = OrderPair(
        id="o-wb",
        order_number="ORD-WB",
        pickup_location=p_loc,
        delivery_location=d_loc,
        items=[heavy_corner],
        service_time_sec=300,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
        order_value_vnd=3_000_000,
        package_contract_version="1",
    )
    req_soft = FleetOptimizationRequest(
        job_id="soft-wb",
        vehicles=[veh],
        drivers=[_driver("drv1")],
        orders=[ord_wb],
        policy=soft_pol,
        max_time_seconds=8,
        distance_matrix_meters=[[0, 5000, 6000], [5000, 0, 4000], [6000, 4000, 0]],
        duration_matrix_seconds=[[0, 600, 720], [600, 0, 480], [720, 480, 0]],
    )
    for solver_cls in (ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver):
        sol = solver_cls(req_soft).solve()
        assert sol.status == "SUCCESS"
        route_cost = sol.routes[0].cost
        assert route_cost is not None
        audited_wb = [
            st.weight_balance
            for st in sol.routes[0].spatial_validation.step_states
            if st.weight_balance is not None
        ]
        audited_expected = calculate_route_weight_balance_penalty_vnd(
            audited_wb, soft_pol, sol.routes[0].spatial_validation.demo_stacking
        )
        assert audited_expected > 0
        assert route_cost.weight_balance_penalty_vnd == audited_expected
        assert route_cost.total_cost_vnd == (
            route_cost.fuel_cost_vnd
            + route_cost.vehicle_fixed_cost_vnd
            + route_cost.driver_fixed_salary_allocation_vnd
            + route_cost.driver_trip_pay_vnd
            + route_cost.cargo_holding_cost_vnd
            + route_cost.late_delivery_penalty_vnd
            + route_cost.toll_cost_vnd
            + route_cost.overnight_allowance_vnd
            + route_cost.weight_balance_penalty_vnd
        )

    # Balanced full-bed item (CG centered at 50%/50%) gets 0 soft penalty
    balanced_item = _item("full", "o-wb", l=400.0, w=200.0, h=80.0, kg=2000.0)
    ord_balanced = ord_wb.model_copy(update={"items": [balanced_item]})
    sol_bal = ALNSFleetOptimizer(req_soft.model_copy(update={"orders": [ord_balanced]})).solve()
    assert sol_bal.status == "SUCCESS"
    assert sol_bal.routes[0].cost is not None
    assert sol_bal.routes[0].cost.weight_balance_penalty_vnd == 0

    nodes = [
        {"id": depot.id, "latitude": depot.latitude, "longitude": depot.longitude},
        {"id": p_loc.id, "latitude": p_loc.latitude, "longitude": p_loc.longitude},
        {"id": d_loc.id, "latitude": d_loc.latitude, "longitude": d_loc.longitude},
    ]
    direct = BaselineCostCalculator(req_soft, nodes).compute_direct_dedicated()
    assert direct.is_feasible
    assert direct.routes[0].cost is not None
    assert direct.routes[0].cost.weight_balance_penalty_vnd > 0


def test_vn2024_policy_defaults_and_weekly_48h_driving_enforcement():
    # VN TTATGTĐB 2024 defaults: 4h continuous / 15m rest / 10h day / 8h daily rest / 48h week
    pol = DrivingRestPolicy()
    assert pol.max_continuous_driving_sec == 4 * 3600
    assert pol.short_rest_duration_sec == 15 * 60
    assert pol.max_daily_driving_sec == 10 * 3600
    assert pol.daily_rest_duration_sec == 8 * 3600
    assert pol.max_weekly_driving_sec == 48 * 3600

    depot = _loc("d1", "Depot", 10.8, 106.6)
    # 5 daily slots for 1 physical driver drv-p, 10h driving each day -> 50h/week > 48h
    vehicles = [
        _vehicle(f"v-d{d}", depot, day=d, start_sec=d * 86400, end_sec=d * 86400 + 20 * 3600)
        for d in range(5)
    ]
    drivers_single_phys = [
        _driver(f"drv-d{d}", day=d, source_driver_id="phys-drv-1")
        for d in range(5)
    ]
    orders = [
        OrderPair(
            id=f"ord-{d}",
            order_number=f"O-{d}",
            pickup_location=_loc(f"p-{d}", "P", 10.81, 106.61),
            delivery_location=_loc(f"del-{d}", "D", 10.82, 106.62),
            items=[_item(f"it-{d}", f"ord-{d}")],
            service_time_sec=300,
            pickup_service_time_sec=300,
            delivery_service_time_sec=300,
            pickup_window_start_sec=d * 86400,
            pickup_window_end_sec=d * 86400 + 20 * 3600,
            delivery_window_start_sec=d * 86400,
            delivery_window_end_sec=d * 86400 + 20 * 3600,
            order_value_vnd=1_000_000,
            package_contract_version="1",
        )
        for d in range(5)
    ]
    n = len(vehicles) + 2 * len(orders)
    req_weekly = FleetOptimizationRequest(
        job_id="weekly-cap",
        vehicles=vehicles,
        drivers=drivers_single_phys,
        orders=orders,
        policy=_policy(rest_policy=DrivingRestPolicy()),
        distance_matrix_meters=[[1000.0 if i != j else 0.0 for j in range(n)] for i in range(n)],
        duration_matrix_seconds=[[1000.0 if i != j else 0.0 for j in range(n)] for i in range(n)],
    )
    sample_routes = [
        OptimizedRoute(
            route_id=f"v-d{d}",
            vehicle_id=f"v-d{d}",
            service_day_index=d,
            start_time_sec=d * 86400,
            end_time_sec=d * 86400 + 12 * 3600,
            plate_number=f"51D-v-d{d}",
            vehicle_length_cm=420,
            vehicle_width_cm=200,
            vehicle_height_cm=200,
            total_distance_km=500.0,
            total_duration_minutes=720.0,
            total_driving_sec=10 * 3600,
            stops=[],
            spatial_validation=SpatialValidationResult(is_valid=True),
            cost=RouteCostBreakdown(
                base_fuel_cost_vnd=100_000,
                load_fuel_surcharge_vnd=0,
                fuel_cost_vnd=100_000,
                cargo_holding_cost_vnd=0,
                cargo_distance_ton_km=0,
                cargo_time_ton_hours=0,
                vehicle_fixed_cost_vnd=300_000,
                driver_fixed_salary_allocation_vnd=0,
                driver_trip_pay_vnd=0,
                total_cost_vnd=400_000,
            ),
        )
        for d in range(5)
    ]

    with pytest.raises(ValueError):
        DriverMatcher(req_weekly).assign_drivers_to_routes(sample_routes)

    # Moving the 5th day into week 1 (day=7) gives 40h in week 0 and 10h in week 1 -> allowed
    veh_week1 = _vehicle("v-d7", depot, day=7, start_sec=7 * 86400, end_sec=7 * 86400 + 20 * 3600)
    drv_week1 = _driver("drv-d7", day=7, source_driver_id="phys-drv-1")
    req_two_weeks = req_weekly.model_copy(update={
        "vehicles": vehicles[:4] + [veh_week1],
        "drivers": drivers_single_phys[:4] + [drv_week1],
    })
    routes_two_weeks = sample_routes[:4] + [
        sample_routes[4].model_copy(
            update={
                "route_id": "v-d7",
                "vehicle_id": "v-d7",
                "service_day_index": 7,
                "start_time_sec": 7 * 86400,
                "end_time_sec": 7 * 86400 + 12 * 3600,
            }
        )
    ]
    matched_two_weeks = DriverMatcher(req_two_weeks).assign_drivers_to_routes(routes_two_weeks)
    assert all(r.driver_id == "phys-drv-1" for r in matched_two_weeks)
    assert not check_cross_day_resource_conflicts(
        matched_two_weeks,
        {v.id: v for v in req_two_weeks.vehicles},
        max_weekly_driving_sec=48 * 3600,
        driver_by_id={d.id: d for d in req_two_weeks.drivers},
    )

    # Initial weekly driving hours from prior trips in same week block exceeding 48h
    drv_tired = _driver("drv-tired", initial_weekly_driving_sec=42 * 3600)
    drv_fresh = _driver("drv-fresh", initial_weekly_driving_sec=0)
    req_init = FleetOptimizationRequest(
        job_id="init-weekly",
        vehicles=[_vehicle("v1", depot)],
        drivers=[drv_tired, drv_fresh],
        orders=[orders[0]],
        policy=_policy(rest_policy=DrivingRestPolicy()),
        max_time_seconds=8,
        distance_matrix_meters=[[0, 100_000, 100_000], [100_000, 0, 100_000], [100_000, 100_000, 0]],
        # 3h + 3h + 3h = 9h driving: 42 + 9 = 51h > 48h for drv-tired
        duration_matrix_seconds=[[0, 3 * 3600, 3 * 3600], [3 * 3600, 0, 3 * 3600], [3 * 3600, 3 * 3600, 0]],
    )
    for solver_cls in (ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver):
        sol = solver_cls(req_init).solve()
        assert sol.status == "SUCCESS"
        assert sol.routes[0].total_driving_sec == 9 * 3600
        assert sol.routes[0].driver_id == "drv-fresh"

    assert check_cross_day_resource_conflicts(
        [
            sample_routes[0].model_copy(
                update={"driver_id": "drv-tired", "total_driving_sec": 9 * 3600}
            )
        ],
        {"v-d0": vehicles[0]},
        max_weekly_driving_sec=48 * 3600,
        driver_by_id={"drv-tired": drv_tired},
    )
    assert not is_fully_served(
        ALNSFleetOptimizer(req_init).solve().model_copy(
            update={
                "routes": [
                    ALNSFleetOptimizer(req_init).solve().routes[0].model_copy(
                        update={"driver_id": "drv-tired"}
                    )
                ]
            }
        ),
        {"ord-0"},
        vehicle_by_id={"v1": req_init.vehicles[0]},
        max_weekly_driving_sec=48 * 3600,
        driver_by_id={"drv-tired": drv_tired, "drv-fresh": drv_fresh},
    )
