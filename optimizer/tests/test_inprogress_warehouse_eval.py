from fastapi.testclient import TestClient

from app.main import app
from app.models import (
    CargoItem,
    InProgressEvaluationRequest,
    PlacedOnboardItem,
    RemainingRouteStop,
    VehicleFloor,
    default_stacking_policy,
)


def _item(
    item_id: str,
    order_id: str,
    *,
    length_cm: float = 100.0,
    width_cm: float = 100.0,
    height_cm: float = 80.0,
    weight_kg: float = 100.0,
) -> CargoItem:
    return CargoItem(
        id=item_id,
        order_id=order_id,
        length_cm=length_cm,
        width_cm=width_cm,
        height_cm=height_cm,
        weight_kg=weight_kg,
        cargo_kind="STANDARD",
        allow_upper_tier=True,
    )


def test_inprogress_keeps_clear_delivery_and_blocks_under_retained_stack():
    """A2: Retained B sits ON TOP of C -> C is blocked (RETURN_TO_HUB), clear D can still deliver."""
    vehicle = VehicleFloor(
        id="veh-1",
        plate_number="43C-10001",
        length_cm=400,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=3000,
    )
    item_b = _item("pkg-b", "ord-b", length_cm=80, width_cm=80, height_cm=50, weight_kg=50)
    item_c = _item("pkg-c", "ord-c", length_cm=150, width_cm=100, height_cm=80, weight_kg=400)
    item_d = _item("pkg-d", "ord-d", length_cm=100, width_cm=100, height_cm=80, weight_kg=100)

    req = InProgressEvaluationRequest(
        trip_id="trip-1",
        vehicle=vehicle,
        demo_stacking=default_stacking_policy(),
        onboard_items=[
            PlacedOnboardItem(
                item=item_c,
                retained=False,
                unload_stop_id="stop-c",
                x=0.0,
                y=0.0,
                z=0.0,
                placed_length_cm=150.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
            PlacedOnboardItem(
                item=item_b,
                retained=True,
                unload_stop_id="stop-b",
                x=10.0,
                y=10.0,
                z=80.0,
                placed_length_cm=80.0,
                placed_width_cm=80.0,
                placed_height_cm=50.0,
                support_item_id="pkg-c",
            ),
            PlacedOnboardItem(
                item=item_d,
                retained=False,
                unload_stop_id="stop-d",
                x=300.0,
                y=100.0,
                z=0.0,
                placed_length_cm=100.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
        ],
        remaining_stops=[
            RemainingRouteStop(
                stop_id="stop-c",
                sequence=3,
                stop_type="DELIVERY",
                order_id="ord-c",
                item_ids=["pkg-c"],
            ),
            RemainingRouteStop(
                stop_id="stop-d",
                sequence=4,
                stop_type="DELIVERY",
                order_id="ord-d",
                item_ids=["pkg-d"],
            ),
        ],
    )

    client = TestClient(app)
    resp = client.post("/evaluate-inprogress-trip", json=req.model_dump())
    assert resp.status_code == 200
    body = resp.json()
    assert body["used_exact_placements"] is True
    assert body["keep_delivery_stop_ids"] == ["stop-d"]
    assert body["return_to_hub_stop_ids"] == ["stop-c"]
    assert set(body["return_to_hub_item_ids"]) == {"pkg-b", "pkg-c"}
    c_dec = next(d for d in body["stop_decisions"] if d["stop_id"] == "stop-c")
    assert c_dec["reason_code"] == "BLOCKED_BY_RETAINED_CARGO"
    assert c_dec["blocker_item_ids"] == ["pkg-b"]


def test_inprogress_blocks_corridor_obstruction_and_detaches_unpicked_overload():
    """A1+A2: Retained B blocks C's rear corridor -> C returns; late/overweight unpicked order detaches."""
    vehicle = VehicleFloor(
        id="veh-2",
        plate_number="43C-10002",
        length_cm=300,
        width_cm=120,
        height_cm=180,
        payload_limit_kg=1000,
    )
    item_c = _item("pkg-c", "ord-c", length_cm=100, width_cm=100, height_cm=80, weight_kg=450)
    item_b = _item("pkg-b", "ord-b", length_cm=100, width_cm=110, height_cm=80, weight_kg=450)
    unpicked = _item("pkg-u", "ord-u", length_cm=100, width_cm=100, height_cm=80, weight_kg=300)

    req = InProgressEvaluationRequest(
        trip_id="trip-2",
        vehicle=vehicle,
        demo_stacking=None,
        shift_end_epoch_sec=5000,
        return_to_hub_travel_sec=600,
        onboard_items=[
            PlacedOnboardItem(
                item=item_c,
                retained=False,
                unload_stop_id="stop-c",
                x=0.0,
                y=0.0,
                z=0.0,
                placed_length_cm=100.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
            PlacedOnboardItem(
                item=item_b,
                retained=True,
                unload_stop_id="stop-b",
                x=150.0,
                y=0.0,
                z=0.0,
                placed_length_cm=100.0,
                placed_width_cm=110.0,
                placed_height_cm=80.0,
            ),
        ],
        remaining_stops=[
            RemainingRouteStop(
                stop_id="stop-c",
                sequence=3,
                stop_type="DELIVERY",
                order_id="ord-c",
                item_ids=["pkg-c"],
                estimated_arrival_epoch_sec=2000,
                window_end_epoch_sec=4000,
                service_duration_sec=300,
            ),
            RemainingRouteStop(
                stop_id="stop-u-pick",
                sequence=4,
                stop_type="PICKUP",
                order_id="ord-u",
                item_ids=["pkg-u"],
                items_to_load=[unpicked],
                estimated_arrival_epoch_sec=2600,
                window_end_epoch_sec=4000,
                service_duration_sec=300,
            ),
            RemainingRouteStop(
                stop_id="stop-u-deliv",
                sequence=5,
                stop_type="DELIVERY",
                order_id="ord-u",
                item_ids=["pkg-u"],
                estimated_arrival_epoch_sec=3200,
                window_end_epoch_sec=4500,
                service_duration_sec=300,
            ),
        ],
    )

    client = TestClient(app)
    resp = client.post("/evaluate-inprogress-trip", json=req.model_dump())
    assert resp.status_code == 200
    body = resp.json()
    assert body["return_to_hub_stop_ids"] == ["stop-c"]
    assert set(body["return_to_hub_item_ids"]) == {"pkg-b", "pkg-c"}
    assert body["detached_order_ids"] == ["ord-u"]


def test_inprogress_marks_late_onboard_delivery_for_hub_return():
    """A1: Even if unobstructed, an onboard stop exceeding window/shift returns to hub."""
    vehicle = VehicleFloor(
        id="veh-3",
        plate_number="43C-10003",
        length_cm=400,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=2000,
    )
    item_b = _item("pkg-b", "ord-b", length_cm=100, width_cm=100, height_cm=80, weight_kg=100)
    item_d = _item("pkg-d", "ord-d", length_cm=100, width_cm=100, height_cm=80, weight_kg=100)

    req = InProgressEvaluationRequest(
        trip_id="trip-3",
        vehicle=vehicle,
        demo_stacking=default_stacking_policy(),
        shift_end_epoch_sec=4000,
        return_to_hub_travel_sec=600,
        onboard_items=[
            PlacedOnboardItem(
                item=item_b,
                retained=True,
                unload_stop_id="stop-b",
                x=0.0,
                y=0.0,
                z=0.0,
                placed_length_cm=100.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
            PlacedOnboardItem(
                item=item_d,
                retained=False,
                unload_stop_id="stop-d",
                x=250.0,
                y=0.0,
                z=0.0,
                placed_length_cm=100.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
        ],
        remaining_stops=[
            RemainingRouteStop(
                stop_id="stop-d",
                sequence=3,
                stop_type="DELIVERY",
                order_id="ord-d",
                item_ids=["pkg-d"],
                estimated_arrival_epoch_sec=3600,
                window_end_epoch_sec=5000,
                service_duration_sec=300,
            ),
        ],
    )

    client = TestClient(app)
    resp = client.post("/evaluate-inprogress-trip", json=req.model_dump())
    assert resp.status_code == 200
    body = resp.json()
    assert body["keep_delivery_stop_ids"] == []
    assert body["return_to_hub_stop_ids"] == ["stop-d"]
    assert set(body["return_to_hub_item_ids"]) == {"pkg-b", "pkg-d"}
    d_dec = next(d for d in body["stop_decisions"] if d["stop_id"] == "stop-d")
    assert d_dec["reason_code"] == "OUTSIDE_SHIFT_WINDOW"


def test_inprogress_keeps_fitting_unpicked_order_when_clear_delivery_frees_space():
    """A1: Once D is safely delivered, remaining unpicked order fitting alongside retained B stays KEEP_PICKUP."""
    vehicle = VehicleFloor(
        id="veh-4",
        plate_number="43C-10004",
        length_cm=300,
        width_cm=150,
        height_cm=180,
        payload_limit_kg=1500,
    )
    item_b = _item("pkg-b", "ord-b", length_cm=100, width_cm=100, height_cm=80, weight_kg=400)
    item_d = _item("pkg-d", "ord-d", length_cm=150, width_cm=100, height_cm=80, weight_kg=500)
    item_u = _item("pkg-u", "ord-u", length_cm=120, width_cm=100, height_cm=80, weight_kg=500)

    req = InProgressEvaluationRequest(
        trip_id="trip-4",
        vehicle=vehicle,
        demo_stacking=default_stacking_policy(),
        shift_end_epoch_sec=8000,
        return_to_hub_travel_sec=600,
        onboard_items=[
            PlacedOnboardItem(
                item=item_b,
                retained=True,
                unload_stop_id="stop-b",
                x=0.0,
                y=0.0,
                z=0.0,
                placed_length_cm=100.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
            PlacedOnboardItem(
                item=item_d,
                retained=False,
                unload_stop_id="stop-d",
                x=150.0,
                y=0.0,
                z=0.0,
                placed_length_cm=150.0,
                placed_width_cm=100.0,
                placed_height_cm=80.0,
            ),
        ],
        remaining_stops=[
            RemainingRouteStop(
                stop_id="stop-d",
                sequence=3,
                stop_type="DELIVERY",
                order_id="ord-d",
                item_ids=["pkg-d"],
                estimated_arrival_epoch_sec=2000,
                window_end_epoch_sec=6000,
                service_duration_sec=300,
            ),
            RemainingRouteStop(
                stop_id="stop-u-pick",
                sequence=4,
                stop_type="PICKUP",
                order_id="ord-u",
                item_ids=["pkg-u"],
                items_to_load=[item_u],
                estimated_arrival_epoch_sec=3000,
                window_end_epoch_sec=6000,
                service_duration_sec=300,
            ),
            RemainingRouteStop(
                stop_id="stop-u-deliv",
                sequence=5,
                stop_type="DELIVERY",
                order_id="ord-u",
                item_ids=["pkg-u"],
                estimated_arrival_epoch_sec=4000,
                window_end_epoch_sec=7000,
                service_duration_sec=300,
            ),
        ],
    )

    client = TestClient(app)
    resp = client.post("/evaluate-inprogress-trip", json=req.model_dump())
    assert resp.status_code == 200
    body = resp.json()
    assert body["keep_delivery_stop_ids"] == ["stop-d", "stop-u-deliv"]
    assert body["return_to_hub_stop_ids"] == []
    assert body["return_to_hub_item_ids"] == ["pkg-b"]
    assert body["detached_order_ids"] == []
