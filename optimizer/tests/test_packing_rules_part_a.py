"""Part A tests for floor orientation locks, CG weight balance, and fragile cargo rules."""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import CargoItem, PlacedItem, StopAction, VehicleFloor
from app.packing_rules import (
    is_floor_rotation_locked,
    normalize_allowed_orientations,
    resolve_can_rotate,
    score_candidate_balance_and_fragility,
)
from app.spatial_validator import SpatialValidator


def _floor(length_cm: float = 300, width_cm: float = 200, height_cm: float = 180) -> VehicleFloor:
    return VehicleFloor(
        id="v1",
        plate_number="51C-99999",
        length_cm=length_cm,
        width_cm=width_cm,
        height_cm=height_cm,
        payload_limit_kg=3000,
    )


def test_allowed_orientations_lwh_strictly_locks_floor_rotation():
    locked = CargoItem(
        id="locked-box",
        order_id="o1",
        length_cm=100,
        width_cm=60,
        height_cm=50,
        weight_kg=40,
        can_rotate=True,
        allowed_orientations=["LWH"],
    )
    unlocked = CargoItem(
        id="unlocked-box",
        order_id="o1",
        length_cm=100,
        width_cm=60,
        height_cm=50,
        weight_kg=40,
        can_rotate=True,
        allowed_orientations=["LWH", "WLH"],
    )
    legacy = CargoItem(
        id="legacy-box",
        order_id="o1",
        length_cm=100,
        width_cm=60,
        height_cm=50,
        weight_kg=40,
        can_rotate=True,
        allowed_orientations=None,
    )

    assert normalize_allowed_orientations(["LWH", "LWH"]) == ["LWH"]
    with pytest.raises(ValueError):
        normalize_allowed_orientations(["INVALID"])
    assert is_floor_rotation_locked(locked) is True
    assert resolve_can_rotate(locked) is False
    assert is_floor_rotation_locked(unlocked) is False
    assert resolve_can_rotate(unlocked) is True
    assert is_floor_rotation_locked(legacy) is False
    assert resolve_can_rotate(legacy) is True

    # Floor only fits 60x100 (rotated), never 100x60 (aligned).
    tight_floor = _floor(length_cm=80, width_cm=120)
    stops_locked = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[locked]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["locked-box"]),
    ]
    res_locked = SpatialValidator(tight_floor).validate_plan(stops_locked)
    assert res_locked.is_valid is False

    stops_unlocked = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[unlocked]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["unlocked-box"]),
    ]
    res_unlocked = SpatialValidator(tight_floor).validate_plan(stops_unlocked)
    assert res_unlocked.is_valid is True
    placed = res_unlocked.step_states[0].placed_items[0]
    assert (placed.length_cm, placed.width_cm) == (60.0, 100.0)
    assert placed.floor_rotation_locked is False

    stops_legacy = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[legacy]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["legacy-box"]),
    ]
    res_legacy = SpatialValidator(tight_floor).validate_plan(stops_legacy)
    assert res_legacy.is_valid is True


def test_allowed_orientations_lwh_enforced_in_demo_stacking_endpoint():
    base_pkg = dict(
        id="locked-stack",
        order_id="o1",
        length_cm=100,
        width_cm=60,
        height_cm=30,
        weight_kg=50,
        cargo_kind="STANDARD",
        allow_upper_tier=True,
        max_top_load_g=20000,
        can_rotate=True,
    )
    body = {
        "vehicle": {
            "id": "v1",
            "plate_number": "TEST",
            "length_cm": 80,
            "width_cm": 120,
            "height_cm": 120,
            "payload_limit_kg": 1000,
        },
        "stops": [
            {
                "stop_id": "p1",
                "sequence": 1,
                "stop_type": "PICKUP",
                "items_to_load": [base_pkg | {"allowed_orientations": ["LWH"]}],
            },
            {
                "stop_id": "d1",
                "sequence": 2,
                "stop_type": "DELIVERY",
                "items_to_unload": ["locked-stack"],
            },
        ],
        "demo_stacking": {"max_tiers": 2, "lift_clearance_cm": 5},
    }
    resp_locked = TestClient(app).post("/validate-spatial", json=body)
    assert resp_locked.status_code == 200, resp_locked.text
    assert resp_locked.json()["is_valid"] is False

    body["stops"][0]["items_to_load"][0]["allowed_orientations"] = ["LWH", "WLH"]
    resp_unlocked = TestClient(app).post("/validate-spatial", json=body)
    assert resp_unlocked.status_code == 200, resp_unlocked.text
    payload = resp_unlocked.json()
    assert payload["is_valid"] is True
    placed = payload["step_states"][0]["placed_items"][0]
    assert (placed["length_cm"], placed["width_cm"]) == (60.0, 100.0)


