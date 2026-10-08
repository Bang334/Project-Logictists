import copy
from pathlib import Path
from typing import List

import pytest

from algo_lab.algorithms.advanced_metaheuristics import (
    PackingAwareVNSSolver,
    solve_grasp,
    solve_ils,
    solve_late_acceptance,
    solve_memetic,
    solve_simulated_annealing,
    solve_tabu,
    solve_vns,
)
from algo_lab.common.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    LocationPoint,
    OrderPair,
)
from algo_lab.common.data_loader import load_dataset
from algo_lab.common.solution_validator import repair_and_audit_solution


DATASET_DIR = Path(__file__).resolve().parents[1] / "datasets"


def _problem():
    depot = LocationPoint("depot", "Depot")
    vehicles = [
        FleetVehicle(
            id="vehicle-1",
            plate_number="TEST-1",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=2_000,
            depot=depot,
        ),
        FleetVehicle(
            id="vehicle-2",
            plate_number="TEST-2",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=2_000,
            depot=depot,
        ),
    ]
    drivers = [
        DriverOption(id="driver-1", full_name="Driver 1"),
        DriverOption(id="driver-2", full_name="Driver 2"),
    ]
    orders: List[OrderPair] = []
    node_ids = ["depot"]
    for index in range(3):
        order_id = f"order-{index}"
        pickup_id = f"pickup-{index}"
        delivery_id = f"delivery-{index}"
        node_ids.extend([pickup_id, delivery_id])
        orders.append(
            OrderPair(
                id=order_id,
                order_number=f"ORD-{index}",
                pickup_location=LocationPoint(pickup_id, pickup_id),
                delivery_location=LocationPoint(delivery_id, delivery_id),
                items=[
                    CargoItem(
                        id=f"item-{index}",
                        order_id=order_id,
                        length_cm=100,
                        width_cm=100,
                        height_cm=100,
                        weight_kg=100,
                    )
                ],
                service_time_sec=30,
                pickup_window_end_sec=10_000,
                delivery_window_end_sec=10_000,
            )
        )
    matrix = [
        [0 if row == col else 100 + abs(row - col) * 10 for col in range(len(node_ids))]
        for row in range(len(node_ids))
    ]
    return (
        vehicles,
        drivers,
        orders,
        CostPolicy(unassigned_order_penalty_vnd=10_000_000),
        matrix,
        matrix,
        {node_id: index for index, node_id in enumerate(node_ids)},
    )


@pytest.mark.parametrize(
    "solver",
    [
        solve_vns,
        solve_tabu,
        solve_ils,
        solve_late_acceptance,
        solve_simulated_annealing,
        solve_grasp,
        solve_memetic,
    ],
)
def test_advanced_solver_returns_audited_fully_served_solution(solver) -> None:
    solution = solver(*_problem(), time_limit_sec=0.35, random_seed=7)

    assert solution.solution_audited is True
    assert solution.fulfillment_rate == 100.0
    assert solution.is_contract_valid is True
    assert solution.is_temporally_valid is True
    assert solution.is_spatial_valid is True
    assert solution.validation_notes == []


@pytest.mark.parametrize(
    "solver",
    [
        solve_vns,
        solve_tabu,
        solve_ils,
        solve_late_acceptance,
        solve_simulated_annealing,
        solve_grasp,
        solve_memetic,
    ],
)
def test_advanced_solver_rejects_non_positive_time_budget(solver) -> None:
    with pytest.raises(ValueError, match="time_limit_sec"):
        solver(*_problem(), time_limit_sec=0, random_seed=7)


def test_vns_keeps_a_production_valid_incumbent_when_cheapest_plan_hits_search_limit() -> None:
    args = load_dataset(str(DATASET_DIR / "scenario_2_heavy_cargo.json"))

    solution = solve_vns(*args, time_limit_sec=10.0, random_seed=0)
    audit = repair_and_audit_solution(
        solution,
        *args,
        spatial_time_limit_sec=5.0,
        repair_time_limit_sec=8.0,
    )

    assert audit.is_valid is True, audit.issues
    assert solution.fulfillment_rate == 100.0


