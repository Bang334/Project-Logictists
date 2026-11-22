"""Measure actual onboard cargo in the plans returned by the fleet endpoint."""

import json
from collections import Counter
from itertools import combinations
from pathlib import Path
from time import perf_counter

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import FleetOptimizationBatchResponse, FleetOptimizationResponse, PlacedItem


CASES = Path(__file__).resolve().parents[1] / "benchmarks" / "cases"
EPS = 0.01


def tiers_for_layout(items: list[PlacedItem]) -> dict[str, int]:
    placed_by_id = {}
    tiers = {}
    for item in sorted(items, key=lambda box: box.z):
        assert item.item_id not in placed_by_id
        if item.support_item_id is None:
            assert item.z == pytest.approx(0, abs=EPS)
            tier = 1
        else:
            assert item.support_item_id in placed_by_id, "Support must be onboard below its cargo"
            support = placed_by_id[item.support_item_id]
            assert item.z == pytest.approx(support.z + support.height_cm, abs=EPS)
            assert item.x >= support.x - EPS and item.y >= support.y - EPS
            assert item.x + item.length_cm <= support.x + support.length_cm + EPS
            assert item.y + item.width_cm <= support.y + support.width_cm + EPS
            tier = tiers[support.item_id] + 1
        placed_by_id[item.item_id] = item
        tiers[item.item_id] = tier
    return tiers


def audit_routes(result: FleetOptimizationResponse, payload: dict) -> list[dict]:
    """Count original orders by package ID, including split orders."""
    order_by_item = {
        item["id"]: order.get("source_order_id") or order["id"]
        for order in payload["orders"] for item in order["items"]
    }
    expected_packages = Counter(order_by_item.keys())
    vehicles = {
        (vehicle.get("source_vehicle_id") or vehicle["id"], vehicle.get("service_day_index", 0)): vehicle
        for vehicle in payload["vehicles"]
    }
    max_tiers = (payload.get("demo_stacking") or {}).get("max_tiers", 1)
    loaded, unloaded = Counter(), Counter()
    details = []
    for route in result.routes:
        vehicle = vehicles[route.vehicle_id, route.service_day_index]
        spatial = route.spatial_validation
        assert spatial.is_valid
        onboard = set()
        route_orders = set()
        peak_orders = peak_packages = peak_stacked = peak_tiers = 0
        peak_packages_by_tier = Counter()
        for stop, state in zip(route.stops, spatial.step_states, strict=True):
            assert state.is_valid
            assert state.stop_id == stop.location_id
            assert set(stop.items_loaded).isdisjoint(onboard)
            assert set(stop.items_unloaded) <= onboard
            onboard.update(stop.items_loaded)
            onboard.difference_update(stop.items_unloaded)
            loaded.update(stop.items_loaded)
            unloaded.update(stop.items_unloaded)
            assert {item.item_id for item in state.placed_items} == onboard
            tiers = tiers_for_layout(state.placed_items)
            for item in state.placed_items:
                assert item.x >= -EPS and item.y >= -EPS
                assert item.x + item.length_cm <= vehicle["length_cm"] + EPS
                assert item.y + item.width_cm <= vehicle["width_cm"] + EPS
                assert item.z + item.height_cm <= vehicle["height_cm"] + EPS
            for left, right in combinations(state.placed_items, 2):
                assert (
                    min(left.x + left.length_cm, right.x + right.length_cm) - max(left.x, right.x) <= EPS
                    or min(left.y + left.width_cm, right.y + right.width_cm) - max(left.y, right.y) <= EPS
                    or min(left.z + left.height_cm, right.z + right.height_cm) - max(left.z, right.z) <= EPS
                ), f"Packages overlap: {left.item_id}, {right.item_id}"
            onboard_orders = {order_by_item[item_id] for item_id in onboard}
            route_orders.update(onboard_orders)
            peak_orders = max(peak_orders, len(onboard_orders))
            peak_packages = max(peak_packages, len(onboard))
            peak_stacked = max(peak_stacked, sum(tier > 1 for tier in tiers.values()))
            peak_tiers = max(peak_tiers, max(tiers.values(), default=0))
            peak_packages_by_tier |= Counter(tiers.values())
            assert state.current_weight_kg <= vehicle["payload_limit_kg"] + EPS
        assert not onboard
        assert peak_tiers <= max_tiers
        details.append(dict(
            vehicle=route.vehicle_id,
            service_day=route.service_day_index,
            orders_on_route=len(route_orders),
            peak_onboard_orders=peak_orders,
            peak_onboard_packages=peak_packages,
            peak_above_floor=peak_stacked,
            peak_tiers=peak_tiers,
            peak_packages_by_tier=dict(peak_packages_by_tier),
        ))
    assert loaded == unloaded == expected_packages
    return details


@pytest.mark.parametrize(
    "fixture,mode,routes,orders,packages,stacked,tiers,cost",
    [
        ("scenario_stack_cost_comparison", None, 3, 1, 1, 0, 1, 738_000),
        ("scenario_stack_cost_comparison", "SAME_CUSTOMER", 1, 1, 3, 2, 3, 246_000),
        ("scenario_stack_customer_modes", None, 1, 2, 2, 0, 1, 246_000),
        ("scenario_stack_customer_modes", "SAME_CUSTOMER", 1, 2, 2, 0, 1, 246_000),
        ("scenario_stack_customer_modes", "ANY_CUSTOMER", 1, 2, 2, 1, 2, 246_000),
    ],
)
def test_returned_route_3d_layout_metrics(fixture, mode, routes, orders, packages, stacked, tiers, cost):
    payload = json.loads((CASES / f"{fixture}.json").read_text(encoding="utf-8"))
    payload.pop("scenario_profile", None)
    for vehicle in payload["vehicles"]:
        vehicle["source_vehicle_id"] = vehicle["id"]
        vehicle["id"] += "#day0"
    payload["demo_stacking"] = (
        dict(max_tiers=3, lift_clearance_cm=5, owner_mode=mode) if mode else None
    )
    payload.update(search_time_seconds=3, max_time_seconds=8)
    started = perf_counter()
    response = TestClient(app).post("/optimize-fleet/candidates", json=payload)
    elapsed = perf_counter() - started
    assert response.status_code == 200, response.text
    batch = FleetOptimizationBatchResponse.model_validate(response.json())
    assert batch.candidates, batch.diagnostics
    result = batch.candidates[0].result
    assert result.status == "SUCCESS" and not result.unassigned_orders
    details = audit_routes(result, payload)
    print(json.dumps(dict(
        fixture=fixture, mode=mode, elapsed_seconds=round(elapsed, 3), routes=details,
        cost_vnd=result.total_cost_vnd,
    )))
    assert len(details) == routes
    assert max(row["peak_onboard_orders"] for row in details) == orders
    assert max(row["peak_onboard_packages"] for row in details) == packages
    assert max(row["peak_above_floor"] for row in details) == stacked
    assert max(row["peak_tiers"] for row in details) == tiers
    assert result.total_cost_vnd == cost
