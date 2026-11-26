from unittest.mock import patch

from app.models import CargoItem, StopAction, VehicleFloor
from app.spatial_validator import SpatialValidator
from benchmarks.algorithm_comparison.layout_certificate import verify_layout_certificate
from benchmarks.savings_warm_start.cycle_validator import CycleCachingSpatialValidator
from test_benchmark_contract import comparison_request


def test_exact_load_cycle_stops_after_candidate_generation_exceeds_its_budget(monkeypatch):
    from benchmarks.savings_warm_start import cycle_validator

    floor = VehicleFloor(
        id="v", plate_number="V", length_cm=600, width_cm=200,
        height_cm=180, payload_limit_kg=3000,
    )
    clock = [10.0]
    reference = SpatialValidator._candidate_placements

    def slow_candidates(validator, *args, **kwargs):
        clock[0] += 1.5
        return reference(validator, *args, **kwargs)

    monkeypatch.setattr(cycle_validator, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(SpatialValidator, "_candidate_placements", slow_candidates)
    validator = CycleCachingSpatialValidator(floor, max_time_seconds=1)
    result = validator.validate_plan(_load_cycle("parcel", 1))
    assert not result.is_valid
    assert result.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED"
    assert validator.cache_hits == 0


def test_timed_worker_caps_repeated_packing_calls_at_one_absolute_deadline(monkeypatch):
    from app import alns_engine
    from benchmarks.savings_warm_start import variant

    vehicle = comparison_request().vehicles[0]
    clock = [10.0]
    observed = []

    def record_budget(validator, _actions):
        observed.append(validator.max_time_seconds)

    monkeypatch.setattr(variant.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(CycleCachingSpatialValidator, "validate_plan", record_budget)
    with variant._fast_packing_context(True, validation_deadline=10.5):
        alns_engine.validate_stop_actions(None, vehicle, _load_cycle("parcel", 1), max_time_seconds=2)
        clock[0] = 10.4
        alns_engine.validate_stop_actions(None, vehicle, _load_cycle("parcel", 1), max_time_seconds=2)
    assert observed[0] == 0.5
    assert 0.09 < observed[1] < 0.11


def _load_cycle(cargo_id: str, sequence: int) -> list[StopAction]:
    cargo = CargoItem(
        id=cargo_id, order_id=cargo_id, length_cm=48, width_cm=44,
        height_cm=50, weight_kg=20,
    )
    return [
        StopAction(stop_id=f"{cargo_id}-p", sequence=sequence,
                   stop_type="PICKUP", items_to_load=[cargo]),
        StopAction(stop_id=f"{cargo_id}-d", sequence=sequence + 1,
                   stop_type="DELIVERY", items_to_unload=[cargo.id]),
    ]


def test_reuses_shifted_load_cycle_and_preserves_full_certificate():
    floor = VehicleFloor(
        id="v", plate_number="V", length_cm=600, width_cm=200,
        height_cm=180, payload_limit_kg=3000,
    )
    validator = CycleCachingSpatialValidator(floor)
    assert validator.validate_plan(_load_cycle("later", 1)).is_valid
    stops = _load_cycle("first", 1) + _load_cycle("later", 3)
    expected = SpatialValidator(floor).validate_plan(stops)
    with patch.object(
        SpatialValidator, "_validate_load_cycle", autospec=True,
        side_effect=SpatialValidator._validate_load_cycle,
    ) as exact_validate:
        actual = validator.validate_plan(stops)
        assert exact_validate.call_count == 1
    assert actual.is_valid
    assert actual.model_dump() == expected.model_dump()
    assert validator.cache_hits == 1
    assert validator.exact_searches == 2


def test_changed_geometry_cannot_reuse_certificate_and_failure_can_retry():
    floor = VehicleFloor(
        id="v", plate_number="V", length_cm=600, width_cm=200,
        height_cm=180, payload_limit_kg=3000,
    )
    validator = CycleCachingSpatialValidator(floor)
    assert validator.validate_plan(_load_cycle("cargo", 1)).is_valid
    changed = _load_cycle("cargo", 1)
    changed[0].items_to_load[0].length_cm = 700
    with patch.object(
        SpatialValidator, "_validate_load_cycle", autospec=True,
        side_effect=SpatialValidator._validate_load_cycle,
    ) as exact_validate:
        assert not validator.validate_plan(changed).is_valid
        assert not validator.validate_plan(changed).is_valid
        assert exact_validate.call_count == 2
    assert validator.cache_hits == 0
    assert validator.exact_searches == 3


def test_uniform_layout_has_an_independently_valid_witness_and_falls_back_for_mixed_sizes():
    vehicle = comparison_request().vehicles[0].model_copy(update={
        "length_cm": 600, "width_cm": 200, "height_cm": 180, "payload_limit_kg": 3000,
    })
    floor = VehicleFloor.model_validate(vehicle.model_dump(include=set(VehicleFloor.model_fields)))
    validator = CycleCachingSpatialValidator(floor, use_uniform_layout=True)
    first, delivery = _load_cycle("parcel", 1)
    items = [first.items_to_load[0].model_copy(update={"id": f"parcel-{i}"}) for i in range(12)]
    first.items_to_load = items
    delivery.items_to_unload = [item.id for item in items]
    result = validator.validate_plan([first, delivery])
    assert result.is_valid and validator.uniform_certificates == 1
    assert validator.exact_searches == 0
    assert verify_layout_certificate(
        vehicle, [first, delivery], [state.placed_items for state in result.step_states],
        [state.unload_sequence for state in result.step_states],
    ) is None

    items[0].width_cm = 35
    assert validator.validate_plan([first, delivery]).is_valid
    assert validator.uniform_certificates == 1 and validator.exact_searches == 1


def test_native_dynamic_candidates_match_reference_after_unloading():
    from app.hybrid_alns.models import CargoItem as NativeCargo, FleetVehicle, LocationPoint, PlacedItem
    from app.hybrid_alns.packing_checker import FastPackingChecker
    from benchmarks.savings_warm_start.dynamic_packing import FastDynamicPackingChecker

    vehicle = FleetVehicle(
        id="floor", plate_number="V", length_cm=125, width_cm=80, height_cm=100,
        payload_limit_kg=500, depot=LocationPoint(id="depot", name="depot", latitude=0, longitude=0),
    )
    baseline = FastPackingChecker(vehicle)
    optimized = FastDynamicPackingChecker(vehicle)
    onboard = []
    for index in range(60):
        if index % 3 == 0 and onboard:
            del onboard[-1]
        item = NativeCargo(
            str(index), "order", 18.5 + index % 5, 13.74 + index % 7, 20, 10,
            can_rotate=bool(index % 2),
        )
        expected = baseline._place_dynamic_box(item, onboard)
        actual = optimized._place_dynamic_box(item, onboard)
        assert actual == expected
        placed_items = [
            PlacedItem(box["id"], box["order_id"], box["x"], box["y"], box["l"], box["w"],
                       weight_kg=10, cargo_kind="FRAGILE" if slot % 5 == 0 else "STANDARD")
            for slot, box in enumerate(onboard)
        ]
        rank = index % 3
        assert optimized.find_placement(item, placed_items, rank, {"order": 1}) == (
            baseline.find_placement(item, placed_items, rank, {"order": 1})
        )
        if actual is not None:
            onboard.append(actual)