def test_vns_repairs_a_low_cost_elite_before_using_the_valid_fallback() -> None:
    args = load_dataset(str(DATASET_DIR / "scenario_4_tight_windows.json"))

    solution = solve_vns(*args, time_limit_sec=10.0, random_seed=0)

    assert solution.is_contract_valid is True, solution.validation_notes
    assert solution.is_temporally_valid is True, solution.validation_notes
    assert solution.is_spatial_valid is True, solution.validation_notes
    assert solution.fulfillment_rate == 100.0
    assert solution.real_economic_cost_vnd < 3_000_000


@pytest.mark.parametrize(
    "kwargs,error_name",
    [
        ({"final_spatial_time_limit_sec": 0}, "final_spatial_time_limit_sec"),
        ({"final_repair_time_limit_sec": 0}, "final_repair_time_limit_sec"),
        ({"max_elite_audit_candidates": 0}, "max_elite_audit_candidates"),
    ],
)
def test_vns_rejects_invalid_final_audit_configuration(kwargs, error_name) -> None:
    with pytest.raises(ValueError, match=error_name):
        solve_vns(*_problem(), time_limit_sec=0.1, random_seed=7, **kwargs)


def test_vns_preserves_a_global_improvement_created_by_shake() -> None:
    solver = PackingAwareVNSSolver(
        *_problem(),
        time_limit_sec=5.0,
        max_iterations=4,
        random_seed=7,
    )
    initial_routes, initial_unassigned = solver._initial_state()
    initial_routes[0][0].test_plan_cost = 100
    solver._initial_state = lambda: (
        copy.deepcopy(initial_routes),
        list(initial_unassigned),
    )
    solver._plan_cost = lambda routes, _unassigned: int(
        getattr(next(stop for route in routes for stop in route), "test_plan_cost")
    )
    solver.destroy_operators = {
        name: (lambda routes, _count: (routes, []))
        for name in solver.destroy_operators
    }
    solver._best_relocation = lambda _routes, _unassigned, _deadline: None
    solver._destroy_random = lambda routes, _count: (routes, [])
    repair_calls = 0

    def scripted_repair(routes, pool, _operator, _deadline):
        nonlocal repair_calls
        repair_calls += 1
        repaired = copy.deepcopy(routes)
        if repair_calls == 5:
            repaired[0][0].test_plan_cost = 50
        return repaired, list(pool)

    solver._repair = scripted_repair
    captured_costs = []

    def capture_candidates(candidates, fallback, started_at, solver_name, **_kwargs):
        captured_costs.extend(cost for cost, _routes, _unassigned in candidates)
        _, routes, unassigned = fallback
        return solver._finalize(routes, unassigned, started_at, solver_name)

    solver._finalize_best_valid = capture_candidates

    solver.solve()

    assert 50 in captured_costs


@pytest.mark.parametrize(
    "time_limit_sec,base_seed,expected",
    [
        (9.99, 3, (3,)),
        (10.0, 3, (3,)),
        (19.99, 3, (3,)),
        (20.0, 3, (3, 8)),
        (60.0, 3, (3, 8)),
    ],
)
def test_vns_restart_policy_keeps_at_least_ten_seconds_per_start(
    time_limit_sec, base_seed, expected
) -> None:
    assert PackingAwareVNSSolver._restart_seeds(time_limit_sec, base_seed) == expected


@pytest.mark.parametrize(
    "time_limit_sec,expected",
    [
        (10.0, (10.0,)),
        (20.0, (10.0, 10.0)),
        (30.0, (15.0, 15.0)),
        (60.0, (30.0, 30.0)),
    ],
)
def test_vns_gives_long_budget_remainder_to_diversification_start(
    time_limit_sec, expected
) -> None:
    assert PackingAwareVNSSolver._restart_budgets(time_limit_sec) == expected
