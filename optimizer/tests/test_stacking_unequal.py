"""Unequal-footprint multi-child 3D tree stacking tests across API & stacking module."""

from time import monotonic
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import stacking_unequal
from app.main import app
from app.models import (
    CargoItem,
    CostPolicy,
    DemoStackingPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    StopAction,
    VehicleFloor,
)
from app.stacking import fast_validate_stacked_route, validate_stop_actions
from app.spatial_validator import SpatialValidator

client = TestClient(app)


def _item(
    item_id: str,
    *,
    order_id: str = "ord-1",
    customer_id: str = "cust-1",
    l: float = 100,
    w: float = 100,
    h: float = 30,
    kg: float = 100,
    allow_upper: bool = True,
    max_top_load_g: int | None = 30000,
    no_top: bool = False,
    can_rotate: bool = True,
    allowed_orientations: list[str] | None = None,
) -> CargoItem:
    return CargoItem(
        id=item_id,
        order_id=order_id,
        customer_id=customer_id,
        length_cm=l,
        width_cm=w,
        height_cm=h,
        weight_kg=kg,
        cargo_kind="STANDARD",
        allow_upper_tier=allow_upper,
        no_top_load_requested=no_top,
        max_top_load_g=max_top_load_g,
        can_rotate=can_rotate,
        allowed_orientations=allowed_orientations,
    )


def _policy(
    owner_mode: str = "SAME_CUSTOMER",
    max_tiers: int = 3,
    clearance_cm: float = 5.0,
) -> DemoStackingPolicy:
    return DemoStackingPolicy(
        owner_mode=owner_mode,
        max_tiers=max_tiers,
        lift_clearance_cm=clearance_cm,
    )


def test_unequal_packing_stops_inside_floor_candidate_generation(monkeypatch):
    vehicle = VehicleFloor(
        id="v1", plate_number="TEST", length_cm=200, width_cm=150,
        height_cm=120, payload_limit_kg=500,
    )
    validator = SpatialValidator(vehicle)
    stops = [
        StopAction(stop_id="load", sequence=1, stop_type="PICKUP", items_to_load=[_item("box")]),
        StopAction(stop_id="unload", sequence=2, stop_type="DELIVERY", items_to_unload=["box"]),
    ]
    now = monotonic()
    coordinates_examined = 0
    normalize = validator._normalize_coordinate

    def expire_during_generation(value):
        nonlocal now, coordinates_examined
        coordinates_examined += 1
        now += 2.0
        return normalize(value)

    monkeypatch.setattr(stacking_unequal, "time", SimpleNamespace(monotonic=lambda: now))
    monkeypatch.setattr(validator, "_normalize_coordinate", expire_during_generation)
    result = stacking_unequal.validate_unequal_stacked_stops(
        _policy(), vehicle, stops, validator, max_time_seconds=1.0,
    )
    assert coordinates_examined == 1
    assert not result.is_valid
    assert result.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED"


def test_validate_spatial_places_small_box_on_larger_base():
    payload = {
        "vehicle": {
            "id": "v1",
            "plate_number": "UNEQ-01",
            "length_cm": 110,
            "width_cm": 110,
            "height_cm": 120,
            "payload_limit_kg": 1000,
        },
        "demo_stacking": {
            "owner_mode": "SAME_CUSTOMER",
            "max_tiers": 3,
            "lift_clearance_cm": 5,
        },
        "stops": [
            {
                "stop_id": "p1",
                "sequence": 1,
                "stop_type": "PICKUP",
                "items_to_load": [
                    _item("base", allow_upper=False, max_top_load_g=30000).model_dump(),
                    _item("small", l=40, w=30, h=20, kg=20, max_top_load_g=None).model_dump(),
                ],
                "items_to_unload": [],
            },
            {
                "stop_id": "d1",
                "sequence": 2,
                "stop_type": "DELIVERY",
                "items_to_load": [],
                "items_to_unload": ["base", "small"],
            },
        ],
    }
    res = client.post("/validate-spatial", json=payload)
    assert res.status_code == 200
    body = res.json()
    assert body["is_valid"] is True
    step1 = {p["item_id"]: p for p in body["step_states"][0]["placed_items"]}
    assert step1["base"]["z"] == 0
    assert step1["small"]["support_item_id"] == "base"
    assert step1["small"]["z"] == 30
    assert step1["small"]["x"] >= step1["base"]["x"]
    assert step1["small"]["x"] + step1["small"]["length_cm"] <= step1["base"]["x"] + step1["base"]["length_cm"]
    assert step1["small"]["y"] >= step1["base"]["y"]
    assert step1["small"]["y"] + step1["small"]["width_cm"] <= step1["base"]["y"] + step1["base"]["width_cm"]
    assert body["max_area_cm2"] == 10000


