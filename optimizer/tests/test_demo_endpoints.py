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


def test_list_demo_cases():
    cases = list_demo_cases()
    assert [case.id for case in cases] == ["demo_3d_danang_complex"]
    case = cases[0]
    assert case.vehicles_count == 1 and case.drivers_count == 1
    assert case.orders_count == 8
    assert case.supports_stacking is True
    assert case.total_volume_cbm > 28.8 * 0.80
    for obsolete in ("corridor_03_rotate", "scenario_1_multi_item"):
        with pytest.raises(HTTPException) as error:
            get_demo_case_payload(obsolete)
        assert error.value.status_code == 404


def test_complex_3d_demo_scenario():
    request = FleetOptimizationRequest.model_validate(get_demo_case_payload("demo_3d_danang_complex"))
    vehicle = request.vehicles[0]
    vehicle_vol_cm3 = vehicle.length_cm * vehicle.width_cm * vehicle.height_cm
    floor_area_cm2 = vehicle.length_cm * vehicle.width_cm

    base_slab = next(it for o in request.orders for it in o.items if it.id == "K01-SAN-60")
    assert base_slab.length_cm * base_slab.width_cm == pytest.approx(floor_area_cm2 * 0.60)
    assert base_slab.height_cm == pytest.approx(vehicle.height_cm * 0.10)

    batch = run_demo_case(DemoRunRequest(case_id="demo_3d_danang_complex", time_budget_seconds=8.0))
    assert batch.candidates
    result = batch.candidates[0].result
    assert result.status == "SUCCESS" and not result.unassigned_orders
    route, = result.routes
    assert route.vehicle_id == "truck-3d-01" and route.driver_id == "driver-3d-01"
    assert route.spatial_validation.is_valid
    states = route.spatial_validation.step_states
    assert len(route.stops) == len(states) == 16

    previous = {}
    peak_volume_cm3 = 0.0
    max_z = 0.0
    supported_by_base = set()
    tier3_items = set()
    rotated_k08 = False
    for stop, state in zip(route.stops, states):
        assert stop.stop_type == state.stop_type
        assert state.is_valid and state.current_weight_kg <= vehicle.payload_limit_kg
        current = {
            i.item_id: (i.x, i.y, i.z, i.length_cm, i.width_cm, i.height_cm, i.support_item_id)
            for i in state.placed_items
        }
        for item_id in current.keys() & previous.keys():
            assert current[item_id] == previous[item_id]
        for item_id, (x, y, z, length, width, height, sup) in current.items():
            assert 0 <= x <= vehicle.length_cm - length + 0.01
            assert 0 <= y <= vehicle.width_cm - width + 0.01
            assert 0 <= z <= vehicle.height_cm - height + 0.01
            max_z = max(max_z, z)
            if sup == "K01-SAN-60":
                supported_by_base.add(item_id)
            if z > 90:
                tier3_items.add(item_id)
            if item_id == "K08-TRUNG-140" and (length, width) == (140.0, 115.0):
                rotated_k08 = True
        for a, b in combinations(state.placed_items, 2):
            x_ov = a.x < b.x + b.length_cm - 0.01 and b.x < a.x + a.length_cm - 0.01
            y_ov = a.y < b.y + b.width_cm - 0.01 and b.y < a.y + a.width_cm - 0.01
            z_ov = a.z < b.z + b.height_cm - 0.01 and b.z < a.z + a.height_cm - 0.01
            assert not (x_ov and y_ov and z_ov)
        step_vol = sum(i.length_cm * i.width_cm * i.height_cm for i in state.placed_items)
        peak_volume_cm3 = max(peak_volume_cm3, step_vol)
        previous = current

    assert not previous
    assert peak_volume_cm3 > vehicle_vol_cm3 * 0.80
    assert max_z > 100
    assert len(supported_by_base) >= 2
    assert len(tier3_items) >= 3
    assert rotated_k08

    # Turning off 3D stacking cannot fit all packages onto the single vehicle
    batch_2d = run_demo_case(
        DemoRunRequest(case_id="demo_3d_danang_complex", demo_stacking_enabled=False, time_budget_seconds=4.0)
    )
    assert not batch_2d.candidates or batch_2d.candidates[0].result.status != "SUCCESS"


def test_demo_run_applies_production_settings_overrides():
    batch = run_demo_case(
        DemoRunRequest(
            custom_request=archived_case("scenario_stack_cost_comparison"),
            demo_stacking_enabled=True,
            demo_stacking_owner_mode="SAME_CUSTOMER",
            demo_stacking_max_tiers=4,
            demo_stacking_lift_clearance_cm=6.0,
            demo_stacking_max_top_load_percent=35,
            time_budget_seconds=4.0,
            max_time_seconds=20,
            policy_overrides={"fuel_price_per_liter_vnd": 30000},
        )
    )
    assert batch.candidates
    route = batch.candidates[0].result.routes[0]
    assert route.spatial_validation.demo_stacking.max_tiers == 4
    assert route.spatial_validation.demo_stacking.lift_clearance_cm == 6.0
    assert route.spatial_validation.demo_stacking.max_top_load_percent == 35
    assert route.spatial_validation.demo_stacking.owner_mode == "SAME_CUSTOMER"


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
