import pytest
from app.demo import (
    list_demo_cases,
    get_demo_case_payload,
    run_demo_case,
    DemoRunRequest,
)


def test_list_demo_cases():
    cases = list_demo_cases()
    assert len(cases) == 17
    ids = {c.id for c in cases}
    assert "novel_1_mekong_hub_spoke" in ids
    assert "novel_2_long_narrow_timber" in ids
    assert "scenario_1_multi_item" in ids
    assert "db_nhatrang_2_orders" in ids

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
