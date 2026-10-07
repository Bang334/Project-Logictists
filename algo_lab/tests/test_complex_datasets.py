import json
from pathlib import Path

import pytest

from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.solution_validator import repair_and_audit_solution
from algo_lab.generate_complex_scenarios import SCENARIOS


DATASET_DIR = Path(__file__).resolve().parents[1] / "datasets"


@pytest.mark.parametrize("filename,_factory", SCENARIOS)
def test_complex_dataset_contract_and_physical_fit(filename, _factory) -> None:
    path = DATASET_DIR / filename
    raw = json.loads(path.read_text(encoding="utf-8"))
    vehicles, drivers, orders, _policy, distance, duration, node_map = load_dataset(
        str(path)
    )

    expected_nodes = len(vehicles) + 2 * len(orders)
    assert raw["scenario_profile"]["generated"] is True
    assert len(drivers) >= len(vehicles)
    assert len(distance) == expected_nodes
    assert len(duration) == expected_nodes
    assert all(len(row) == expected_nodes for row in distance)
    assert all(len(row) == expected_nodes for row in duration)
    assert len(node_map) == expected_nodes

    ids = [vehicle.depot.id for vehicle in vehicles]
    ids.extend(order.pickup_location.id for order in orders)
    ids.extend(order.delivery_location.id for order in orders)
    assert len(ids) == len(set(ids))

    for order in orders:
        assert order.items
        assert order.pickup_window_start_sec <= order.pickup_window_end_sec
        assert order.delivery_window_start_sec <= order.delivery_window_end_sec
        for item in order.items:
            assert any(
                item.height_cm <= vehicle.height_cm
                and item.weight_kg <= vehicle.payload_limit_kg
                and (
                    (
                        item.length_cm <= vehicle.length_cm
                        and item.width_cm <= vehicle.width_cm
                    )
                    or (
                        item.width_cm <= vehicle.length_cm
                        and item.length_cm <= vehicle.width_cm
                    )
                )
                for vehicle in vehicles
            )


def test_dense_fragmentation_solution_is_resequenced_before_final_audit() -> None:
    args = load_dataset(str(DATASET_DIR / "scenario_8_dense_fragmentation.json"))
    solution = solve_greedy(*args)

    audit = repair_and_audit_solution(
        solution,
        *args,
        spatial_time_limit_sec=1.5,
        repair_time_limit_sec=5.0,
    )

    assert audit.is_valid is True, audit.issues
    assert solution.fulfillment_rate == 100.0
