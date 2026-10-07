from algo_lab.run_parallel_benchmark import (
    ALGORITHM_NAMES,
    DATASETS,
    _aggregate,
    _markdown,
)


def _row(algorithm: str, audit: str, cost: int):
    return {
        "dataset": "Dataset",
        "file": "dataset.json",
        "algorithm": algorithm,
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
                    _row("Greedy", "FAIL", 0),
                ],
            }
        )

    aggregate = _aggregate(datasets)

    assert aggregate[0]["algorithm"] == "Packing-aware VNS"
    assert aggregate[0]["pass_count"] == 7
    invalid = next(row for row in aggregate if row["algorithm"] == "Greedy")
    assert invalid["validated_served"] == 0
    assert invalid["validated_cost_vnd"] == 0

    report = _markdown(datasets, aggregate, 2.0, 5.0, 8.0, 3, 10.0)
    assert "| Greedy | 1.00s | 1 | 1/1 (100.0%) | — |" in report
    assert "— (chưa PASS đủ" in report
    assert "## Vấn đề phát hiện khi audit" in report
    assert "**Greedy (FAIL):**" in report


def test_benchmark_uses_six_algorithms_and_twelve_datasets() -> None:
    assert ALGORITHM_NAMES == [
        "Greedy",
        "Hybrid ALNS",
        "Packing-aware VNS",
        "Packing-aware Tabu",
        "Packing-aware ILS",
        "Packing-aware Late Acceptance",
    ]
    assert len(DATASETS) == 12
    assert "Standard ALNS" not in ALGORITHM_NAMES
    assert "Genetic Algorithm" not in ALGORITHM_NAMES
    assert "OR-Tools" not in ALGORITHM_NAMES