def test_validate_spatial_packs_multiple_smaller_boxes_on_single_base():
    vehicle = VehicleFloor(
        id="v1", plate_number="MULTI-01",
        length_cm=110, width_cm=110, height_cm=120, payload_limit_kg=1000,
    )
    base = _item("base", l=100, w=100, h=30, kg=100, allow_upper=False, max_top_load_g=29500)
    s1 = _item("s1", l=45, w=45, h=20, kg=12, max_top_load_g=None)
    s2 = _item("s2", l=45, w=45, h=20, kg=12, max_top_load_g=None)
    stops = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base, s1, s2]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["base", "s1", "s2"]),
    ]
    result = validate_stop_actions(_policy(), vehicle, stops)
    assert result.is_valid is True
    placed = {p.item_id: p for p in result.step_states[0].placed_items}
    assert placed["s1"].support_item_id == "base"
    assert placed["s2"].support_item_id == "base"
    assert placed["s1"].z == 30 and placed["s2"].z == 30
    # Siblings on shared deck must not overlap each other on X/Y.
    x_disjoint = (
        placed["s1"].x + placed["s1"].length_cm <= placed["s2"].x + 0.01
        or placed["s2"].x + placed["s2"].length_cm <= placed["s1"].x + 0.01
    )
    y_disjoint = (
        placed["s1"].y + placed["s1"].width_cm <= placed["s2"].y + 0.01
        or placed["s2"].y + placed["s2"].width_cm <= placed["s1"].y + 0.01
    )
    assert x_disjoint or y_disjoint


def test_cumulative_subtree_weight_rejects_sibling_or_chain_overload():
    vehicle = VehicleFloor(
        id="v1", plate_number="WT-01",
        length_cm=105, width_cm=105, height_cm=120, payload_limit_kg=1000,
    )
    # 14 + 16 = 30kg (exactly 30% of 100kg base -> allowed under "not > 30%"),
    # while 14 + 17 = 31kg (> 30%) must reject when floor has no spare slot.
    base = _item("base", l=100, w=100, h=30, kg=100, allow_upper=False, max_top_load_g=40000)
    s1 = _item("s1", l=40, w=40, h=20, kg=14, max_top_load_g=None)
    s2_ok = _item("s2", l=40, w=40, h=20, kg=16, max_top_load_g=None)
    stops_ok = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base, s1, s2_ok]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["base", "s1", "s2"]),
    ]
    assert validate_stop_actions(_policy(), vehicle, stops_ok).is_valid is True

    s2 = _item("s2", l=40, w=40, h=20, kg=17, max_top_load_g=None)
    stops = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base, s1, s2]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["base", "s1", "s2"]),
    ]
    assert validate_stop_actions(_policy(), vehicle, stops).is_valid is False

    # Same with max_top_load_g = 25000 even if 14 + 14 = 28kg < 30%.
    base_capped = base.model_copy(update={"max_top_load_g": 25000})
    s2_light = s2.model_copy(update={"weight_kg": 14})
    stops_capped = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base_capped, s1, s2_light]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["base", "s1", "s2"]),
    ]
    assert validate_stop_actions(_policy(), vehicle, stops_capped).is_valid is False

    # 3-tier chain where Tier 2 (25kg) + Tier 3 (6kg) = 31kg >= 30% of Tier 1 (100kg).
    t1 = _item("t1", l=100, w=100, h=25, kg=100, allow_upper=False, max_top_load_g=35000)
    t2 = _item("t2", l=60, w=60, h=25, kg=25, allow_upper=True, max_top_load_g=8000)
    t3 = _item("t3", l=30, w=30, h=20, kg=6, allow_upper=True, max_top_load_g=None)
    chain_fail = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[t1, t2, t3]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["t1", "t2", "t3"]),
    ]
    assert validate_stop_actions(_policy(max_tiers=3), vehicle, chain_fail).is_valid is False

    # Lowering t3 to 4kg (total 29kg < 30kg) makes the 3-tier tree valid.
    t3_ok = t3.model_copy(update={"weight_kg": 4})
    chain_ok = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[t1, t2, t3_ok]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["t1", "t2", "t3"]),
    ]
    res_ok = validate_stop_actions(_policy(max_tiers=3), vehicle, chain_ok)
    assert res_ok.is_valid is True
    placed_ok = {p.item_id: p for p in res_ok.step_states[0].placed_items}
    assert placed_ok["t2"].support_item_id == "t1"
    assert placed_ok["t3"].support_item_id == "t2"
    assert placed_ok["t3"].z == 50