def test_weight_balance_metrics_and_lateral_balancing():
    floor = _floor(length_cm=300, width_cm=240)
    heavy_left = CargoItem(
        id="h1", order_id="o1", length_cm=80, width_cm=80, height_cm=60, weight_kg=250, can_rotate=False
    )
    heavy_right = CargoItem(
        id="h2", order_id="o1", length_cm=80, width_cm=80, height_cm=60, weight_kg=250, can_rotate=False
    )
    stops = [
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[heavy_left, heavy_right]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["h1", "h2"]),
    ]
    res = SpatialValidator(floor).validate_plan(stops)
    assert res.is_valid is True
    pickup_state = res.step_states[0]
    assert pickup_state.weight_balance is not None
    assert pickup_state.weight_balance.lateral_imbalance_percent <= 1.0
    assert pickup_state.weight_balance.left_weight_kg == 250.0
    assert pickup_state.weight_balance.right_weight_kg == 250.0
    assert abs(pickup_state.weight_balance.cg_y_cm - 120.0) <= 1.0
    assert res.max_lateral_imbalance_percent <= 1.0
    for item in pickup_state.placed_items:
        assert item.weight_kg == 250.0

    # Full 4-quadrant fill achieves BALANCED overall CG (lateral & longitudinal).
    sym_floor = _floor(length_cm=160, width_cm=160)
    quads = [
        CargoItem(id=f"q{idx}", order_id="o2", length_cm=80, width_cm=80, height_cm=50, weight_kg=100, can_rotate=False)
        for idx in range(4)
    ]
    sym_res = SpatialValidator(sym_floor).validate_plan([
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=quads),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=[q.id for q in quads]),
    ])
    assert sym_res.is_valid is True
    assert sym_res.step_states[0].weight_balance is not None
    assert sym_res.step_states[0].weight_balance.status == "BALANCED"


