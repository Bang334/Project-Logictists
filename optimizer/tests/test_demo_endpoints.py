import json
from pathlib import Path
from itertools import combinations
from fastapi import HTTPException
from app.models import FleetOptimizationRequest
from app.spatial_validator import SpatialValidator
import pytest
from app.demo import (
    list_demo_cases,
    get_demo_case_payload,
    run_demo_case,
    DemoRunRequest,
)


def archived_case(case_id):
    path = Path(__file__).resolve().parents[1] / "benchmarks" / "cases" / f"{case_id}.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw.pop("scenario_profile", None)
    return raw


EXPECTED_DELIVERIES = {
    "corridor_03_rotate": [1, 2, 3],
    "corridor_04_fifo": [1, 2, 3, 4],
    "corridor_05_fifo": [1, 2, 3, 4, 5],
    "corridor_05_swap": [1, 4, 3, 2, 5],
    "corridor_07_reverse": [7, 6, 5, 4, 3, 2, 1],
    "corridor_10_fifo": list(range(1, 11)),
}


def test_list_demo_cases():
    cases = list_demo_cases()
    assert {case.id for case in cases} == set(EXPECTED_DELIVERIES)
    assert all(case.vehicles_count == case.drivers_count == 1 for case in cases)
    assert all(0 < case.total_weight_kg <= 2000 and 0 < case.total_volume_cbm <= 20.16 for case in cases)
    with pytest.raises(HTTPException) as error:
        get_demo_case_payload("scenario_1_multi_item")
    assert error.value.status_code == 404


@pytest.mark.parametrize("case_id,deliveries", EXPECTED_DELIVERIES.items())
def test_corridor_demo(case_id, deliveries):
    batch = run_demo_case(DemoRunRequest(case_id=case_id, demo_stacking_enabled=True))
    assert batch.candidates
    request = FleetOptimizationRequest.model_validate(get_demo_case_payload(case_id))
    validator = SpatialValidator(request.vehicles[0])
    count = len(deliveries)
    expected = [("PICKUP", i) for i in range(1, count + 1)] + [("DELIVERY", i) for i in deliveries]
    for candidate in batch.candidates:
        result = candidate.result
        assert result.status == "SUCCESS" and not result.unassigned_orders
        route, = result.routes
        assert route.driver_id == "driver-1" and route.vehicle_id == "truck-1"
        assert route.total_distance_km == 12 * count
        assert route.spatial_validation.is_valid
        states = route.spatial_validation.step_states
        assert len(route.stops) == len(states) == len(expected)
        previous = {}
        previous_items = []
        for stop, state, (kind, number) in zip(route.stops, states, expected):
            package = f"K{number:02}"
            assert stop.stop_type == state.stop_type == kind
            assert stop.location_id == state.stop_id
            assert state.is_valid and state.current_weight_kg <= 2000
            current = {i.item_id: (i.x, i.y, i.z, i.length_cm, i.width_cm) for i in state.placed_items}
            if kind == "PICKUP":
                assert stop.items_loaded == [package]
                assert current.keys() == previous.keys() | {package}
            else:
                assert stop.items_unloaded == [package]
                assert current.keys() == previous.keys() - {package}
            for item_id in current.keys() & previous.keys():
                assert current[item_id] == previous[item_id]
            for x, y, z, length, width in current.values():
                assert z == 0 and 0 <= x <= 400 - length and 0 <= y <= 240 - width
            for a, b in combinations(state.placed_items, 2):
                assert not validator.is_overlap(a.x, a.y, a.length_cm, a.width_cm, b.x, b.y, b.length_cm, b.width_cm)
            onboard = state.placed_items if kind == "PICKUP" else previous_items
            moving = next(item for item in onboard if item.item_id == package)
            assert validator.is_path_to_door_clear(moving, onboard)[0]
            previous_items = state.placed_items
            previous = current
        assert not previous
        assert len(states[count - 1].placed_items) == count
        if case_id == "corridor_03_rotate":
            rotated = next(i for i in states[count - 1].placed_items if i.item_id == "K01")
            assert (rotated.length_cm, rotated.width_cm) == (270, 160)