def test_cross_order_unequal_respects_owner_mode_and_orientation_locks():
    # Bed 130x90: base is 120x80 locked LWH (must sit 120x80).
    # Upper is 75x40 locked LWH (fits only if base hasn't swapped L/W? Wait: 75 <= 120 and 40 <= 80 fits;
    # test opposite: base 90x50 locked LWH, upper 80x40 -> only fits without rotating;
    # with upper locked LWH 45x85 -> cannot fit on 90x50 deck because w=85 > 50).
    vehicle = VehicleFloor(
        id="v1", plate_number="ORIENT-01",
        length_cm=100, width_cm=60, height_cm=120, payload_limit_kg=1000,
    )
    base = _item(
        "b", order_id="o1", customer_id="cust-a",
        l=90, w=50, h=30, kg=100, allow_upper=False, max_top_load_g=25000,
        can_rotate=False, allowed_orientations=["LWH"],
    )
    upper_rot_fit = _item(
        "u1", order_id="o2", customer_id="cust-b",
        l=40, w=80, h=20, kg=15, allow_upper=True, max_top_load_g=None,
        can_rotate=True,
    )
    stops_fit = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base]),
        StopAction(stop_id="p2", sequence=2, stop_type="PICKUP", items_to_load=[upper_rot_fit]),
        StopAction(stop_id="d2", sequence=3, stop_type="DELIVERY", items_to_unload=["u1"]),
        StopAction(stop_id="d1", sequence=4, stop_type="DELIVERY", items_to_unload=["b"]),
    ]
    # SAME_CUSTOMER rejects cross-customer stack on constrained floor; ANY_CUSTOMER rotates u1 to 80x40 and fits!
    assert validate_stop_actions(_policy("SAME_CUSTOMER"), vehicle, stops_fit).is_valid is False
    res_any = validate_stop_actions(_policy("ANY_CUSTOMER"), vehicle, stops_fit)
    assert res_any.is_valid is True
    placed_p2 = {p.item_id: p for p in res_any.step_states[1].placed_items}
    assert placed_p2["u1"].support_item_id == "b"
    assert (placed_p2["u1"].length_cm, placed_p2["u1"].width_cm) == (80, 40)

    # Locking upper_rot_fit to LWH (40x80) cannot fit on 90x50 base or remaining 10x60 floor!
    upper_locked = upper_rot_fit.model_copy(update={"can_rotate": False, "allowed_orientations": ["LWH"]})
    stops_locked = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base]),
        StopAction(stop_id="p2", sequence=2, stop_type="PICKUP", items_to_load=[upper_locked]),
        StopAction(stop_id="d2", sequence=3, stop_type="DELIVERY", items_to_unload=["u1"]),
        StopAction(stop_id="d1", sequence=4, stop_type="DELIVERY", items_to_unload=["b"]),
    ]
    assert validate_stop_actions(_policy("ANY_CUSTOMER"), vehicle, stops_locked).is_valid is False