def test_fragile_heavy_first_loading_and_lateral_pinch_scoring():
    floor = _floor(length_cm=250, width_cm=200)
    fragile = CargoItem(
        id="frag",
        order_id="o1",
        length_cm=60,
        width_cm=60,
        height_cm=50,
        weight_kg=10,
        cargo_kind="FRAGILE",
        no_top_load_requested=True,
        allowed_orientations=["LWH"],
    )
    heavy = CargoItem(
        id="heavy",
        order_id="o1",
        length_cm=80,
        width_cm=80,
        height_cm=70,
        weight_kg=180,
        cargo_kind="STANDARD",
        can_rotate=True,
    )
    stops = [
        # Fragile appears first in payload, but heavy rigid cargo should be placed first at same stop.
        StopAction(stop_id="p1", sequence=1, stop_type="PICKUP", items_to_load=[fragile, heavy]),
        StopAction(stop_id="d1", sequence=2, stop_type="DELIVERY", items_to_unload=["frag", "heavy"]),
    ]
    res = SpatialValidator(floor).validate_plan(stops)
    assert res.is_valid is True
    placed_map = {p.item_id: p for p in res.step_states[0].placed_items}
    assert placed_map["heavy"].x == 0.0
    assert placed_map["frag"].cargo_kind == "FRAGILE"
    assert placed_map["frag"].no_top_load_requested is True
    assert placed_map["frag"].floor_rotation_locked is True

    # Pinch penalty check: placing FRAGILE immediately adjacent to 200kg neighbor vs open wall
    heavy_placed = PlacedItem(
        item_id="big", order_id="o1", x=0, y=60, length_cm=60, width_cm=60, height_cm=60, weight_kg=200
    )
    _, pinch_near_heavy = score_candidate_balance_and_fragility(
        cand_x=0,
        cand_y=0,
        cand_l=60,
        cand_w=60,
        cand_weight_kg=10,
        cand_cargo_kind="FRAGILE",
        current_placed=[heavy_placed],
        cargo_kind_by_id={"big": "STANDARD"},
        floor_length_cm=250,
        floor_width_cm=200,
    )
    _, pinch_clear = score_candidate_balance_and_fragility(
        cand_x=180,
        cand_y=140,
        cand_l=60,
        cand_w=60,
        cand_weight_kg=10,
        cand_cargo_kind="FRAGILE",
        current_placed=[heavy_placed],
        cargo_kind_by_id={"big": "STANDARD"},
        floor_length_cm=250,
        floor_width_cm=200,
    )
    assert pinch_near_heavy > pinch_clear


def test_demo_stacking_recomputes_weight_balance_across_unloads():
    body = {
        "vehicle": {
            "id": "v1",
            "plate_number": "TEST",
            "length_cm": 160,
            "width_cm": 160,
            "height_cm": 120,
            "payload_limit_kg": 1000,
        },
        "stops": [
            {
                "stop_id": "pickup-all",
                "sequence": 1,
                "stop_type": "PICKUP",
                "items_to_load": [
                    {
                        "id": "left-base",
                        "order_id": "o1",
                        "customer_id": "c1",
                        "length_cm": 80,
                        "width_cm": 80,
                        "height_cm": 30,
                        "weight_kg": 100,
                        "cargo_kind": "STANDARD",
                        "allow_upper_tier": True,
                        "max_top_load_g": 30000,
                    },
                    {
                        "id": "left-top",
                        "order_id": "o1",
                        "customer_id": "c1",
                        "length_cm": 80,
                        "width_cm": 80,
                        "height_cm": 30,
                        "weight_kg": 20,
                        "cargo_kind": "STANDARD",
                        "allow_upper_tier": True,
                        "max_top_load_g": 30000,
                    },
                    {
                        "id": "right-counter",
                        "order_id": "o2",
                        "customer_id": "c2",
                        "length_cm": 80,
                        "width_cm": 80,
                        "height_cm": 30,
                        "weight_kg": 120,
                        "cargo_kind": "STANDARD",
                        "allow_upper_tier": False,
                    },
                ],
            },
            {
                "stop_id": "drop-o2",
                "sequence": 2,
                "stop_type": "DELIVERY",
                "items_to_unload": ["right-counter"],
            },
            {
                "stop_id": "drop-o1",
                "sequence": 3,
                "stop_type": "DELIVERY",
                "items_to_unload": ["left-base", "left-top"],
            },
        ],
        "demo_stacking": {"max_tiers": 2, "lift_clearance_cm": 5},
    }
    resp = TestClient(app).post("/validate-spatial", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["is_valid"] is True

    step0, step1, step2 = data["step_states"]
    assert step0["weight_balance"]["total_weight_kg"] == 240.0
    assert step0["weight_balance"]["lateral_imbalance_percent"] <= 1.0
    # After dropping o2 (120kg), only the 120kg stacked pair remains on one half.
    assert step1["weight_balance"]["total_weight_kg"] == 120.0
    assert step1["weight_balance"]["lateral_imbalance_percent"] >= 40.0
    assert step2["weight_balance"]["total_weight_kg"] == 0.0