def test_run_demo_case_nhatrang():
    req = DemoRunRequest(custom_request=archived_case("db_nhatrang_2_orders"), time_budget_seconds=2.0)
    batch = run_demo_case(req)
    assert batch.job_id is not None
    assert len(batch.candidates) >= 1
    best_candidate = batch.candidates[0]
    assert best_candidate.result.status == "SUCCESS"
    assert len(best_candidate.result.routes) == 1
    assert len(best_candidate.result.unassigned_orders) == 0
    assert best_candidate.result.benchmarks is not None
    direct = best_candidate.result.benchmarks.direct_dedicated
    assert direct.is_feasible and len(direct.routes) == 2
    assert len({route.route_id for route in direct.routes}) == 2
    assert sum(route.cost.total_cost_vnd for route in direct.routes) == direct.total_cost_vnd
    for route in direct.routes:
        assert route.depot and route.driver_id
        assert [stop.stop_type for stop in route.stops] == ["PICKUP", "DELIVERY"]
        assert route.spatial_validation.is_valid and route.spatial_validation.step_states


def test_stacking_demo_compares_complete_delivery_under_the_same_input():
    def run(enabled):
        batch = run_demo_case(DemoRunRequest(custom_request=archived_case("scenario_stack_cost_comparison"),
            demo_stacking_enabled=enabled, time_budget_seconds=6))
        result = batch.candidates[0].result
        assert result.status == "SUCCESS" and not result.unassigned_orders
        assert sorted(pkg for route in result.routes for stop in route.stops for pkg in stop.items_unloaded) == ["KIEN-A", "KIEN-B", "KIEN-C"]
        return result

    floor, stacked = run(False), run(True)
    assert (len(floor.routes), floor.total_distance_km, floor.total_cost_vnd) == (3, 87, 738000)
    assert (len(stacked.routes), stacked.total_distance_km, stacked.total_cost_vnd) == (1, 29, 246000)
    pickup, delivery = stacked.routes[0].spatial_validation.step_states
    assert [item.z for item in pickup.placed_items] == [0, 25, 50]
    assert delivery.unload_sequence == ["KIEN-C", "KIEN-B", "KIEN-A"]


def test_customer_demo_modes_use_same_route_but_different_supports():
    def run(mode):
        batch = run_demo_case(DemoRunRequest(custom_request=archived_case("scenario_stack_customer_modes"), demo_stacking_owner_mode=mode, time_budget_seconds=6))
        result = batch.candidates[0].result
        assert result.status == "SUCCESS" and len(result.routes) == 1
        return result.routes[0]

    same, any_customer = run("SAME_CUSTOMER"), run("ANY_CUSTOMER")
    assert [stop.location_id for stop in same.stops] == [stop.location_id for stop in any_customer.stops]
    assert all(item.z == 0 for state in same.spatial_validation.step_states for item in state.placed_items)
    assert any(item.item_id == "KIEN-B" and item.support_item_id == "KIEN-A"
               for state in any_customer.spatial_validation.step_states for item in state.placed_items)


def test_custom_json_request_can_enable_demo_stacking():
    payload = archived_case("scenario_stack_cost_comparison")
    payload["demo_stacking"] = None
    batch = run_demo_case(DemoRunRequest(
        custom_request=payload,
        demo_stacking_enabled=True,
        demo_stacking_owner_mode="ANY_CUSTOMER",
        time_budget_seconds=5,
    ))
    result = batch.candidates[0].result
    assert result.status == "SUCCESS" and len(result.routes) == 1
    assert any((item.z or 0) > 0 for state in result.routes[0].spatial_validation.step_states for item in state.placed_items)

def test_danang_stress_case_is_available_with_seven_day_slots():
    payload = archived_case("stress_3d_danang_120_orders")
    assert len(payload["orders"]) == 120 and payload["demo_stacking"]
    assert sum(len(order["items"]) for order in payload["orders"]) == 1260
    assert len({vehicle["source_vehicle_id"] for vehicle in payload["vehicles"]}) == 20
    assert {vehicle["service_day_index"] for vehicle in payload["vehicles"]} == set(range(7))
    assert payload["search_time_seconds"] == 30

def test_bulky_danang_case_has_nearby_delivery_points():
    payload = archived_case("stress_3d_danang_dense_120_orders")
    vehicles = len(payload["vehicles"])
    assert len(payload["orders"]) == 120
    assert sum(len(o["items"]) for o in payload["orders"]) == 1260
    for index, order in enumerate(payload["orders"]):
        assert all(item["height_cm"] >= 65 for item in order["items"])
        delivery_node = vehicles + 2 * index + 1
        assert payload["distance_matrix_meters"][0][delivery_node] <= 12300
        assert payload["distance_matrix_meters"][delivery_node][0] <= 12300