def test_unequal_deck_rejects_blocked_unload_corridor_and_early_base_delivery():
    vehicle = VehicleFloor(
        id="v1", plate_number="DOOR-01",
        length_cm=110, width_cm=110, height_cm=120, payload_limit_kg=1000,
    )
    base = _item("base", order_id="o1", customer_id="c1", l=100, w=100, h=30, kg=100, allow_upper=False, max_top_load_g=29500)
    front_u = _item("u_early", order_id="o2", customer_id="c1", l=45, w=95, h=20, kg=12, max_top_load_g=None, can_rotate=False, allowed_orientations=["LWH"])
    rear_u = _item("u_late", order_id="o3", customer_id="c1", l=45, w=95, h=20, kg=12, max_top_load_g=None, can_rotate=False, allowed_orientations=["LWH"])

    # Cannot unload base at d1 while u_late is still sitting on top of it at d2.
    bad_base_order = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base]),
        StopAction(stop_id="p2", sequence=2, stop_type="PICKUP", items_to_load=[rear_u]),
        StopAction(stop_id="d1", sequence=3, stop_type="DELIVERY", items_to_unload=["base"]),
        StopAction(stop_id="d2", sequence=4, stop_type="DELIVERY", items_to_unload=["u_late"]),
    ]
    assert validate_stop_actions(_policy(), vehicle, bad_base_order).is_valid is False

    # Valid LIFO order on same deck: u_early picked last / placed at door side, unloaded before u_late, before base.
    # Because u_early is 45x95 and u_late is 45x95, they stack side-by-side along X on 100x100 base;
    # if u_early is picked AFTER u_late and delivered BEFORE u_late, validator puts u_early at rear (x >= u_late.x + u_late.l).
    good_lifo = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[base]),
        StopAction(stop_id="p2", sequence=2, stop_type="PICKUP", items_to_load=[rear_u]),
        StopAction(stop_id="p3", sequence=3, stop_type="PICKUP", items_to_load=[front_u]),
        StopAction(stop_id="d3", sequence=4, stop_type="DELIVERY", items_to_unload=["u_early"]),
        StopAction(stop_id="d2", sequence=5, stop_type="DELIVERY", items_to_unload=["u_late"]),
        StopAction(stop_id="d1", sequence=6, stop_type="DELIVERY", items_to_unload=["base"]),
    ]
    assert validate_stop_actions(_policy(), vehicle, good_lifo).is_valid is True

    # Reverse delivery order (d2 unloads u_late picked BEFORE u_early? No: if p_early loads full-width
    # front blocker 45x95? No, both 45x95 fit side by side along X, so p3 MUST sit at rear to not block p2 if p2 exits first,
    # Wait: if p2 & p3 load at SAME stop or p2 loaded before p3, p3 exits FIRST if u_late unloads after?
    # Wait: if p3 (u_early) loads first, sits deep? No, validator chooses X so later-delivered goes deeper).
    # Verify fast_validate_stacked_route agrees with full validator on the multi-stop unequal route!
    cargo = {it.id: it for it in (base, front_u, rear_u)}
    sched_like = [
        type("Stop", (), {"stop_type": s.stop_type, "location_id": s.stop_id, "items_loaded": [it.id for it in s.items_to_load], "items_unloaded": list(s.items_to_unload)})()
        for s in good_lifo
    ]
    ok, _ = fast_validate_stacked_route(vehicle, sched_like, cargo, _policy())
    assert ok is True


def test_fleet_optimizer_uses_unequal_stacking_to_save_a_vehicle_route():
    depot = LocationPoint(id="depot", name="Depot", latitude=10.76, longitude=106.66)
    p1 = LocationPoint(id="p1", name="P1", latitude=10.77, longitude=106.67)
    d1 = LocationPoint(id="d1", name="D1", latitude=10.78, longitude=106.68)
    vehicles = [
        FleetVehicle(
            id=f"v{i}", plate_number=f"TRK-{i}", depot=depot,
            length_cm=110, width_cm=110, height_cm=120, payload_limit_kg=1000,
            fuel_consumption_liters_per_100_km=12, fixed_operating_cost_vnd=500000,
        )
        for i in range(1, 3)
    ]
    drivers = [
        DriverOption(id=f"drv{i}", full_name=f"Driver {i}", fixed_salary_monthly_vnd=0, trip_base_pay_vnd=100000, per_km_pay_vnd=2000)
        for i in range(1, 3)
    ]
    orders = [
        OrderPair(
            id="o-base", order_number="ORD-BASE",
            pickup_location=p1, delivery_location=d1,
            items=[_item("base-box", order_id="o-base", customer_id="cust-1", l=100, w=100, h=30, kg=100, allow_upper=False, max_top_load_g=29000)],
        ),
        OrderPair(
            id="o-small", order_number="ORD-SMALL",
            pickup_location=p1, delivery_location=d1,
            items=[
                _item("small-1", order_id="o-small", customer_id="cust-1", l=40, w=40, h=20, kg=12, allow_upper=True, max_top_load_g=None),
                _item("small-2", order_id="o-small", customer_id="cust-1", l=40, w=40, h=20, kg=12, allow_upper=True, max_top_load_g=None),
            ],
        ),
    ]
    # Nodes: v1(0), v2(1), p1_o1(2), d1_o1(3), p1_o2(4), d1_o2(5)
    n = 6
    dist = [[0 if i == j else 5000 for j in range(n)] for i in range(n)]
    dur = [[0 if i == j else 600 for j in range(n)] for i in range(n)]

    req_stacked = FleetOptimizationRequest(
        job_id="uneq-fleet-save-route",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        demo_stacking=_policy("SAME_CUSTOMER", max_tiers=3, clearance_cm=5.0),
        policy=CostPolicy(fuel_price_per_liter_vnd=23000, monthly_working_minutes=10560),
        max_time_seconds=8,
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )
    res_stacked = client.post("/optimize-fleet/candidates", json=req_stacked.model_dump())
    assert res_stacked.status_code == 200
    batch = res_stacked.json()
    assert batch["candidates"], batch["diagnostics"]
    best = batch["candidates"][0]["result"]
    assert best["unassigned_orders"] == []
    assert len(best["routes"]) == 1
    route = best["routes"][0]
    package_ids_by_order = {"o-base": {"base-box"}, "o-small": {"small-1", "small-2"}}
    assert len(route["stops"]) == 4
    for stop in route["stops"]:
        assert set(stop["items_loaded"] or stop["items_unloaded"]) == package_ids_by_order[stop["allocation_id"]]
    assert route["total_distance_km"] == 25
    peak_state = max(
        route["spatial_validation"]["step_states"],
        key=lambda st: len(st["placed_items"]),
    )
    placed_peak = {p["item_id"]: p for p in peak_state["placed_items"]}
    assert placed_peak["small-1"]["support_item_id"] == "base-box"
    assert placed_peak["small-2"]["support_item_id"] == "base-box"
    assert route["spatial_validation"]["max_area_cm2"] == 10000


