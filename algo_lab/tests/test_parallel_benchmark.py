from algo_lab.run_parallel_benchmark import (
    ALGORITHM_NAMES,
    DATASETS,
    _aggregate,
    _markdown,
    _parse_seeds,
)


def _row(algorithm: str, audit: str, cost: int):
    return {
        "dataset": "Dataset",
        "file": "dataset.json",
        "algorithm": algorithm,
        "seed": 0,
        "time_sec": 1.0,
        "vehicles": 1,
        "served": 1,
        "orders": 1,
        "fulfillment_percent": 100.0,
        "cost_vnd": cost,
        "penalized_objective_vnd": cost,
        "distance_km": 1.0,
        "audit": audit,
        "issues": [],
    }


def test_aggregate_does_not_reward_invalid_zero_cost_results() -> None:
    datasets = []
    for index in range(7):
        datasets.append(
            {
                "dataset_index": index,
                "dataset": f"Dataset {index}",
                "rows": [
                    _row("Packing-aware VNS", "PASS", 100),
                    _row("Genetic Algorithm", "FAIL", 0),
                ],
            }
        )

    aggregate = _aggregate(datasets)

    assert aggregate[0]["algorithm"] == "Packing-aware VNS"
    assert aggregate[0]["pass_count"] == 7
    invalid = next(
        row for row in aggregate if row["algorithm"] == "Genetic Algorithm"
    )
    assert invalid["validated_served"] == 0
    assert invalid["validated_cost_vnd"] == 0

    report = _markdown(datasets, aggregate, 2.0, 5.0, 8.0, 3, 10.0)
    assert "| 0 | Genetic Algorithm | 1.00s | 1 | 1/1 (100.0%) | — |" in report
    assert "## Vấn đề phát hiện khi audit" in report
    assert "**Genetic Algorithm seed=0 (FAIL):**" in report


def test_benchmark_uses_ten_metaheuristics_and_twelve_datasets() -> None:
    assert ALGORITHM_NAMES == [
        "Standard ALNS",
        "Genetic Algorithm",
        "Hybrid ALNS",
        "Packing-aware VNS",
        "Packing-aware Tabu",
        "Packing-aware ILS",
        "Packing-aware Late Acceptance",
        "Packing-aware Simulated Annealing",
        "Packing-aware GRASP",
        "Packing-aware Memetic Search",
    ]
    assert len(DATASETS) == 12
    assert "Greedy" not in ALGORITHM_NAMES
    assert "OR-Tools" not in ALGORITHM_NAMES


def test_seed_parser_requires_unique_integer_seeds() -> None:
    assert _parse_seeds("0, 1,2") == [0, 1, 2]

    import argparse
    import pytest

    with pytest.raises(argparse.ArgumentTypeError):
        _parse_seeds("0,0")
    with pytest.raises(argparse.ArgumentTypeError):
        _parse_seeds("")


def test_aggregate_prioritizes_full_valid_stability_before_cost() -> None:
    reliable_rows = []
    cheap_but_invalid_rows = []
    for seed in (0, 1, 2):
        reliable = _row("Packing-aware VNS", "PASS", 110)
        reliable["seed"] = seed
        reliable_rows.append(reliable)
        risky = _row("Genetic Algorithm", "PASS" if seed < 2 else "FAIL", 90)
        risky["seed"] = seed
        cheap_but_invalid_rows.append(risky)

    aggregate = _aggregate(
        [{"dataset_index": 0, "dataset": "Dataset", "rows": reliable_rows + cheap_but_invalid_rows}]
    )

    assert aggregate[0]["algorithm"] == "Packing-aware VNS"
    assert aggregate[0]["full_valid_count"] == 3
    risky_summary = next(
        row for row in aggregate if row["algorithm"] == "Genetic Algorithm"
    )
    assert risky_summary["full_valid_count"] == 2
