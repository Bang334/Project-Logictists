"""Comprehensive unit and integration tests for inter-provincial warehouse routing & rest rules."""

from __future__ import annotations

import pytest

from app.alns_engine import ALNSFleetOptimizer
from app.baseline_calculator import BaselineCostCalculator
from app.demo import (
    DemoRunRequest,
    list_demo_cases,
    list_interprovincial_demo_cases,
    run_demo_case,
)
from app.driver_matcher import DriverMatcher
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.interprovincial import (
    check_cross_day_resource_conflicts,
    estimate_driving_rest_lower_bound_sec,
    is_driver_compatible_with_vehicle,
    is_order_compatible_with_vehicle_and_warehouses,
    resolve_vehicle_end_node_index,
    route_stops_have_cargo_conflict,
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
    StopAction,
    WarehouseOperatingWindow,
)
from app.multi_start import is_fully_served
from app.request_preprocessor import (
    prune_unserviceable_virtual_resources,
    split_orders_within_deadline,
)
from app.routing_solver import FleetRoutingSolver
from app.stacking import validate_stop_actions


def _wh(
    loc_id: str,
    name: str,
    lat: float,
    lon: float,
    prov_code: str,
    prov_name: str,
    *,
    role: str = "WAREHOUSE",
    docking_sec: int = 0,
) -> LocationPoint:
    return LocationPoint(
        id=loc_id,
        source_location_id=loc_id,
        name=name,
        latitude=lat,
        longitude=lon,
        province_code=prov_code,
        province_name=prov_name,
        warehouse_role=role,
        docking_time_sec=docking_sec,
    )


def _item(item_id: str, order_id: str, l: float = 120.0, w: float = 100.0, h: float = 90.0, kg: float = 800.0) -> CargoItem:
    return CargoItem(
        id=item_id,
        order_id=order_id,
        length_cm=l,
        width_cm=w,
        height_cm=h,
        weight_kg=kg,
        can_rotate=True,
        cargo_kind="STANDARD",
    )


def _base_policy(rest_policy: DrivingRestPolicy | None = None) -> CostPolicy:
    return CostPolicy(
        fuel_price_per_liter_vnd=22_000,
        monthly_working_minutes=10_560,
        cargo_holding_cost_vnd_per_ton_hour=10_000,
        unassigned_order_penalty_vnd=50_000_000,
        driving_rest_policy=rest_policy,
    )


def _assert_route_timeline_contract(route) -> None:
    prev_dep = route.start_time_sec
    for stop in route.stops:
        assert stop.arrival_time_sec - prev_dep == stop.travel_time_sec + stop.waiting_time_sec
        assert stop.departure_time_sec - stop.arrival_time_sec == stop.service_time_sec
        prev_dep = stop.departure_time_sec
    assert route.end_time_sec - prev_dep == route.return_travel_time_sec + route.return_waiting_time_sec


def test_driving_rest_policy_validation_and_lower_bound() -> None:
    policy = DrivingRestPolicy()
    assert policy.max_continuous_driving_sec == 4 * 3600
    assert policy.short_rest_duration_sec == 15 * 60
    assert policy.max_daily_driving_sec == 10 * 3600
    assert policy.daily_rest_duration_sec == 8 * 3600

    # 3h59m needs 0 rest; 4h01m needs 15m; 10h01m needs 8h + one 4h break
    assert estimate_driving_rest_lower_bound_sec(4 * 3600, policy) == 0
    assert estimate_driving_rest_lower_bound_sec(4 * 3600 + 1, policy) == 900
    assert estimate_driving_rest_lower_bound_sec(10 * 3600 + 1, policy) == 28800 + 900

    with pytest.raises(ValueError):
        DrivingRestPolicy(max_continuous_driving_sec=5 * 3600, max_daily_driving_sec=4 * 3600)
    with pytest.raises(ValueError):
        DrivingRestPolicy(max_daily_driving_sec=10 * 3600, max_weekly_driving_sec=8 * 3600)


