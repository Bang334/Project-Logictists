import json
from pathlib import Path
from types import SimpleNamespace

import benchmark_hybrid_regression as benchmark_module
from app.models import FleetOptimizationRequest
from benchmark_hybrid_regression import run_case


def test_best_known_manifest_has_one_valid_record_per_case() -> None:
    manifest_path = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "best_known_results.json"
    )
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert payload["schema_version"] == 2
    assert payload["search_budget_sec"] == 10.0
    assert payload["contract_profile"] == "algo_lab_legacy"
    cases = payload["cases"]
    assert len(cases) == 12
    assert len({case["file"] for case in cases}) == len(cases)
    assert all(case["audit"] == "PASS" for case in cases)
    assert all(case["served"] == case["orders"] for case in cases)
    assert all(case["cost_vnd"] > 0 for case in cases)

    case_directory = manifest_path.parent / "cases"
    for case in cases:
        case_path = case_directory / case["file"]
        assert case_path.is_file()
        case_payload = json.loads(case_path.read_text(encoding="utf-8"))
        # Five generated lab fixtures carry descriptive benchmark metadata that
        # is deliberately not part of the strict production request contract.
        case_payload.pop("scenario_profile", None)
        request = FleetOptimizationRequest.model_validate(case_payload)
        assert len(request.orders) == case["orders"]

    hanoi = next(
        case for case in cases if case["file"] == "db_hanoi_16_orders.json"
    )
    assert hanoi["cost_comparable_to_production"] is False
    assert "service_day_index" in hanoi["comparison_note"]


def test_production_hybrid_replays_small_preserved_case() -> None:
    manifest_path = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "best_known_results.json"
    )
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    reference = next(
        case
        for case in payload["cases"]
        if case["file"] == "db_nhatrang_2_orders.json"
    )

    result = run_case(
        reference,
        seed=int(reference["seed"]),
        budget_seconds=0.5,
    )

    assert result.production_valid is True
    assert result.served == result.orders
    assert result.cost_vnd == result.reference_cost_vnd


def test_benchmark_reuses_recorded_search_budget_not_historical_elapsed_time(
    monkeypatch,
) -> None:
    captured = {}

    class Result:
        served = 18
        production_valid = True
        cost_vnd = 1
        elapsed_seconds = 1.0

    def fake_run_case(reference, *, seed, budget_seconds, cost_tolerance_percent):
        captured["reference"] = reference
        captured["seed"] = seed
        captured["budget_seconds"] = budget_seconds
        return Result()

    monkeypatch.setattr(benchmark_module, "run_case", fake_run_case)

    benchmark_module.run_benchmark(
        case_names=["scenario_7_multi_depot_overnight.json"]
    )

    assert captured["budget_seconds"] == 10.0
    assert captured["reference"]["search_budget_sec"] == 10.0
    assert captured["reference"]["time_sec"] == 10.28


def test_non_comparable_legacy_case_is_reported_as_not_applicable(
    monkeypatch,
) -> None:
    request = SimpleNamespace(orders=[object()])
    response = SimpleNamespace(
        unassigned_orders=[],
        routes=[
            SimpleNamespace(
                spatial_validation=SimpleNamespace(is_valid=True)
            )
        ],
        total_cost_vnd=200,
        total_distance_km=1.0,
        status="SUCCESS",
    )

    class FakeOptimizer:
        def __init__(self, *_args, **_kwargs):
            pass

        def solve(self):
            return response

    monkeypatch.setattr(benchmark_module, "load_request", lambda _file: request)
    monkeypatch.setattr(
        benchmark_module, "PackingAwareHybridALNSOptimizer", FakeOptimizer
    )

    result = run_case(
        {
            "file": "legacy.json",
            "algorithm": "Hybrid ALNS",
            "served": 1,
            "cost_vnd": 100,
            "cost_comparable_to_production": False,
        },
        seed=1,
        budget_seconds=0.1,
    )

    assert result.production_valid is True
    assert result.cost_ratio == 2.0
    assert result.cost_comparable is False
    assert result.meets_reference is None
