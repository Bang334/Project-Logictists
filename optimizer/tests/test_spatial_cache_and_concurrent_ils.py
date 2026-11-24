import json
from pathlib import Path
from unittest.mock import patch

from app.models import (
    CargoItem,
    FleetOptimizationRequest,
    SpatialValidationResult,
    StopAction,
    VehicleFloor,
    default_stacking_policy,
)
from app.multi_start import MultiStartFleetOptimizer, is_fully_served
from app.spatial_cache import SpatialValidationCache, get_active_spatial_cache, scoped_spatial_cache
from app.stacking import validate_stop_actions


def _sample_vehicle() -> VehicleFloor:
    return VehicleFloor(
        id="veh-cache-1",
        plate_number="51C-888.88",
        length_cm=420,
        width_cm=190,
        height_cm=190,
        payload_limit_kg=3500,
    )


def _sample_actions(stop_suffix: str = "a") -> list[StopAction]:
    item = CargoItem(
        id="pkg-cache-1",
        order_id="ord-cache-1",
        length_cm=80,
        width_cm=60,
        height_cm=50,
        weight_kg=40,
    )
    return [
        StopAction(
            stop_id=f"p-{stop_suffix}",
            sequence=1,
            stop_type="PICKUP",
            address=f"Pickup {stop_suffix}",
            items_to_load=[item],
            items_to_unload=[],
        ),
        StopAction(
            stop_id=f"d-{stop_suffix}",
            sequence=2,
            stop_type="DELIVERY",
            address=f"Delivery {stop_suffix}",
            items_to_load=[],
            items_to_unload=["pkg-cache-1"],
        ),
    ]


def test_scoped_spatial_cache_reuses_valid_layout_and_updates_stop_metadata():
    vehicle = _sample_vehicle()
    policy = default_stacking_policy()
    calls = 0

    from app import stacking as stacking_mod

    orig_validate_stops = stacking_mod.DemoStacks.validate_stops

    def tracked_validate_stops(self, validator, stops):
        nonlocal calls
        calls += 1
        return orig_validate_stops(self, validator, stops)

    with patch.object(stacking_mod.DemoStacks, "validate_stops", tracked_validate_stops):
        with scoped_spatial_cache() as cache:
            res1 = validate_stop_actions(policy, vehicle, _sample_actions("first"))
            res2 = validate_stop_actions(policy, vehicle, _sample_actions("second"))
            assert res1.is_valid is True
            assert res2.is_valid is True
            assert calls == 1
            assert cache.misses == 1
            assert cache.hits == 1
            assert res2.step_states[0].stop_id == "p-second"
            assert "Delivery second" in res2.step_states[1].action_description

    assert get_active_spatial_cache() is None


def test_spatial_cache_ignores_search_limit_failures_and_tighter_bounds():
    cache = SpatialValidationCache(max_entries=16)
    vehicle = _sample_vehicle()
    actions = _sample_actions("lim")
    key = cache.build_key(None, vehicle, actions)

    limit_res = SpatialValidationResult(
        is_valid=False,
        violation_code="PLACEMENT_SEARCH_LIMIT_REACHED",
        error_message="Budget exceeded",
    )
    cache.put(key, limit_res, max_search_nodes=256, max_time_seconds=0.1)
    assert cache.get(key, actions, max_search_nodes=256, max_time_seconds=0.1) is None

    strict_infeasible = SpatialValidationResult(
        is_valid=False,
        violation_code="NO_FEASIBLE_LAYOUT",
        error_message="Too large",
    )
    cache.put(key, strict_infeasible, max_search_nodes=256, max_time_seconds=0.2)
    # Higher search bounds must bypass a smaller-bound infeasible cache entry.
    assert cache.get(key, actions, max_search_nodes=20_000, max_time_seconds=0.2) is None
    assert cache.get(key, actions, max_search_nodes=256, max_time_seconds=1.0) is None
    assert cache.get(key, actions, max_search_nodes=256, max_time_seconds=0.2) is not None