@pytest.mark.parametrize(
    "solver_cls",
    [ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver],
)
def test_mandatory_rest_and_open_route_across_all_solvers(solver_cls) -> None:
    wh_hn = _wh("WH-HN", "Kho Hà Nội", 21.0285, 105.8542, "VN-HN", "Hà Nội", role="HUB", docking_sec=600)
    wh_na = _wh("WH-NA", "Kho Vinh - Nghệ An", 18.6796, 105.6813, "VN-NA", "Nghệ An", role="WAREHOUSE", docking_sec=600)

    veh = FleetVehicle(
        id="V1",
        plate_number="29H-10001",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=40_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    drv = DriverOption(
        id="D1",
        full_name="Tài xế HN",
        license_class="C",
        home_location_id="WH-HN",
        home_province_code="VN-HN",
        strict_home_location=True,
        fixed_salary_monthly_vnd=15_000_000,
        trip_base_pay_vnd=400_000,
        per_km_pay_vnd=3_000,
    )
    order = OrderPair(
        id="O1",
        order_number="WH-TR-01",
        pickup_location=wh_hn,
        delivery_location=wh_na,
        items=[_item("I1", "O1")],
        pickup_window_start_sec=0,
        pickup_window_end_sec=20_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=35_000,
        pickup_service_time_sec=600,
        delivery_service_time_sec=600,
    )
    # Matrix indices: 0=V1 depot (HN), 1=O1 pickup (HN), 2=O1 delivery (NA)
    # 5 hours driving (18,000s) -> triggers one 15-min (900s) CONTINUOUS_DRIVING break.
    dist_m = [
        [0.0, 0.0, 300_000.0],
        [0.0, 0.0, 300_000.0],
        [300_000.0, 300_000.0, 0.0],
    ]
    dur_s = [
        [0.0, 0.0, 18_000.0],
        [0.0, 0.0, 18_000.0],
        [18_000.0, 18_000.0, 0.0],
    ]

    req = FleetOptimizationRequest(
        job_id="test-rest-open",
        vehicles=[veh],
        drivers=[drv],
        orders=[order],
        policy=_base_policy(DrivingRestPolicy()),
        demo_stacking=DemoStackingPolicy(max_tiers=3, lift_clearance_cm=5.0, owner_mode="ANY_CUSTOMER"),
        max_time_seconds=5,
        search_time_seconds=3,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
    )

    resp = solver_cls(req).solve()
    assert resp.status == "SUCCESS" and len(resp.routes) == 1
    route = resp.routes[0]
    _assert_route_timeline_contract(route)
    assert route.mandatory_rest_sec == 900
    assert len(route.rest_breaks) == 1 and route.rest_breaks[0].reason == "CONTINUOUS_DRIVING"
    assert route.return_travel_time_sec == 0
    assert route.return_waiting_time_sec == 0
    assert route.total_distance_km == pytest.approx(300.0, abs=0.1)
    assert route.end_location is not None and route.end_location.id == "WH-NA"
    assert route.province_hops == ["VN-HN", "VN-NA"]
    # Both pickup (WH-HN) and delivery (WH-NA) include docking_time_sec once
    assert route.stops[0].service_time_sec == 1200
    assert route.stops[1].service_time_sec == 1200
    assert route.stops[1].waiting_time_sec == 900


def test_mandatory_daily_rest_and_infeasible_tight_shift() -> None:
    wh_a = _wh("WH-A", "Kho Hà Nội", 21.03, 105.85, "VN-HN", "Hà Nội", role="HUB")
    wh_b = _wh("WH-B", "Kho Đà Nẵng", 16.05, 108.20, "VN-DN", "Đà Nẵng", role="HUB")

    def _build_req(available_end_sec: int, rest_policy: DrivingRestPolicy) -> FleetOptimizationRequest:
        veh = FleetVehicle(
            id="V1",
            plate_number="29H-20002",
            length_cm=600,
            width_cm=230,
            height_cm=200,
            payload_limit_kg=10_000,
            depot=wh_a,
            return_to_depot=False,
            available_start_sec=0,
            available_end_sec=available_end_sec,
            fuel_consumption_liters_per_100_km=22,
            fixed_operating_cost_vnd=1_000_000,
        )
        drv = DriverOption(
            id="D1",
            full_name="Tài xế Đường Dài",
            license_class="CE",
            fixed_salary_monthly_vnd=18_000_000,
            trip_base_pay_vnd=500_000,
            per_km_pay_vnd=3_000,
        )
        order = OrderPair(
            id="O1",
            order_number="LH-01",
            pickup_location=wh_a,
            delivery_location=wh_b,
            items=[_item("I1", "O1")],
            pickup_window_start_sec=0,
            pickup_window_end_sec=3600,
            delivery_window_start_sec=0,
            delivery_window_end_sec=100_000,
            pickup_service_time_sec=600,
            delivery_service_time_sec=600,
        )
        # 11h (39,600s) driving -> needs 2 short breaks (4h, 8h) + 1 daily 8h rest (at 10h)
        return FleetOptimizationRequest(
            job_id="test-daily-rest",
            vehicles=[veh],
            drivers=[drv],
            orders=[order],
            policy=_base_policy(rest_policy),
            demo_stacking=None,
            max_time_seconds=5,
            search_time_seconds=3,
            distance_matrix_meters=[[0.0, 0.0, 700_000.0], [0.0, 0.0, 700_000.0], [700_000.0, 700_000.0, 0.0]],
            duration_matrix_seconds=[[0.0, 0.0, 39_600.0], [0.0, 0.0, 39_600.0], [39_600.0, 39_600.0, 0.0]],
        )

    # Total needed: 600 + 39600 + 2*900 + 28800 + 600 = 71,400s.
    # Tight shift 60,000s (enough for raw 11h drive, NOT enough after mandatory daily rest) -> must reject!
    tight_res = ALNSFleetOptimizer(_build_req(60_000, DrivingRestPolicy())).solve()
    assert not tight_res.routes and len(tight_res.unassigned_orders) == 1

    # Weekly cap exceeded (10h weekly cap < 11h leg) -> must reject!
    weekly_policy = DrivingRestPolicy(max_weekly_driving_sec=36_000)
    weekly_res = PackingAwareHybridALNSOptimizer(_build_req(100_000, weekly_policy)).solve()
    assert not weekly_res.routes and len(weekly_res.unassigned_orders) == 1

    # Enough window -> feasible across Hybrid & BaselineCalculator
    ok_req = _build_req(80_000, DrivingRestPolicy())
    hybrid_res = PackingAwareHybridALNSOptimizer(ok_req).solve()
    assert hybrid_res.status == "SUCCESS"
    r = hybrid_res.routes[0]
    _assert_route_timeline_contract(r)
    assert r.mandatory_rest_sec == 28_800 + 2 * 900
    assert any(b.reason == "DAILY_LIMIT" for b in r.rest_breaks)

    base_calc = BaselineCostCalculator(ok_req, FleetRoutingSolver(ok_req).nodes)
    direct_routes = base_calc._solve_direct_schedule([(0, ok_req.vehicles[0], ok_req.drivers[0])], set(), 1500)
    assert direct_routes and len(direct_routes) == 1
    _assert_route_timeline_contract(direct_routes[0])
    assert direct_routes[0].mandatory_rest_sec == 28_800 + 2 * 900


def test_docking_coalescing_and_rest_credit_during_service() -> None:
    wh_hn = _wh("WH-HN", "Kho HN", 21.03, 105.85, "VN-HN", "Hà Nội", role="HUB", docking_sec=1200)
    wh_hp1 = _wh("WH-HP1", "Kho Hải Phòng 1", 20.85, 106.68, "VN-HP", "Hải Phòng", role="WAREHOUSE", docking_sec=1200)
    wh_dn = _wh("WH-DN", "Kho Đà Nẵng", 16.05, 108.20, "VN-DN", "Đà Nẵng", role="HUB", docking_sec=1200)

    veh = FleetVehicle(
        id="V1",
        plate_number="29H-30003",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=60_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    drv = DriverOption(
        id="D1",
        full_name="Tài xế Đa Kho",
        license_class="C",
        fixed_salary_monthly_vnd=15_000_000,
        trip_base_pay_vnd=400_000,
        per_km_pay_vnd=2_500,
    )
    # O1: WH-HN -> WH-HP1 (10,800s = 3h)
    # O2: WH-HP1 -> WH-DN (10,800s = 3h) -> back-to-back at WH-HP1!
    # Service at WH-HP1: O1 delivery (600 + 1200 docking = 1800s) then O2 pickup (600s, docking coalesced!).
    # Wait: 3h drive + (1800 + 600 = 2400s >= 900s rest credit) -> rest_allowance_during_service=True resets continuous counter!
    o1 = OrderPair(
        id="O1",
        order_number="WH-1",
        pickup_location=wh_hn,
        delivery_location=wh_hp1,
        items=[_item("I1", "O1")],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=30_000,
        pickup_service_time_sec=600,
        delivery_service_time_sec=600,
    )
    o2 = OrderPair(
        id="O2",
        order_number="WH-2",
        pickup_location=wh_hp1,
        delivery_location=wh_dn,
        items=[_item("I2", "O2")],
        pickup_window_start_sec=0,
        pickup_window_end_sec=30_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=55_000,
        pickup_service_time_sec=600,
        delivery_service_time_sec=600,
    )
    # Nodes: 0=V1(HN), 1=O1.P(HN), 2=O1.D(HP1), 3=O2.P(HP1), 4=O2.D(DN)
    dist_m = [
        [0, 0, 120_000, 120_000, 760_000],
        [0, 0, 120_000, 120_000, 760_000],
        [120_000, 120_000, 0, 0, 700_000],
        [120_000, 120_000, 0, 0, 700_000],
        [760_000, 760_000, 700_000, 700_000, 0],
    ]
    dur_s = [
        [0, 0, 10_800, 10_800, 45_000],
        [0, 0, 10_800, 10_800, 45_000],
        [10_800, 10_800, 0, 0, 10_800],
        [10_800, 10_800, 0, 0, 10_800],
        [45_000, 45_000, 10_800, 10_800, 0],
    ]

    req_credit = FleetOptimizationRequest(
        job_id="test-dock-coalesce",
        vehicles=[veh],
        drivers=[drv],
        orders=[o1, o2],
        policy=_base_policy(DrivingRestPolicy(rest_allowance_during_service=True)),
        demo_stacking=DemoStackingPolicy(max_tiers=3, lift_clearance_cm=5.0, owner_mode="ANY_CUSTOMER"),
        max_time_seconds=6,
        search_time_seconds=4,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
    )
    res_credit = ALNSFleetOptimizer(req_credit).solve()
    assert res_credit.status == "SUCCESS" and len(res_credit.routes) == 1
    r = res_credit.routes[0]
    _assert_route_timeline_contract(r)
    # Contiguous HP1 stops: first has 600 + 1200 = 1800, second has 600 (docking coalesced!)
    assert [s.location_id for s in r.stops] == ["WH-HN", "WH-HP1", "WH-HP1", "WH-DN"]
    assert [s.service_time_sec for s in r.stops] == [1800, 1800, 600, 1800]
    assert r.mandatory_rest_sec == 0

    # With rest_allowance_during_service=False, 3h + 3h cumulative triggers one 900s en-route break
    req_nocredit = req_credit.model_copy(
        update={
            "policy": _base_policy(DrivingRestPolicy(rest_allowance_during_service=False)),
        }
    )
    res_nocredit = ALNSFleetOptimizer(req_nocredit).solve()
    assert res_nocredit.status == "SUCCESS"
    assert res_nocredit.routes[0].mandatory_rest_sec == 900


@pytest.mark.parametrize(
    "solver_cls",
    [ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver],
)
def test_custom_cross_province_end_depot_extra_matrix_node(solver_cls) -> None:
    wh_hn = _wh("WH-HN", "Kho Hà Nội", 21.03, 105.85, "VN-HN", "Hà Nội", role="HUB")
    wh_na = _wh("WH-NA", "Kho Nghệ An", 18.68, 105.68, "VN-NA", "Nghệ An", role="WAREHOUSE")
    wh_dn_hub = _wh("WH-DN-END", "Kho Kết Thúc Đà Nẵng", 16.01, 108.18, "VN-DN", "Đà Nẵng", role="HUB", docking_sec=300)

    veh = FleetVehicle(
        id="V1",
        plate_number="29H-40004",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        end_depot=wh_dn_hub,
        return_to_depot=True,
        available_start_sec=0,
        available_end_sec=45_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    drv = DriverOption(
        id="D1",
        full_name="Tài xế Xuyên Tỉnh",
        license_class="C",
        fixed_salary_monthly_vnd=15_000_000,
        trip_base_pay_vnd=400_000,
        per_km_pay_vnd=2_500,
    )
    order = OrderPair(
        id="O1",
        order_number="END-01",
        pickup_location=wh_hn,
        delivery_location=wh_na,
        items=[_item("I1", "O1")],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=25_000,
        pickup_service_time_sec=600,
        delivery_service_time_sec=600,
    )
    # 4 nodes: 0=V1.depot(HN), 1=O1.P(HN), 2=O1.D(NA), 3=V1.end_depot(DN)
    dist_m = [
        [0, 0, 300_000, 760_000],
        [0, 0, 300_000, 760_000],
        [300_000, 300_000, 0, 460_000],
        [760_000, 760_000, 460_000, 0],
    ]
    dur_s = [
        [0, 0, 14_400, 36_000],
        [0, 0, 14_400, 36_000],
        [14_400, 14_400, 0, 19_000],
        [36_000, 36_000, 19_000, 0],
    ]
    req = FleetOptimizationRequest(
        job_id="test-custom-end-depot",
        vehicles=[veh],
        drivers=[drv],
        orders=[order],
        policy=_base_policy(DrivingRestPolicy()),
        demo_stacking=None,
        max_time_seconds=6,
        search_time_seconds=4,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
    )
    assert resolve_vehicle_end_node_index(req.vehicles, req.orders, 0, veh) == 3

    resp = solver_cls(req).solve()
    assert resp.status == "SUCCESS"
    r = resp.routes[0]
    _assert_route_timeline_contract(r)
    assert r.depot is not None and r.depot.id == "WH-HN"
    assert r.end_location is not None and r.end_location.id == "WH-DN-END"
    assert r.province_hops == ["VN-HN", "VN-NA", "VN-DN"]
    assert r.total_distance_km == pytest.approx(760.0, abs=0.5)
    # Return leg NA -> DN is 19,000s (>4h continuous after 600s stop? 600s < 900s rest credit? NA service=600 < 900s so continuous clock wasn't reset -> triggers 15m break on return leg!)
    assert r.return_travel_time_sec == 19_000
    assert r.return_waiting_time_sec >= 900


def test_driver_home_province_and_warehouse_scoping() -> None:
    wh_hn = _wh("WH-HN", "Kho Hà Nội", 21.03, 105.85, "VN-HN", "Hà Nội", role="HUB")
    wh_dn = _wh("WH-DN", "Kho Đà Nẵng", 16.05, 108.20, "VN-DN", "Đà Nẵng", role="HUB")
    wh_dn_2 = _wh("WH-DN-2", "Kho Đà Nẵng 2", 16.09, 108.15, "VN-DN", "Đà Nẵng", role="WAREHOUSE")

    veh_dn = FleetVehicle(
        id="V-DN",
        plate_number="43H-99999",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_dn,
        return_to_depot=True,
        available_start_sec=0,
        available_end_sec=30_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    drv_hn_strict = DriverOption(
        id="D-HN",
        full_name="Tài xế Hà Nội",
        license_class="CE",
        home_location_id="WH-HN",
        home_province_code="VN-HN",
        strict_home_location=True,
        fixed_salary_monthly_vnd=10_000_000,
        trip_base_pay_vnd=100_000,
        per_km_pay_vnd=1_000,
    )
    drv_dn_prov = DriverOption(
        id="D-DN-PROV",
        full_name="Tài xế Đà Nẵng (Cấp tỉnh)",
        license_class="C",
        home_location_id="WH-DN-2",
        home_province_code="VN-DN",
        strict_home_location=False,
        fixed_salary_monthly_vnd=16_000_000,
        trip_base_pay_vnd=300_000,
        per_km_pay_vnd=2_500,
    )
    assert is_driver_compatible_with_vehicle(drv_hn_strict, veh_dn) is False
    assert is_driver_compatible_with_vehicle(drv_dn_prov, veh_dn) is True

    # Strict home location at WH-DN-2 does NOT drive vehicle stationed at WH-DN even in same province
    drv_dn_strict_other = drv_dn_prov.model_copy(update={"strict_home_location": True})
    assert is_driver_compatible_with_vehicle(drv_dn_strict_other, veh_dn) is False

    order = OrderPair(
        id="O1",
        order_number="DN-01",
        pickup_location=wh_dn,
        delivery_location=wh_dn_2,
        items=[_item("I1", "O1")],
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
    )
    req = FleetOptimizationRequest(
        job_id="test-driver-scope",
        vehicles=[veh_dn],
        drivers=[drv_hn_strict, drv_dn_prov],
        orders=[order],
        policy=_base_policy(),
        demo_stacking=None,
        max_time_seconds=4,
        search_time_seconds=2,
        distance_matrix_meters=[[0, 0, 10_000], [0, 0, 10_000], [10_000, 10_000, 0]],
        duration_matrix_seconds=[[0, 0, 1_200], [0, 0, 1_200], [1_200, 1_200, 0]],
    )
    for solver_cls in (ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver):
        resp = solver_cls(req).solve()
        assert resp.status == "SUCCESS"
        assert resp.routes[0].driver_id == "D-DN-PROV"


def test_interprovincial_demo_catalog_and_execution() -> None:
    # Existing /demo/cases stays unchanged for backward compatibility
    assert [c.id for c in list_demo_cases()] == ["demo_3d_danang_complex"]

    inter_cases = list_interprovincial_demo_cases()
    assert [c.id for c in inter_cases] == [
        "interprovincial_north_central_multi_wh",
        "interprovincial_south_corridor_hubs",
    ]

    for summary in inter_cases:
        batch = run_demo_case(DemoRunRequest(case_id=summary.id, time_budget_seconds=6.0))
        assert batch.candidates
        top = batch.candidates[0].result
        assert top.status == "SUCCESS" and not top.unassigned_orders
        all_hops = set()
        for route in top.routes:
            _assert_route_timeline_contract(route)
            assert route.spatial_validation.is_valid
            assert route.province_hops
            all_hops.update(route.province_hops)
        assert len(all_hops) >= 3
        if summary.id == "interprovincial_north_central_multi_wh":
            assert sum(r.mandatory_rest_sec for r in top.routes) > 0


@pytest.mark.parametrize(
    "solver_cls",
    [ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver],
)
def test_cold_chain_and_incompatible_cargo_groups(solver_cls) -> None:
    wh_hn = _wh("WH-HN", "Kho Hà Nội", 21.03, 105.85, "VN-HN", "Hà Nội", role="HUB")
    wh_dn = _wh("WH-DN", "Kho Đà Nẵng", 16.05, 108.20, "VN-DN", "Đà Nẵng", role="HUB")

    veh_dry = FleetVehicle(
        id="V-DRY",
        plate_number="29H-DRY01",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        temperature_mode="DRY",
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=60_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=800_000,
    )
    veh_cold = FleetVehicle(
        id="V-FROZEN",
        plate_number="29H-FRZ01",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        temperature_mode="FROZEN",
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=60_000,
        fuel_consumption_liters_per_100_km=24,
        fixed_operating_cost_vnd=1_400_000,
    )
    drivers = [
        DriverOption(
            id="D1",
            full_name="Tài xế 1",
            license_class="C",
            fixed_salary_monthly_vnd=15_000_000,
            trip_base_pay_vnd=300_000,
            per_km_pay_vnd=2_000,
        ),
        DriverOption(
            id="D2",
            full_name="Tài xế 2",
            license_class="C",
            fixed_salary_monthly_vnd=15_000_000,
            trip_base_pay_vnd=300_000,
            per_km_pay_vnd=2_000,
        ),
    ]
    cold_order = OrderPair(
        id="O-COLD",
        order_number="COLD-01",
        pickup_location=wh_hn,
        delivery_location=wh_dn,
        items=[
            CargoItem(
                id="I-COLD",
                order_id="O-COLD",
                length_cm=120,
                width_cm=100,
                height_cm=90,
                weight_kg=600.0,
                required_temperature="FROZEN",
                cargo_group="FROZEN_FOOD",
                incompatible_cargo_groups=["CHEMICAL"],
            )
        ],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=50_000,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
    )
    chem_order = OrderPair(
        id="O-CHEM",
        order_number="CHEM-01",
        pickup_location=wh_hn,
        delivery_location=wh_dn,
        items=[
            CargoItem(
                id="I-CHEM",
                order_id="O-CHEM",
                length_cm=120,
                width_cm=100,
                height_cm=90,
                weight_kg=600.0,
                required_temperature="DRY",
                cargo_group="CHEMICAL",
                incompatible_cargo_groups=["FROZEN_FOOD"],
            )
        ],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=50_000,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
    )
    # 0=V-DRY(HN), 1=V-FROZEN(HN), 2=O-COLD.P, 3=O-COLD.D, 4=O-CHEM.P, 5=O-CHEM.D
    dist_m = [
        [0 if i in (0, 1, 2, 4) and j in (0, 1, 2, 4) else (0 if i in (3, 5) and j in (3, 5) else 200_000) for j in range(6)]
        for i in range(6)
    ]
    dur_s = [
        [0 if i in (0, 1, 2, 4) and j in (0, 1, 2, 4) else (0 if i in (3, 5) and j in (3, 5) else 10_000) for j in range(6)]
        for i in range(6)
    ]
    req = FleetOptimizationRequest(
        job_id="test-cold-incompat",
        vehicles=[veh_dry, veh_cold],
        drivers=drivers,
        orders=[cold_order, chem_order],
        policy=_base_policy(),
        demo_stacking=None,
        max_time_seconds=6,
        search_time_seconds=4,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
    )

    resp = solver_cls(req).solve()
    assert resp.status == "SUCCESS"
    route_by_order = {}
    for r in resp.routes:
        assert not route_stops_have_cargo_conflict(r.stops, {o.id: o for o in req.orders})
        for s in r.stops:
            if s.stop_type == "PICKUP":
                route_by_order[s.allocation_id or s.order_id] = r.vehicle_id
    # O-COLD must only be assigned to V-FROZEN
    assert route_by_order["O-COLD"] == "V-FROZEN"
    # O-CHEM cannot co-load on V-FROZEN at the same time (P_end=10k, drive=10k -> sequential trip can't return or reload on open V-FROZEN without driving back empty), so separated cleanly onto V-DRY
    assert route_by_order["O-CHEM"] == "V-DRY"


def test_consecutive_unloaded_groups_allowed_but_coload_rejected() -> None:
    wh_hn = _wh("WH-HN", "Kho HN", 21.03, 105.85, "VN-HN", "Hà Nội")
    wh_dn = _wh("WH-DN", "Kho ĐN", 16.05, 108.20, "VN-DN", "Đà Nẵng")
    o_food = OrderPair(
        id="O1",
        order_number="FOOD-1",
        pickup_location=wh_hn,
        delivery_location=wh_dn,
        items=[
            CargoItem(
                id="I1",
                order_id="O1",
                length_cm=100,
                width_cm=100,
                height_cm=80,
                weight_kg=500,
                cargo_group="FOOD",
                incompatible_cargo_groups=["CHEMICAL"],
            )
        ],
    )
    o_chem = OrderPair(
        id="O2",
        order_number="CHEM-1",
        pickup_location=wh_dn,
        delivery_location=wh_hn,
        items=[
            CargoItem(
                id="I2",
                order_id="O2",
                length_cm=100,
                width_cm=100,
                height_cm=80,
                weight_kg=500,
                cargo_group="CHEMICAL",
                incompatible_cargo_groups=["FOOD"],
            )
        ],
    )
    order_map = {"O1": o_food, "O2": o_chem}
    # Sequential: pick O1 -> deliver O1 -> pick O2 -> deliver O2 (backhaul after unload) -> valid!
    seq_ok = [
        ScheduledStop(sequence=1, location_id="WH-HN", location_name="Kho HN", latitude=21.03, longitude=105.85, stop_type="PICKUP", order_id="O1", arrival_time_sec=0, departure_time_sec=300),
        ScheduledStop(sequence=2, location_id="WH-DN", location_name="Kho ĐN", latitude=16.05, longitude=108.20, stop_type="DELIVERY", order_id="O1", arrival_time_sec=1000, departure_time_sec=1300),
        ScheduledStop(sequence=3, location_id="WH-DN", location_name="Kho ĐN", latitude=16.05, longitude=108.20, stop_type="PICKUP", order_id="O2", arrival_time_sec=1300, departure_time_sec=1600),
        ScheduledStop(sequence=4, location_id="WH-HN", location_name="Kho HN", latitude=21.03, longitude=105.85, stop_type="DELIVERY", order_id="O2", arrival_time_sec=2600, departure_time_sec=2900),
    ]
    assert route_stops_have_cargo_conflict(seq_ok, order_map) is False

    # Co-loaded: pick O1 -> pick O2 -> deliver O1 -> deliver O2 -> rejected!
    coload_bad = [seq_ok[0], seq_ok[2], seq_ok[1], seq_ok[3]]
    assert route_stops_have_cargo_conflict(coload_bad, order_map) is True


@pytest.mark.parametrize(
    "solver_cls",
    [ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver],
)
def test_warehouse_access_limits_and_lift_equipment(solver_cls) -> None:
    wh_tight = LocationPoint(
        id="WH-TIGHT",
        source_location_id="WH-TIGHT",
        name="Kho Ngõ Hẹp (tối đa 5T / 550cm, không xe nâng)",
        latitude=21.03,
        longitude=105.85,
        province_code="VN-HN",
        max_vehicle_payload_kg=5_000.0,
        max_vehicle_length_cm=550.0,
        has_forklift=False,
    )
    wh_dest = LocationPoint(
        id="WH-DEST",
        source_location_id="WH-DEST",
        name="Kho Đích (có xe nâng)",
        latitude=20.85,
        longitude=106.68,
        province_code="VN-HP",
        has_forklift=True,
    )
    # V-BIG violates max_vehicle_payload_kg/length_cm and lacks tail-lift
    veh_big = FleetVehicle(
        id="V-BIG",
        plate_number="29H-BIG",
        length_cm=650,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_tight,
        has_tail_lift=False,
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=40_000,
        fuel_consumption_liters_per_100_km=25,
        fixed_operating_cost_vnd=500_000,  # Cheaper so solver would prefer it if allowed!
    )
    # V-SMALL-NOLIFT fits size/payload, but fails requires_lift_equipment since WH-TIGHT has_forklift=False
    veh_small_nolift = FleetVehicle(
        id="V-NOLIFT",
        plate_number="29H-NLF",
        length_cm=500,
        width_cm=210,
        height_cm=190,
        payload_limit_kg=4_500,
        depot=wh_tight,
        has_tail_lift=False,
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=40_000,
        fuel_consumption_liters_per_100_km=15,
        fixed_operating_cost_vnd=600_000,
    )
    # V-SMALL-LIFT satisfies both warehouse limits and lift gear
    veh_small_lift = FleetVehicle(
        id="V-LIFT",
        plate_number="29H-LFT",
        length_cm=500,
        width_cm=210,
        height_cm=190,
        payload_limit_kg=4_500,
        depot=wh_tight,
        has_tail_lift=True,
        return_to_depot=False,
        available_start_sec=0,
        available_end_sec=40_000,
        fuel_consumption_liters_per_100_km=16,
        fixed_operating_cost_vnd=900_000,
    )
    order = OrderPair(
        id="O1",
        order_number="LIFT-01",
        pickup_location=wh_tight,
        delivery_location=wh_dest,
        items=[
            CargoItem(
                id="I1",
                order_id="O1",
                length_cm=120,
                width_cm=100,
                height_cm=90,
                weight_kg=900.0,
                requires_lift_equipment=True,
            )
        ],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=30_000,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
    )
    assert is_order_compatible_with_vehicle_and_warehouses(order, veh_big) is False
    assert is_order_compatible_with_vehicle_and_warehouses(order, veh_small_nolift) is False
    assert is_order_compatible_with_vehicle_and_warehouses(order, veh_small_lift) is True

    drivers = [
        DriverOption(
            id=f"D{i}",
            full_name=f"Driver {i}",
            license_class="C",
            fixed_salary_monthly_vnd=12_000_000,
            trip_base_pay_vnd=300_000,
            per_km_pay_vnd=2_000,
        )
        for i in range(3)
    ]
    # Matrix indices: 0,1,2=depots(TIGHT), 3=O1.P(TIGHT), 4=O1.D(DEST)
    dist_m = [
        [100_000.0 if (i == 4) != (j == 4) else 0.0 for j in range(5)]
        for i in range(5)
    ]
    dur_s = [
        [7_200.0 if (i == 4) != (j == 4) else 0.0 for j in range(5)]
        for i in range(5)
    ]
    req = FleetOptimizationRequest(
        job_id="test-wh-limits-lift",
        vehicles=[veh_big, veh_small_nolift, veh_small_lift],
        drivers=drivers,
        orders=[order],
        policy=_base_policy(),
        demo_stacking=None,
        max_time_seconds=6,
        search_time_seconds=4,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
    )
    resp = solver_cls(req).solve()
    assert resp.status == "SUCCESS" and len(resp.routes) == 1
    assert resp.routes[0].vehicle_id == "V-LIFT"


@pytest.mark.parametrize(
    "solver_cls",
    [ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver],
)
def test_warehouse_operating_windows_and_dynamic_handling_time(solver_cls) -> None:
    # Pickup warehouse open 08:00-12:00 daily, docking 300s, dynamic handling: 100s/ton + 50s/pkg
    wh_open = LocationPoint(
        id="WH-OPEN",
        source_location_id="WH-OPEN",
        name="Kho Ca Sáng",
        latitude=21.03,
        longitude=105.85,
        province_code="VN-HN",
        docking_time_sec=300,
        operating_windows=[WarehouseOperatingWindow(start_sec=28_800, end_sec=43_200)],
        handling_sec_per_ton=100,
        handling_sec_per_package=50,
    )
    # Delivery warehouse only open 13:00-17:00
    wh_pm = LocationPoint(
        id="WH-PM",
        source_location_id="WH-PM",
        name="Kho Ca Chiều",
        latitude=20.85,
        longitude=106.68,
        province_code="VN-HP",
        operating_windows=[WarehouseOperatingWindow(start_sec=46_800, end_sec=61_200)],
    )
    veh = FleetVehicle(
        id="V1",
        plate_number="29H-WIN01",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_open,
        return_to_depot=False,
        available_start_sec=25_200,  # 07:00
        available_end_sec=65_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    drv = DriverOption(
        id="D1",
        full_name="Tài xế Ca Kho",
        license_class="C",
        fixed_salary_monthly_vnd=12_000_000,
        trip_base_pay_vnd=300_000,
        per_km_pay_vnd=2_000,
    )
    # 2 items totaling 2.0 tons -> dynamic handling = 100 * 2.0 + 50 * 2 = 300s
    # Plus base 600s + docking 300s = 1200s total service time at pickup!
    order = OrderPair(
        id="O1",
        order_number="WIN-01",
        pickup_location=wh_open,
        delivery_location=wh_pm,
        items=[
            _item("I1", "O1", kg=1_000.0),
            _item("I2", "O1", l=100, w=100, h=80, kg=1_000.0),
        ],
        pickup_window_start_sec=25_200,
        pickup_window_end_sec=40_000,
        delivery_window_start_sec=25_200,
        delivery_window_end_sec=60_000,
        pickup_service_time_sec=600,
        delivery_service_time_sec=600,
    )
    # 1 hour drive (3,600s) -> arrives at delivery around 09:20 -> must wait until 13:00 (46,800)
    dist_m = [[0, 0, 60_000], [0, 0, 60_000], [60_000, 60_000, 0]]
    dur_s = [[0, 0, 3_600], [0, 0, 3_600], [3_600, 3_600, 0]]
    req = FleetOptimizationRequest(
        job_id="test-wh-hours-handling",
        vehicles=[veh],
        drivers=[drv],
        orders=[order],
        policy=_base_policy(),
        demo_stacking=DemoStackingPolicy(max_tiers=3, lift_clearance_cm=5.0, owner_mode="ANY_CUSTOMER"),
        max_time_seconds=6,
        search_time_seconds=4,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
    )
    resp = solver_cls(req).solve()
    assert resp.status == "SUCCESS" and len(resp.routes) == 1
    r = resp.routes[0]
    _assert_route_timeline_contract(r)
    assert r.stops[0].arrival_time_sec >= 28_800
    assert r.stops[0].service_time_sec == 1200
    assert r.stops[1].arrival_time_sec >= 46_800
    assert r.stops[1].waiting_time_sec > 0


@pytest.mark.parametrize(
    "solver_cls",
    [ALNSFleetOptimizer, PackingAwareHybridALNSOptimizer, FleetRoutingSolver],
)
def test_toll_matrix_and_overnight_allowance_costing(solver_cls) -> None:
    wh_hn = _wh("WH-HN", "Kho Hà Nội", 21.03, 105.85, "VN-HN", "Hà Nội", role="HUB")
    wh_dn = _wh("WH-DN", "Kho Đà Nẵng", 16.05, 108.20, "VN-DN", "Đà Nẵng", role="HUB")

    veh = FleetVehicle(
        id="V1",
        plate_number="29H-TOLL",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        return_to_depot=False,
        toll_factor=1.5,
        available_start_sec=0,
        available_end_sec=90_000,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    drv = DriverOption(
        id="D1",
        full_name="Tài xế Cao Tốc",
        license_class="CE",
        fixed_salary_monthly_vnd=18_000_000,
        trip_base_pay_vnd=500_000,
        per_km_pay_vnd=3_000,
    )
    order = OrderPair(
        id="O1",
        order_number="TOLL-01",
        pickup_location=wh_hn,
        delivery_location=wh_dn,
        items=[_item("I1", "O1")],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=85_000,
        pickup_service_time_sec=300,
        delivery_service_time_sec=300,
    )
    # 11h driving (39,600s) triggers 1 DAILY_LIMIT break + toll fee 400,000 * 1.5 = 600,000 VND
    dist_m = [[0, 0, 700_000], [0, 0, 700_000], [700_000, 700_000, 0]]
    dur_s = [[0, 0, 39_600], [0, 0, 39_600], [39_600, 39_600, 0]]
    toll_m = [[0, 0, 400_000], [0, 0, 400_000], [400_000, 400_000, 0]]
    rest_pol = DrivingRestPolicy(overnight_allowance_vnd=350_000)

    req = FleetOptimizationRequest(
        job_id="test-toll-overnight",
        vehicles=[veh],
        drivers=[drv],
        orders=[order],
        policy=_base_policy(rest_pol),
        demo_stacking=None,
        max_time_seconds=6,
        search_time_seconds=4,
        distance_matrix_meters=dist_m,
        duration_matrix_seconds=dur_s,
        toll_matrix_vnd=toll_m,
    )
    resp = solver_cls(req).solve()
    assert resp.status == "SUCCESS" and len(resp.routes) == 1
    r = resp.routes[0]
    assert r.cost is not None
    assert r.cost.toll_cost_vnd == 600_000
    assert r.cost.overnight_allowance_vnd == 350_000
    expected_total = (
        r.cost.fuel_cost_vnd
        + r.cost.vehicle_fixed_cost_vnd
        + r.cost.driver_fixed_salary_allocation_vnd
        + r.cost.driver_trip_pay_vnd
        + r.cost.cargo_holding_cost_vnd
        + r.cost.late_delivery_penalty_vnd
        + r.cost.toll_cost_vnd
        + r.cost.overnight_allowance_vnd
    )
    assert r.cost.total_cost_vnd == expected_total

    # Direct BaselineCostCalculator must report matching toll & overnight allowance
    base_calc = BaselineCostCalculator(req, FleetRoutingSolver(req).nodes)
    direct_routes = base_calc._solve_direct_schedule([(0, req.vehicles[0], req.drivers[0])], set(), 1500)
    assert direct_routes and len(direct_routes) == 1
    assert direct_routes[0].cost.toll_cost_vnd == 600_000
    assert direct_routes[0].cost.overnight_allowance_vnd == 350_000


def test_cross_day_vehicle_and_driver_overlap_and_min_inter_trip_rest() -> None:
    wh_hn = _wh("WH-HN", "Kho HN", 21.03, 105.85, "VN-HN", "Hà Nội")
    wh_dn = _wh("WH-DN", "Kho ĐN", 16.05, 108.20, "VN-DN", "Đà Nẵng")

    v_day0 = FleetVehicle(
        id="V-D0",
        source_vehicle_id="V-PHYS",
        service_day_index=0,
        plate_number="29H-XDAY",
        length_cm=600,
        width_cm=230,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=wh_hn,
        available_start_sec=0,
        available_end_sec=2 * 86_400,
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    v_day1 = v_day0.model_copy(
        update={
            "id": "V-D1",
            "service_day_index": 1,
            "available_start_sec": 86_400,
            "available_end_sec": 2 * 86_400,
        }
    )
    v_other_day1 = v_day1.model_copy(
        update={"id": "V2-D1", "source_vehicle_id": "V-OTHER", "plate_number": "29H-OTH1"}
    )
    d_day0 = DriverOption(
        id="D-D0",
        source_driver_id="D-PHYS",
        service_day_index=0,
        full_name="Tài xế Xuyên Ngày",
        license_class="CE",
        fixed_salary_monthly_vnd=18_000_000,
        trip_base_pay_vnd=400_000,
        per_km_pay_vnd=2_500,
    )
    d_day1 = d_day0.model_copy(update={"id": "D-D1", "service_day_index": 1})
    o_dummy = OrderPair(
        id="O1",
        order_number="XD-01",
        pickup_location=wh_hn,
        delivery_location=wh_dn,
        items=[_item("I1", "O1")],
    )
    veh_map = {"V-D0": v_day0, "V-D1": v_day1, "V2-D1": v_other_day1}

    from app.models import SpatialValidationResult

    # 1) Same physical vehicle overlapping across day 0 -> day 1 (end=100,000 vs start=90,000)
    r0 = OptimizedRoute(
        route_id="V-D0",
        vehicle_id="V-PHYS",
        plate_number="29H-XDAY",
        vehicle_length_cm=600,
        vehicle_width_cm=230,
        vehicle_height_cm=200,
        service_day_index=0,
        start_time_sec=21_600,
        end_time_sec=100_000,
        total_distance_km=500.0,
        total_duration_minutes=1306.7,
        stops=[],
        spatial_validation=SpatialValidationResult(is_valid=True),
        cost=RouteCostBreakdown(
            base_fuel_cost_vnd=100_000,
            load_fuel_surcharge_vnd=0,
            fuel_cost_vnd=100_000,
            cargo_holding_cost_vnd=0,
            late_delivery_penalty_vnd=0,
            cargo_distance_ton_km=0.0,
            cargo_time_ton_hours=0.0,
            vehicle_fixed_cost_vnd=1_000_000,
            driver_fixed_salary_allocation_vnd=0,
            driver_trip_pay_vnd=0,
            total_cost_vnd=1_100_000,
        ),
    )
    r1_same_veh = r0.model_copy(
        update={"route_id": "V-D1", "service_day_index": 1, "start_time_sec": 90_000, "end_time_sec": 120_000}
    )
    assert check_cross_day_resource_conflicts([r0, r1_same_veh], veh_map) is True

    # 2) Separate physical vehicles, same physical driver with gap 10,000s < min_inter_trip_rest_sec=28,800s
    r1_other_veh = r0.model_copy(
        update={
            "route_id": "V2-D1",
            "vehicle_id": "V-OTHER",
            "plate_number": "29H-OTH1",
            "service_day_index": 1,
            "start_time_sec": 110_000,
            "end_time_sec": 140_000,
        }
    )
    req = FleetOptimizationRequest(
        job_id="test-min-inter-trip-rest",
        vehicles=[v_day0, v_other_day1],
        drivers=[d_day0, d_day1],
        orders=[o_dummy],
        policy=_base_policy(DrivingRestPolicy(min_inter_trip_rest_sec=28_800)),
        distance_matrix_meters=[[0, 0, 1000, 1000], [0, 0, 1000, 1000], [1000, 1000, 0, 500], [1000, 1000, 500, 0]],
        duration_matrix_seconds=[[0, 0, 600, 600], [0, 0, 600, 600], [600, 600, 0, 300], [600, 600, 300, 0]],
    )
    with pytest.raises(ValueError):
        DriverMatcher(req).assign_drivers_to_routes([r0, r1_other_veh])

    # Sufficient rest gap (128,800 >= 100,000 + 28,800) succeeds
    r1_rested = r1_other_veh.model_copy(update={"start_time_sec": 128_800, "end_time_sec": 150_000})
    assigned = DriverMatcher(req).assign_drivers_to_routes([r0, r1_rested])
    assert len(assigned) == 2
    assert check_cross_day_resource_conflicts(assigned, veh_map, min_inter_trip_rest_sec=28_800) is False

    # Unrested same-driver routes rejected by check_cross_day_resource_conflicts & is_fully_served
    r0_d = r0.model_copy(update={"driver_id": "D-PHYS"})
    r1_d = r1_other_veh.model_copy(update={"driver_id": "D-PHYS"})
    assert check_cross_day_resource_conflicts([r0_d, r1_d], veh_map, min_inter_trip_rest_sec=28_800) is True


def test_order_splitting_preserves_warehouse_metadata_and_toll_matrix() -> None:
    wh_pick = LocationPoint(
        id="WH-PICK",
        source_location_id="WH-PICK",
        name="Kho Lấy Hạn Chế Xe Nâng",
        latitude=21.03,
        longitude=105.85,
        province_code="VN-HN",
        docking_time_sec=450,
        max_vehicle_payload_kg=6_000.0,
        has_forklift=False,
        operating_windows=[WarehouseOperatingWindow(start_sec=28_800, end_sec=61_200)],
        handling_sec_per_ton=90,
        handling_sec_per_package=30,
    )
    wh_deliv = _wh("WH-DEL", "Kho Đích", 20.85, 106.68, "VN-HP", "Hải Phòng", docking_sec=300)

    v1 = FleetVehicle(
        id="V1",
        plate_number="29H-S1",
        length_cm=500,
        width_cm=220,
        height_cm=200,
        payload_limit_kg=4_000,
        depot=wh_pick,
        has_tail_lift=True,
        fuel_consumption_liters_per_100_km=18,
        fixed_operating_cost_vnd=800_000,
    )
    v2 = v1.model_copy(update={"id": "V2", "plate_number": "29H-S2"})
    # Order needs 2 trucks because weight = 3000 + 3000 = 6000 > 4000kg
    big_order = OrderPair(
        id="O-BIG",
        order_number="SPLIT-01",
        pickup_location=wh_pick,
        delivery_location=wh_deliv,
        items=[
            CargoItem(
                id="IT-1",
                order_id="O-BIG",
                length_cm=150,
                width_cm=120,
                height_cm=100,
                weight_kg=3_000.0,
                requires_lift_equipment=True,
                cargo_group="MACHINERY",
            ),
            CargoItem(
                id="IT-2",
                order_id="O-BIG",
                length_cm=150,
                width_cm=120,
                height_cm=100,
                weight_kg=3_000.0,
                requires_lift_equipment=True,
                cargo_group="MACHINERY",
            ),
        ],
    )
    req = FleetOptimizationRequest(
        job_id="test-split-metadata",
        vehicles=[v1, v2],
        drivers=[
            DriverOption(id="D1", full_name="D1", fixed_salary_monthly_vnd=10_000_000, trip_base_pay_vnd=100_000, per_km_pay_vnd=1_000),
            DriverOption(id="D2", full_name="D2", fixed_salary_monthly_vnd=10_000_000, trip_base_pay_vnd=100_000, per_km_pay_vnd=1_000),
        ],
        orders=[big_order],
        policy=_base_policy(),
        distance_matrix_meters=[[0, 0, 0, 50_000], [0, 0, 0, 50_000], [0, 0, 0, 50_000], [50_000, 50_000, 50_000, 0]],
        duration_matrix_seconds=[[0, 0, 0, 3_600], [0, 0, 0, 3_600], [0, 0, 0, 3_600], [3_600, 3_600, 3_600, 0]],
        toll_matrix_vnd=[[0, 0, 0, 120_000], [0, 0, 0, 120_000], [0, 0, 0, 120_000], [120_000, 120_000, 120_000, 0]],
    )

    import time
    outcome = split_orders_within_deadline(req, deadline=time.perf_counter() + 2.0)
    assert outcome.split_order_count == 1
    split_req = outcome.request
    assert len(split_req.orders) == 2
    assert split_req.toll_matrix_vnd is not None
    expected_dim = len(split_req.vehicles) + 2 * len(split_req.orders)
    assert len(split_req.toll_matrix_vnd) == expected_dim
    assert all(len(row) == expected_dim for row in split_req.toll_matrix_vnd)
    for part in split_req.orders:
        assert part.pickup_location.max_vehicle_payload_kg == 6_000.0
        assert part.pickup_location.has_forklift is False
        assert part.pickup_location.handling_sec_per_ton == 90
        assert len(part.pickup_location.operating_windows) == 1
        assert part.items[0].requires_lift_equipment is True
        assert part.items[0].cargo_group == "MACHINERY"


def test_3d_weight_balance_enforcement() -> None:
    veh = FleetVehicle(
        id="V-BAL",
        plate_number="29H-BAL01",
        length_cm=600,
        width_cm=240,
        height_cm=220,
        payload_limit_kg=10_000,
        depot=_wh("WH-1", "Kho 1", 21.03, 105.85, "VN-HN", "Hà Nội"),
        fuel_consumption_liters_per_100_km=20,
        fixed_operating_cost_vnd=1_000_000,
    )
    heavy_corner_item = CargoItem(
        id="IT-CORNER",
        order_id="O-BAL",
        length_cm=100,
        width_cm=80,
        height_cm=100,
        weight_kg=2_000.0,
        can_rotate=False,
        cargo_kind="STANDARD",
    )
    actions = [
        StopAction(stop_id="WH-1", sequence=1, stop_type="PICKUP", items_to_load=[heavy_corner_item]),
        StopAction(stop_id="WH-2", sequence=2, stop_type="DELIVERY", items_to_unload=["IT-CORNER"]),
    ]

    # Default policy keeps enforce_weight_balance=False -> backward compatible pass
    default_pol = DemoStackingPolicy(max_tiers=3, lift_clearance_cm=5.0, owner_mode="ANY_CUSTOMER")
    res_default = validate_stop_actions(default_pol, veh, actions)
    assert res_default.is_valid is True

    # Strict weight balance policy detects off-center load at (x=0, y=0) inside 600x240 bed
    strict_pol = DemoStackingPolicy(
        max_tiers=3,
        lift_clearance_cm=5.0,
        owner_mode="ANY_CUSTOMER",
        enforce_weight_balance=True,
        max_lateral_imbalance_percent=10.0,
        max_longitudinal_imbalance_percent=10.0,
    )
    res_strict = validate_stop_actions(strict_pol, veh, actions)
    assert res_strict.is_valid is False
    assert res_strict.violation_code == "WEIGHT_BALANCE_EXCEEDED"


def test_virtual_pruning_preserves_bipartite_driver_coverage() -> None:
    wh_hn = _wh("WH-HN", "Kho HN", 21.03, 105.85, "VN-HN", "Hà Nội")
    wh_dn = _wh("WH-DN", "Kho ĐN", 16.05, 108.20, "VN-DN", "Đà Nẵng")
    v_small = FleetVehicle(
        id="V-SMALL",
        plate_number="29H-S01",
        length_cm=450,
        width_cm=200,
        height_cm=180,
        payload_limit_kg=3_000,
        depot=wh_hn,
        available_start_sec=0,
        available_end_sec=40_000,
        fuel_consumption_liters_per_100_km=14,
        fixed_operating_cost_vnd=500_000,
    )
    v_cont = FleetVehicle(
        id="V-CONT",
        source_vehicle_id="V-CONT",
        vehicle_type="CONTAINER_TRUCK",
        plate_number="29H-C01",
        length_cm=700,
        width_cm=235,
        height_cm=220,
        payload_limit_kg=15_000,
        depot=wh_dn,
        available_start_sec=0,
        available_end_sec=40_000,
        fuel_consumption_liters_per_100_km=25,
        fixed_operating_cost_vnd=1_500_000,
    )
    v_unusable = v_small.model_copy(update={"id": "V-EXP", "available_start_sec": 35_000, "available_end_sec": 36_000})
    d_b2 = DriverOption(
        id="D-B2",
        license_class="B2",
        full_name="Tài xế B2",
        home_location_id="WH-HN",
        home_province_code="VN-HN",
        fixed_salary_monthly_vnd=10_000_000,
        trip_base_pay_vnd=100_000,
        per_km_pay_vnd=1_000,
    )
    d_ce_hn_only = DriverOption(
        id="D-CE-HN",
        license_class="CE",
        full_name="Tài xế CE HN",
        home_location_id="WH-HN",
        home_province_code="VN-HN",
        strict_home_location=True,
        fixed_salary_monthly_vnd=20_000_000,
        trip_base_pay_vnd=500_000,
        per_km_pay_vnd=2_500,
    )
    order = OrderPair(
        id="O1",
        order_number="PRUNE-01",
        pickup_location=wh_hn,
        delivery_location=wh_dn,
        items=[_item("I1", "O1")],
        pickup_window_start_sec=0,
        pickup_window_end_sec=10_000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=30_000,
        pickup_service_time_sec=600,
        delivery_service_time_sec=600,
    )
    # Retained set would be [V-SMALL, V-CONT], where neither D-B2 nor strict HN D-CE-HN can drive V-CONT stationed at WH-DN.
    # Bipartite coverage fails on [V-SMALL, V-CONT] -> safe fallback avoids slicing off drivers blindly.
    req = FleetOptimizationRequest(
        job_id="test-prune-bipartite",
        vehicles=[v_small, v_cont, v_unusable],
        drivers=[d_b2, d_ce_hn_only],
        orders=[order],
        policy=_base_policy(),
        distance_matrix_meters=[[0.0] * 5 for _ in range(5)],
        duration_matrix_seconds=[[0.0] * 5 for _ in range(5)],
    )
    pruned_req, removed = prune_unserviceable_virtual_resources(req)
    assert removed == 0 and len(pruned_req.vehicles) == 3

    # Once a DN container driver exists, pruning removes V-EXP cleanly
    d_ce_dn = d_ce_hn_only.model_copy(update={"id": "D-CE-DN", "home_location_id": "WH-DN", "home_province_code": "VN-DN"})
    req_ok = req.model_copy(update={"drivers": [d_b2, d_ce_hn_only, d_ce_dn]})
    pruned_ok, removed_ok = prune_unserviceable_virtual_resources(req_ok)
    assert removed_ok == 1 and [v.id for v in pruned_ok.vehicles] == ["V-SMALL", "V-CONT"]
