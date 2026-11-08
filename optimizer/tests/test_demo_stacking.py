import pytest
from fastapi.testclient import TestClient

from app.main import app
from test_contract_models import minimal_fleet_request


def package(item_id, weight, **policy):
    return dict(id=item_id, order_id="order", length_cm=100, width_cm=100,
                height_cm=25, weight_kg=weight, cargo_kind="STANDARD",
                allow_upper_tier=True, max_top_load_g=30000) | policy


def validate(items, *, height=100, tiers=3, separate_delivery=False, enabled=True):
    stops = [
        dict(stop_id="pickup", sequence=1, stop_type="PICKUP", items_to_load=items),
        dict(stop_id="delivery", sequence=2, stop_type="DELIVERY",
             items_to_unload=[item["id"] for item in items]),
    ]
    if separate_delivery:
        stops[1]["items_to_unload"].pop()
        stops.append(dict(stop_id="later", sequence=3, stop_type="DELIVERY", items_to_unload=[items[-1]["id"]]))
    body = dict(vehicle=dict(id="van", plate_number="TEST", length_cm=100,
                             width_cm=100, height_cm=height, payload_limit_kg=500), stops=stops)
    if enabled:
        body["demo_stacking"] = dict(max_tiers=tiers, lift_clearance_cm=5)
    response = TestClient(app).post("/validate-spatial", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_three_tiers_restore_physical_ids_and_unload_top_first():
    result = validate([package("A", 100), package("B", 22), package("C", 5)])
    assert result["is_valid"]
    assert result["demo_stacking"] == {"max_tiers": 3, "lift_clearance_cm": 5, "owner_mode": "SAME_CUSTOMER"}
    pickup, delivery = result["step_states"]
    assert pickup["current_occupied_area_cm2"] == 10000
    assert pickup["current_weight_kg"] == 127
    by_id = {item["item_id"]: item for item in pickup["placed_items"]}
    assert [(by_id[key]["z"], by_id[key]["support_item_id"]) for key in "ABC"] == [(0, None), (25, "A"), (50, "B")]
    assert delivery["unload_sequence"] == ["C", "B", "A"]
    top_path = next(path for path in pickup["package_access_paths"] if path["item_id"] == "C")
    assert top_path["is_clear"] and top_path["points"][1]["z"] == 55


@pytest.mark.parametrize("items,options", [
    ([package("A", 100), package("B", 25), package("C", 6)], {}),
    ([package("A", 100), package("B", 30)], {}),
    ([package("A", 100, max_top_load_g=10000), package("B", 12)], {}),
    ([package("A", 100, cargo_kind="FRAGILE"), package("B", 20)], {}),
    ([package("A", 100, no_top_load_requested=True), package("B", 20)], {}),
    ([package("A", 100, max_top_load_g=None), package("B", 20)], {}),
    ([package("A", 100), package("B", 20, allow_upper_tier=False)], {}),
    ([package("A", 100), package("B", 20)], {"height": 54}),
    ([package("A", 100), package("B", 20)], {"separate_delivery": True}),
    ([package("A", 100), package("B", 20)], {"enabled": False}),
    ([package("A", 100), package("B", 22), package("C", 5)], {"tiers": 2}),
])
def test_stack_with_violated_rule_cannot_create_a_feasible_layout(items, options):
    assert not validate(items, **options)["is_valid"]


def test_fleet_candidates_return_physical_package_ids_after_solver():
    body = minimal_fleet_request()
    body["vehicles"][0].update(length_cm=100, width_cm=100, height_cm=100)
    body["orders"][0]["items"] = [package("A", 100), package("B", 22), package("C", 5)]
    for item in body["orders"][0]["items"]:
        item["order_id"] = body["orders"][0]["id"]
    body["demo_stacking"] = dict(max_tiers=3, lift_clearance_cm=5)
    body["max_time_seconds"] = 3
    body["search_time_seconds"] = 3
    response = TestClient(app).post("/optimize-fleet/candidates", json=body)
    assert response.status_code == 200, response.text
    results = [candidate["result"] for candidate in response.json()["candidates"]]
    route = next(route for result in results for route in result["routes"] if result["status"] == "SUCCESS")
    assert route["stops"][0]["items_loaded"] == ["A", "B", "C"]
    assert route["stops"][1]["items_unloaded"] == ["C", "B", "A"]
    assert route["spatial_validation"]["step_states"][0]["placed_items"][-1]["support_item_id"] == "B"


@pytest.mark.parametrize("mode,same_customer,protected,valid", [
    ("SAME_CUSTOMER", False, False, False),
    ("SAME_CUSTOMER", True, False, True),
    ("ANY_CUSTOMER", False, False, True),
    ("ANY_CUSTOMER", False, True, False),
])
def test_two_orders_follow_customer_policy_at_each_actual_stop(mode, same_customer, protected, valid):
    a = package("A", 100, customer_id="customer-a", order_id="order-a", no_top_load_requested=protected)
    b = package("B", 22, customer_id="customer-a" if same_customer else "customer-b", order_id="order-b")
    body = dict(vehicle=dict(id="van", plate_number="TEST", length_cm=100, width_cm=100, height_cm=100, payload_limit_kg=500),
                demo_stacking=dict(max_tiers=3, lift_clearance_cm=5, owner_mode=mode), stops=[
                    dict(stop_id="pickup-a", sequence=1, stop_type="PICKUP", items_to_load=[a]),
                    dict(stop_id="pickup-b", sequence=2, stop_type="PICKUP", items_to_load=[b]),
                    dict(stop_id="delivery-b", sequence=3, stop_type="DELIVERY", items_to_unload=["B"]),
                    dict(stop_id="delivery-a", sequence=4, stop_type="DELIVERY", items_to_unload=["A"]),
                ])
    response = TestClient(app).post("/validate-spatial", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["is_valid"] is valid
    if valid:
        first, overlap, after_b, after_a = result["step_states"]
        assert [state["current_weight_kg"] for state in (first, overlap, after_b, after_a)] == [100, 122, 100, 0]
        assert [item["item_id"] for item in first["placed_items"]] == ["A"]
        assert overlap["placed_items"][1]["support_item_id"] == "A"
        assert overlap["placed_items"][1]["order_id"] == "order-b"
        assert after_b["unload_sequence"] == ["B"] and after_a["unload_sequence"] == ["A"]


def test_cross_order_stack_cannot_load_through_another_packages_footprint():
    base = package("A", 100, customer_id="customer-a", order_id="order-a")
    upper = package("B", 22, customer_id="customer-b", order_id="order-b")
    blocker = package("X", 50, order_id="order-x", cargo_kind="FRAGILE")
    stops = [dict(stop_id=f"load-{item['id']}", sequence=i + 1, stop_type="PICKUP", items_to_load=[item])
             for i, item in enumerate([base, blocker, upper])]
    stops += [dict(stop_id=f"drop-{item_id}", sequence=i + 4, stop_type="DELIVERY", items_to_unload=[item_id])
              for i, item_id in enumerate(["B", "X", "A"])]
    response = TestClient(app).post("/validate-spatial", json=dict(
        vehicle=dict(id="van", plate_number="TEST", length_cm=200, width_cm=100, height_cm=100, payload_limit_kg=500),
        demo_stacking=dict(max_tiers=3, lift_clearance_cm=5, owner_mode="ANY_CUSTOMER"), stops=stops,
    ))
    assert response.status_code == 200, response.text
    assert not response.json()["is_valid"]