def test_multi_start_runs_concurrent_ils_on_headroom_dataset():
    ds_path = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "datasets_10_20261123"
        / "dataset_01_005_orders_03_fleet.json"
    )
    req = FleetOptimizationRequest.model_validate_json(ds_path.read_text(encoding="utf-8"))
    req = req.model_copy(update={"search_time_seconds": 8, "max_time_seconds": 22})

    batch = MultiStartFleetOptimizer(req).solve(max_candidates=3)
    expected = {o.id: {it.id for it in o.items} for o in req.orders}

    assert batch.candidates
    assert batch.solver_run_count >= 2
    assert any("Đa họ thuật toán" in d for d in batch.diagnostics)
    assert all(
        is_fully_served(
            c.result,
            set(expected),
            max_routes_per_day=req.policy.max_routes_per_day,
            expected_items=expected,
        )
        for c in batch.candidates
    )


def test_short_budget_below_8s_stays_in_process_and_succeeds():
    ds_path = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "datasets_10_20261123"
        / "dataset_01_005_orders_03_fleet.json"
    )
    req = FleetOptimizationRequest.model_validate_json(ds_path.read_text(encoding="utf-8"))
    req = req.model_copy(update={"search_time_seconds": 6, "max_time_seconds": 18})

    batch = MultiStartFleetOptimizer(req).solve(max_candidates=3)
    assert batch.candidates
    assert not any("Đa họ thuật toán" in d for d in batch.diagnostics)


def _cycle_actions(
    item_id: str,
    order_id: str,
    prefix: str,
    *,
    length_cm: float = 80,
    width_cm: float = 60,
    height_cm: float = 50,
    weight_kg: float = 40,
    start_seq: int = 1,
) -> list[StopAction]:
    item = CargoItem(
        id=item_id,
        order_id=order_id,
        length_cm=length_cm,
        width_cm=width_cm,
        height_cm=height_cm,
        weight_kg=weight_kg,
    )
    return [
        StopAction(
            stop_id=f"p-{prefix}",
            sequence=start_seq,
            stop_type="PICKUP",
            address=f"Pickup {prefix}",
            items_to_load=[item],
            items_to_unload=[],
        ),
        StopAction(
            stop_id=f"d-{prefix}",
            sequence=start_seq + 1,
            stop_type="DELIVERY",
            address=f"Delivery {prefix}",
            items_to_load=[],
            items_to_unload=[item_id],
        ),
    ]


def test_scoped_spatial_cache_reuses_independent_cycles_across_partial_edits():
    from app import stacking as stacking_mod

    vehicle = _sample_vehicle()
    policy = default_stacking_policy()
    calls = 0
    orig_validate_stops = stacking_mod.DemoStacks.validate_stops

    def tracked_validate_stops(self, validator, stops):
        nonlocal calls
        calls += 1
        return orig_validate_stops(self, validator, stops)

    route_a = (
        _cycle_actions("pkg-c1", "ord-c1", "a1", weight_kg=40, start_seq=1)
        + _cycle_actions("pkg-c2", "ord-c2", "a2", weight_kg=85, start_seq=3)
    )
    route_b = (
        _cycle_actions("pkg-c1", "ord-c1", "b1", weight_kg=40, start_seq=1)
        + _cycle_actions("pkg-c3", "ord-c3", "b2", length_cm=110, width_cm=70, weight_kg=120, start_seq=3)
    )

    with patch.object(stacking_mod.DemoStacks, "validate_stops", tracked_validate_stops):
        with scoped_spatial_cache() as cache:
            res_a = validate_stop_actions(policy, vehicle, route_a)
            res_b = validate_stop_actions(policy, vehicle, route_b)
            assert res_a.is_valid is True
            assert res_b.is_valid is True
            assert calls == 3
            assert cache.misses == 3
            assert cache.hits == 1
            assert [s.step_index for s in res_b.step_states] == [1, 2, 3, 4]
            assert [s.stop_id for s in res_b.step_states] == ["p-b1", "d-b1", "p-b2", "d-b2"]
            assert res_b.max_weight_kg == 120.0


