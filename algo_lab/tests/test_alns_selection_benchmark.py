import json

import pytest

from algo_lab.run_alns_selection_benchmark import (
    ALGORITHM_NAMES,
    DATASETS,
    HYBRID_ALNS_NAME,
    STANDARD_ALNS_NAME,
    _identify_weak_cases,
    _load_weak_case_seeds,
)


def _row(algorithm, seed, cost, audit="PASS", served=10, orders=10):
    return {
        "dataset": "Dataset",
        "file": "dataset.json",
        "algorithm": algorithm,
        "seed": seed,
        "cost_vnd": cost,
        "audit": audit,
        "served": served,
        "orders": orders,
    }


def test_selection_contains_both_alns_variants_and_reliable_challengers() -> None:
    assert len(DATASETS) == 12
    assert ALGORITHM_NAMES == [
        STANDARD_ALNS_NAME,
        HYBRID_ALNS_NAME,
        "Packing-aware VNS",
        "Packing-aware Simulated Annealing",
        "Packing-aware GRASP",
        "Packing-aware Memetic Search",
    ]


def test_weak_cases_include_invalid_and_more_expensive_hybrid_results() -> None:
    results = [
        {
            "dataset_index": 0,
            "dataset": "Dataset",
            "file": "dataset.json",
            "rows": [
                _row(HYBRID_ALNS_NAME, 0, 90, audit="FAIL"),
                _row("Packing-aware VNS", 0, 100),
                _row(HYBRID_ALNS_NAME, 1, 120),
                _row("Packing-aware VNS", 1, 100),
                _row(HYBRID_ALNS_NAME, 2, 100),
                _row("Packing-aware VNS", 2, 100),
            ],
        }
    ]

    weak = _identify_weak_cases(results)

    assert [(row["seed"], row["reason"]) for row in weak] == [
        (0, "PRIMARY_NOT_FULL_VALID"),
        (1, "HIGHER_COST"),
    ]
    assert weak[1]["best_competitor"] == "Packing-aware VNS"
    assert weak[1]["cost_gap_percent"] == 20.0
    assert weak[0]["best_competitor"] == "Packing-aware VNS"
    assert weak[0]["focus"] == "VALIDATION_OR_REPAIR"
    assert weak[1]["focus"] == "ROUTE_SEQUENCE_OR_ORDER_ASSIGNMENT"


def test_weak_case_file_restricts_rerun_to_exact_dataset_seeds(tmp_path) -> None:
    path = tmp_path / "weak.json"
    path.write_text(
        json.dumps(
            [
                {"file": "scenario_4_tight_windows.json", "seed": 2},
                {"file": "scenario_4_tight_windows.json", "seed": 0},
                {"file": "db_hanoi_16_orders.json", "seed": 1},
            ]
        ),
        encoding="utf-8",
    )

    selected = _load_weak_case_seeds(path)

    assert selected == {
        "db_hanoi_16_orders.json": [1],
        "scenario_4_tight_windows.json": [0, 2],
    }


def test_empty_weak_case_file_is_detectable(tmp_path) -> None:
    path = tmp_path / "weak.json"
    path.write_text("[]", encoding="utf-8")

    assert _load_weak_case_seeds(path) == {}


def test_weak_case_file_rejects_unknown_dataset(tmp_path) -> None:
    path = tmp_path / "weak.json"
    path.write_text(
        json.dumps([{"file": "unknown.json", "seed": 0}]),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="Dataset không hợp lệ"):
        _load_weak_case_seeds(path)
