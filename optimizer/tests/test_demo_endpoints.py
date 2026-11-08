import pytest
from app.demo import (
    list_demo_cases,
    get_demo_case_payload,
    run_demo_case,
    DemoRunRequest,
)


def test_list_demo_cases():
    cases = list_demo_cases()
    assert len(cases) == 19
    ids = {c.id for c in cases}
    assert "novel_1_mekong_hub_spoke" in ids
    assert "novel_2_long_narrow_timber" in ids
    assert "scenario_1_multi_item" in ids
    assert "db_nhatrang_2_orders" in ids
    assert next(case for case in cases if case.id == "scenario_stack_cost_comparison").supports_stacking

    for case in cases:
        assert case.orders_count > 0
        assert case.vehicles_count > 0
        assert case.category in ("NOVEL", "SCENARIO", "REAL_DATA")
        assert len(case.name) > 0
        assert case.suggested_time_limit_sec > 0


def test_get_demo_case_payload():
    payload = get_demo_case_payload("db_nhatrang_2_orders")
    assert isinstance(payload, dict)
    assert "orders" in payload
    assert "vehicles" in payload
    assert len(payload["orders"]) == 2


def test_run_demo_case_nhatrang():
    req = DemoRunRequest(case_id="db_nhatrang_2_orders", time_budget_seconds=2.0)
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
        batch = run_demo_case(DemoRunRequest(case_id="scenario_stack_cost_comparison",
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
        batch = run_demo_case(DemoRunRequest(case_id="scenario_stack_customer_modes", demo_stacking_owner_mode=mode, time_budget_seconds=6))
        result = batch.candidates[0].result
        assert result.status == "SUCCESS" and len(result.routes) == 1
        return result.routes[0]

    same, any_customer = run("SAME_CUSTOMER"), run("ANY_CUSTOMER")
    assert [stop.location_id for stop in same.stops] == [stop.location_id for stop in any_customer.stops]
    assert all(item.z == 0 for state in same.spatial_validation.step_states for item in state.placed_items)
    assert any(item.item_id == "KIEN-B" and item.support_item_id == "KIEN-A"
               for state in any_customer.spatial_validation.step_states for item in state.placed_items)
