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