def test_fifo_overlap_separates_floor_lanes_in_fast_and_exact_validators():
    """FIFO overlap P1->P2->D1->D2 must keep floor orders in disjoint y-lanes instead of walling off y=0..W."""
    vehicle = VehicleFloor(
        id="v-fifo", plate_number="FIFO-01",
        length_cm=600, width_cm=240, height_cm=240, payload_limit_kg=5000,
    )
    o1_items = [
        _item(f"o1-{k}", order_id="o1", customer_id="cust-1", l=110, w=110, h=100, kg=120, allow_upper=False, max_top_load_g=None)
        for k in range(3)
    ]
    o2_items = [
        _item(f"o2-{k}", order_id="o2", customer_id="cust-2", l=110, w=110, h=100, kg=120, allow_upper=False, max_top_load_g=None)
        for k in range(3)
    ]
    cargo = {it.id: it for it in (*o1_items, *o2_items)}
    fifo_actions = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=o1_items),
        StopAction(stop_id="p2", sequence=2, stop_type="PICKUP", items_to_load=o2_items),
        StopAction(stop_id="d1", sequence=3, stop_type="DELIVERY", items_to_unload=[it.id for it in o1_items]),
        StopAction(stop_id="d2", sequence=4, stop_type="DELIVERY", items_to_unload=[it.id for it in o2_items]),
    ]
    sched_like = [
        type("Stop", (), {
            "stop_type": s.stop_type,
            "location_id": s.stop_id,
            "items_loaded": [it.id for it in s.items_to_load],
            "items_unloaded": list(s.items_to_unload),
        })()
        for s in fifo_actions
    ]
    policy = _policy("SAME_CUSTOMER", max_tiers=3, clearance_cm=5.0)
    ok_fast, reason = fast_validate_stacked_route(
        vehicle, sched_like, cargo, policy, allow_layout_search=False
    )
    assert ok_fast is True, reason
    exact_res = validate_stop_actions(policy, vehicle, fifo_actions, max_time_seconds=2.0)
    assert exact_res.is_valid is True, exact_res.error_message
    peak_p2 = exact_res.step_states[1]
    assert len(peak_p2.placed_items) == 6
    o1_ys = [(p.y, p.y + p.width_cm) for p in peak_p2.placed_items if p.order_id == "o1"]
    o2_ys = [(p.y, p.y + p.width_cm) for p in peak_p2.placed_items if p.order_id == "o2"]
    assert all(y1_hi <= y2_lo + 0.01 or y2_hi <= y1_lo + 0.01 for y1_lo, y1_hi in o1_ys for y2_lo, y2_hi in o2_ys)