def test_scoped_spatial_cache_cycles_preserve_2d_reuse_and_invalid_cycle_diagnostics():
    from app.spatial_validator import SpatialValidator

    vehicle = _sample_vehicle()
    calls = 0
    orig_validate_plan = SpatialValidator.validate_plan

    def tracked_validate_plan(self, stops):
        nonlocal calls
        calls += 1
        return orig_validate_plan(self, stops)

    route_ok = (
        _cycle_actions("pkg-2d-1", "ord-1", "ok1", weight_kg=50, start_seq=1)
        + _cycle_actions("pkg-2d-2", "ord-2", "ok2", weight_kg=70, start_seq=3)
    )
    route_bad_cycle2 = (
        _cycle_actions("pkg-2d-1", "ord-1", "retry1", weight_kg=50, start_seq=1)
        + _cycle_actions(
            "pkg-2d-huge",
            "ord-3",
            "bad2",
            length_cm=500,
            width_cm=300,
            weight_kg=90,
            start_seq=3,
        )
    )

    with patch.object(SpatialValidator, "validate_plan", tracked_validate_plan):
        with scoped_spatial_cache() as cache:
            res_ok = validate_stop_actions(None, vehicle, route_ok)
            res_bad = validate_stop_actions(None, vehicle, route_bad_cycle2)
            assert res_ok.is_valid is True
            assert res_bad.is_valid is False
            assert calls == 3
            assert cache.hits == 1
            assert len(res_bad.step_states) >= 2
            assert [s.step_index for s in res_bad.step_states[:2]] == [1, 2]
            assert res_bad.step_states[0].stop_id == "p-retry1"
            assert res_bad.max_weight_kg == 50.0

    # Malformed duplicate unload must stay unsplit and fail contract validation cleanly.
    bad_contract = [
        StopAction(
            stop_id="p-err",
            sequence=1,
            stop_type="PICKUP",
            address="P",
            items_to_load=[],
            items_to_unload=["missing-pkg"],
        )
    ]
    with scoped_spatial_cache():
        err_res = validate_stop_actions(default_stacking_policy(), vehicle, bad_contract)
        assert err_res.is_valid is False


def test_spatial_cache_preserves_fractional_payload_precision():
    vehicle_100 = _sample_vehicle().model_copy(update={"payload_limit_kg": 100.0})
    vehicle_under = _sample_vehicle().model_copy(update={"payload_limit_kg": 99.99998})
    actions = _cycle_actions("pkg-100", "ord-100", "w100", weight_kg=100.0)

    with scoped_spatial_cache() as cache:
        res_ok = validate_stop_actions(None, vehicle_100, actions)
        res_over = validate_stop_actions(None, vehicle_under, actions)
        assert res_ok.is_valid is True
        assert res_over.is_valid is False
        assert cache.hits == 0


def test_spatial_cache_enforces_shared_route_deadline_across_cycles():
    vehicle = _sample_vehicle()
    actions = []
    for idx in range(100):
        seq = idx * 2 + 1
        actions.extend(
            _cycle_actions(f"pkg-dl-{idx}", f"ord-dl-{idx}", f"dl{idx}", weight_kg=10.0, start_seq=seq)
        )

    import time

    with scoped_spatial_cache():
        started = time.perf_counter()
        res = validate_stop_actions(
            default_stacking_policy(),
            vehicle,
            actions,
            max_time_seconds=0.001,
        )
        elapsed = time.perf_counter() - started
        assert res.is_valid is False
        assert res.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED"
        assert len(res.step_states) < len(actions)
        assert elapsed < 0.03


def test_spatial_cache_does_not_leak_stale_stop_error_metadata_across_positions():
    vehicle = _sample_vehicle().model_copy(update={"payload_limit_kg": 100.0})
    route_at_stop_3 = (
        _cycle_actions("pkg-light", "ord-light", "ok", weight_kg=20.0, start_seq=1)
        + _cycle_actions("pkg-heavy", "ord-heavy", "heavy-a", weight_kg=150.0, start_seq=3)
    )
    route_at_stop_5 = (
        _cycle_actions("pkg-light", "ord-light", "ok", weight_kg=20.0, start_seq=1)
        + _cycle_actions("pkg-mid", "ord-mid", "mid", weight_kg=25.0, start_seq=3)
        + _cycle_actions("pkg-heavy", "ord-heavy", "heavy-b", weight_kg=150.0, start_seq=5)
    )

    with scoped_spatial_cache():
        res_3 = validate_stop_actions(None, vehicle, route_at_stop_3)
        res_5 = validate_stop_actions(None, vehicle, route_at_stop_5)
        assert res_3.is_valid is False
        assert res_5.is_valid is False
        assert "Stop 5" in (res_5.error_message or "") or res_5.violation_code == "PAYLOAD_LIMIT_EXCEEDED"
        assert "Stop 3" not in (res_5.error_message or "")
        for state in res_5.step_states:
            if state.stop_id == "p-heavy-b":
                assert "Stop 5" in state.action_description
                assert "Stop 3" not in state.action_description
