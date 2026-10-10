from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
from types import SimpleNamespace

import app.multi_start as multi_start_module
import app.hybrid_alns_engine as hybrid_engine_module
import app.hybrid_alns.solver as hybrid_solver_module
from app.alns_engine import FastLIFOPackingChecker
from app.hybrid_alns.greedy_insertion import solve_greedy as solve_hybrid_greedy
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.ils_engine import PackingAwareILSOptimizer
from app.models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    OptimizedRoute,
    ScheduledStop,
    SpatialValidationResult,
)
from app.multi_start import MultiStartFleetOptimizer
from app.search_strategies import SEARCH_STRATEGIES


def _request(*, available_end_sec: int = 2_000) -> FleetOptimizationRequest:
    return FleetOptimizationRequest.model_validate(
        {
            "job_id": "ils-test",
            "vehicles": [
                {
                    "id": "vehicle-1",
                    "plate_number": "29H-001",
                    "length_cm": 400,
                    "width_cm": 200,
                    "height_cm": 200,
                    "payload_limit_kg": 2_000,
                    "available_start_sec": 0,
                    "available_end_sec": available_end_sec,
                    "depot": {
                        "id": "depot",
                        "name": "Kho",
                        "latitude": 21.0,
                        "longitude": 105.8,
                    },
                    "fuel_consumption_liters_per_100_km": 10,
                    "fixed_operating_cost_vnd": 50_000,
                }
            ],
            "drivers": [
                {
                    "id": "driver-1",
                    "full_name": "Tài xế 1",
                    "license_class": "C",
                    "fixed_salary_monthly_vnd": 10_000_000,
                    "trip_base_pay_vnd": 100_000,
                    "per_km_pay_vnd": 1_000,
                }
            ],
            "orders": [
                {
                    "id": "order-1",
                    "order_number": "ORD-1",
                    "pickup_location": {
                        "id": "pickup",
                        "name": "Điểm lấy",
                        "latitude": 21.01,
                        "longitude": 105.81,
                    },
                    "delivery_location": {
                        "id": "delivery",
                        "name": "Điểm giao",
                        "latitude": 21.02,
                        "longitude": 105.82,
                    },
                    "items": [
                        {
                            "id": "item-1",
                            "order_id": "order-1",
                            "length_cm": 100,
                            "width_cm": 80,
                            "height_cm": 60,
                            "weight_kg": 500,
                        }
                    ],
                    "service_time_sec": 60,
                    "pickup_window_start_sec": 300,
                    "pickup_window_end_sec": 600,
                    "delivery_window_start_sec": 500,
                    "delivery_window_end_sec": 900,
                }
            ],
            "policy": {
                "fuel_price_per_liter_vnd": 23_000,
                "monthly_working_minutes": 10_560,
            },
            "max_time_seconds": 2,
            "distance_matrix_meters": [
                [0, 1_000, 2_000],
                [1_000, 0, 1_000],
                [2_000, 1_000, 0],
            ],
            "duration_matrix_seconds": [
                [0, 100, 200],
                [100, 0, 100],
                [200, 100, 0],
            ],
        }
    )


def test_ils_returns_audited_timeline_with_waiting_and_return_leg() -> None:
    result = PackingAwareILSOptimizer(
        _request(), time_budget_seconds=0.2, random_seed=7
    ).solve()

    assert result.status == "SUCCESS"
    assert result.unassigned_orders == []
    assert len(result.routes) == 1
    route = result.routes[0]
    assert route.driver_id == "driver-1"
    assert route.spatial_validation.is_valid is True
    assert route.stops[0].arrival_time_sec == 300
    assert route.stops[0].travel_time_sec == 100
    assert route.stops[0].waiting_time_sec == 0
    assert route.stops[1].arrival_time_sec == 500
    assert route.stops[1].waiting_time_sec == 40
    assert route.start_time_sec == 200
    assert route.return_travel_time_sec == 200
    assert route.end_time_sec == 760
    assert route.total_duration_minutes == 9.3
    previous_departure = route.start_time_sec
    for stop in route.stops:
        assert stop.arrival_time_sec - previous_departure == (
            stop.travel_time_sec + stop.waiting_time_sec
        )
        assert (
            stop.departure_time_sec - stop.arrival_time_sec
            == stop.service_time_sec
        )
        previous_departure = stop.departure_time_sec
    assert any("Packing-aware ILS" in line for line in result.diagnostics)


def test_ils_timeline_remains_exact_with_half_second_matrix_values() -> None:
    payload = _request().model_dump()
    payload["orders"][0]["service_time_sec"] = 61
    payload["orders"][0]["delivery_window_start_sec"] = 0
    payload["duration_matrix_seconds"] = [
        [0, 100, 200],
        [100, 0, 101.5],
        [200, 101.5, 0],
    ]
    request = FleetOptimizationRequest.model_validate(payload)

    result = PackingAwareILSOptimizer(
        request, time_budget_seconds=0.2, random_seed=7
    ).solve()

    assert result.status == "SUCCESS"
    route = result.routes[0]
    previous_departure = route.start_time_sec
    for stop in route.stops:
        assert stop.arrival_time_sec - previous_departure == (
            stop.travel_time_sec + stop.waiting_time_sec
        )
        previous_departure = stop.departure_time_sec


def test_ils_does_not_return_success_when_return_leg_exceeds_vehicle_shift() -> None:
    result = PackingAwareILSOptimizer(
        _request(available_end_sec=700),
        time_budget_seconds=0.2,
        random_seed=7,
    ).solve()

    assert result.status == "INFEASIBLE"
    assert result.routes == []
    assert [order.order_id for order in result.unassigned_orders] == ["order-1"]


def test_fast_packing_unloads_same_stop_from_door_inward() -> None:
    request = _request()
    vehicle = request.vehicles[0].model_copy(update={"width_cm": 100})
    first_item = request.orders[0].items[0].model_copy(
        update={"id": "item-back", "length_cm": 100, "width_cm": 100}
    )
    second_item = first_item.model_copy(update={"id": "item-door"})
    pickup = ScheduledStop(
        sequence=1,
        location_id="pickup",
        location_name="Điểm lấy",
        stop_type="PICKUP",
        order_id="order-1",
        allocation_id="order-1",
        latitude=21.01,
        longitude=105.81,
        arrival_time_sec=0,
        departure_time_sec=0,
        items_loaded=[first_item.id, second_item.id],
    )
    delivery = pickup.model_copy(
        update={
            "sequence": 2,
            "stop_type": "DELIVERY",
            "items_loaded": [],
            # Input order is deliberately back-to-front.  Both packages leave
            # at this stop, so the nearer one may be removed first.
            "items_unloaded": [first_item.id, second_item.id],
        }
    )

    valid, reason = FastLIFOPackingChecker(vehicle).validate_route_stops(
        [pickup, delivery],
        {first_item.id: first_item, second_item.id: second_item},
    )

    assert valid is True, reason


def test_hybrid_rejects_impossible_shift_before_running_packing() -> None:
    optimizer = PackingAwareHybridALNSOptimizer(
        _request(available_end_sec=700), time_budget_seconds=0.2
    )

    class PackingMustNotRun:
        def validate_route_stops(self, *_args, **_kwargs):
            raise AssertionError("packing ran before the cheaper schedule check")

    optimizer.checkers[0] = PackingMustNotRun()

    feasible, stops = optimizer._can_insert_order(
        0, [], optimizer.orders[0], 0, 1
    )

    assert feasible is False
    assert stops == []


def test_hybrid_alns_returns_only_production_audited_routes() -> None:
    optimizer = PackingAwareHybridALNSOptimizer(
        _request(), time_budget_seconds=0.2, random_seed=7
    )

    result = optimizer.solve()

    assert result.status == "SUCCESS"
    assert result.unassigned_orders == []
    assert all(route.spatial_validation.is_valid for route in result.routes)
    assert result.benchmarks is not None
    assert any("Hybrid ALNS" in line for line in result.diagnostics)


def test_hybrid_adapter_allows_floor_rotation_for_every_package(monkeypatch) -> None:
    request = _request()
    fixed_orientation_item = request.orders[0].items[0].model_copy(
        update={"can_rotate": False}
    )
    request = request.model_copy(
        update={
            "orders": [
                request.orders[0].model_copy(
                    update={"items": [fixed_orientation_item]}
                )
            ]
        }
    )
    captured = {}

    def capture_and_solve(*args, **_kwargs):
        captured["can_rotate"] = [
            item.can_rotate for order in args[2] for item in order.items
        ]
        return solve_hybrid_greedy(*args[:7])

    monkeypatch.setattr(
        hybrid_engine_module,
        "solve_hybrid_alns",
        capture_and_solve,
    )

    result = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=0.2, random_seed=7
    ).solve()

    assert captured["can_rotate"] == [True]
    assert result.status == "SUCCESS"


def test_hybrid_final_audit_accepts_package_that_only_fits_after_rotation() -> None:
    request = _request()
    vehicle = request.vehicles[0].model_copy(
        update={"length_cm": 80, "width_cm": 120}
    )
    item = request.orders[0].items[0].model_copy(
        update={
            "length_cm": 100,
            "width_cm": 70,
            "can_rotate": False,
        }
    )
    order = request.orders[0].model_copy(update={"items": [item]})
    request = request.model_copy(
        update={"vehicles": [vehicle], "orders": [order]}
    )

    result = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=0.2, random_seed=7
    ).solve()

    assert result.status == "SUCCESS"
    assert result.unassigned_orders == []
    placed = result.routes[0].spatial_validation.step_states[0].placed_items[0]
    assert (placed.length_cm, placed.width_cm) == (70, 100)


def test_hybrid_entry_uses_faithful_legacy_search_profile(monkeypatch) -> None:
    request = _request()
    sentinel = object()
    captured = {}

    class FakeLegacyHybridALNSSolver:
        def __init__(self, *_args, max_iterations, initial_solution, **_kwargs):
            captured["max_iterations"] = max_iterations
            captured["initial_solution"] = initial_solution

        def solve(self):
            return sentinel

    monkeypatch.setattr(
        hybrid_solver_module,
        "LegacyHybridALNSSolver",
        FakeLegacyHybridALNSSolver,
        raising=False,
    )

    initial_solution = object()
    result = hybrid_solver_module.solve_hybrid_alns(
        [],
        [],
        [],
        object(),
        [],
        [],
        {},
        time_limit_sec=0.2,
        max_iterations=12,
        initial_solution=initial_solution,
        search_profile="algo_lab_legacy_v1",
    )

    assert result is sentinel
    assert captured == {
        "max_iterations": 12,
        "initial_solution": initial_solution,
    }


def test_historical_portfolio_uses_evolved_profile_for_single_depot_heterogeneous_fleet(
    monkeypatch,
) -> None:
    depot = SimpleNamespace(latitude=1.0, longitude=2.0)
    vehicles = [
        SimpleNamespace(
            depot=depot,
            end_depot=None,
            length_cm=100,
            width_cm=100,
            height_cm=100,
            payload_limit_kg=1000,
            fixed_operating_cost_vnd=100,
        ),
        SimpleNamespace(
            depot=depot,
            end_depot=None,
            length_cm=200,
            width_cm=100,
            height_cm=100,
            payload_limit_kg=2000,
            fixed_operating_cost_vnd=200,
        ),
    ]
    initial_solution = SimpleNamespace(routes=[object()])
    sentinel = SimpleNamespace(real_economic_cost_vnd=1)

    class FakeEvolvedSolver:
        def __init__(self, *_args, **_kwargs):
            pass

        def solve(self):
            return sentinel

    class LegacyMustNotRun:
        def __init__(self, *_args, **_kwargs):
            raise AssertionError("single-depot portfolio selected legacy")

    monkeypatch.setattr(
        hybrid_solver_module, "HybridALNSSolver", FakeEvolvedSolver
    )
    monkeypatch.setattr(
        hybrid_solver_module, "LegacyHybridALNSSolver", LegacyMustNotRun
    )

    result = hybrid_solver_module.solve_hybrid_alns(
        vehicles,
        [],
        [],
        object(),
        [],
        [],
        {},
        time_limit_sec=0.2,
        initial_solution=initial_solution,
        search_profile="historical_portfolio",
    )

    assert result is sentinel


def test_compact_portfolio_preserves_specialist_95_stream(monkeypatch) -> None:
    from app.hybrid_alns import advanced_metaheuristics

    depot = SimpleNamespace(latitude=1.0, longitude=2.0)
    vehicle = SimpleNamespace(
        depot=depot,
        end_depot=None,
        length_cm=100,
        width_cm=100,
        height_cm=100,
        payload_limit_kg=1000,
        fixed_operating_cost_vnd=100,
    )
    initial_solution = SimpleNamespace(
        routes=[object(), object(), object(), object()],
        real_economic_cost_vnd=1000,
    )
    seed_solution = SimpleNamespace(
        routes=[object()],
        unassigned_orders=[],
        real_economic_cost_vnd=500,
        solution_audited=True,
        is_contract_valid=True,
        is_temporally_valid=True,
        is_spatial_valid=True,
        fulfillment_rate=100.0,
        solver_name="SA",
        random_seed=0,
        execution_time_sec=0.0,
    )
    alns_solution = SimpleNamespace(real_economic_cost_vnd=600)
    captured = {}

    def fake_sa(*_args, **kwargs):
        captured["sa_seed"] = kwargs["random_seed"]
        captured["sa_budget"] = kwargs["time_limit_sec"]
        captured["construction_fraction"] = kwargs["construction_fraction"]
        return seed_solution

    class FakeEvolvedSolver:
        def __init__(self, *_args, **kwargs):
            captured["alns_budget"] = kwargs["time_limit_sec"]
            self.destroy_weights = {}
            self.repair_weights = {}

        def solve(self):
            return alns_solution

    monkeypatch.setattr(
        advanced_metaheuristics, "solve_simulated_annealing", fake_sa
    )
    monkeypatch.setattr(
        hybrid_solver_module, "HybridALNSSolver", FakeEvolvedSolver
    )

    result = hybrid_solver_module.solve_hybrid_alns(
        [vehicle],
        [],
        [SimpleNamespace(items=[])],
        object(),
        [],
        [],
        {},
        time_limit_sec=30.0,
        random_seed=2,
        initial_solution=initial_solution,
        search_profile="historical_portfolio",
    )

    assert result.real_economic_cost_vnd == seed_solution.real_economic_cost_vnd
    assert result.solver_name == "Hybrid adaptive SA seed | SA"
    assert captured == {
        "sa_seed": 6,
        "sa_budget": 28.5,
        "construction_fraction": 0.95,
        "alns_budget": 1.5,
    }


def test_hybrid_updates_adaptive_weights_on_non_trivial_case() -> None:
    case_path = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "cases"
        / "scenario_2_heavy_cargo.json"
    )
    payload = json.loads(case_path.read_text(encoding="utf-8"))
    payload.pop("scenario_profile", None)
    optimizer = PackingAwareHybridALNSOptimizer(
        FleetOptimizationRequest.model_validate(payload),
        time_budget_seconds=0.2,
        random_seed=7,
    )

    result = optimizer.solve()

    assert result.status == "SUCCESS"
    assert any(
        weight != initial
        for weight, initial in zip(
            optimizer.destroy_weights.values(),
            (2.0, 2.0, 1.8, 1.5, 1.2, 1.2, 1.0, 0.8),
        )
    )


def test_hybrid_enforces_production_vehicle_restriction() -> None:
    request = _request()
    restricted_order = request.orders[0].model_copy(
        update={"allowed_source_vehicle_ids": ["another-vehicle"]}
    )
    request = request.model_copy(update={"orders": [restricted_order]})

    result = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=0.2
    ).solve()

    assert result.routes == []
    assert [order.order_id for order in result.unassigned_orders] == ["order-1"]


def test_hybrid_solve_enforces_vehicle_return_within_availability() -> None:
    result = PackingAwareHybridALNSOptimizer(
        _request(available_end_sec=700),
        time_budget_seconds=0.2,
    ).solve()

    assert result.routes == []
    assert [order.order_id for order in result.unassigned_orders] == ["order-1"]


def test_hybrid_contains_the_full_adaptive_operator_portfolio() -> None:
    optimizer = PackingAwareHybridALNSOptimizer(
        _request(), time_budget_seconds=0.2, random_seed=7
    )

    assert tuple(optimizer.destroy_weights) == (
        "route",
        "small",
        "cluster",
        "worst",
        "related",
        "heavy",
        "string",
        "random",
    )
    assert tuple(optimizer.repair_weights) == ("regret2", "regret3", "greedy")


def test_hybrid_warm_start_accepts_only_complete_production_routes(
    monkeypatch,
) -> None:
    request = _request()
    baseline = PackingAwareHybridALNSOptimizer(
        request, time_budget_seconds=0.2, random_seed=1
    ).solve()

    warm_optimizer = PackingAwareHybridALNSOptimizer(
        request,
        time_budget_seconds=0.2,
        random_seed=2,
        initial_plan=baseline,
    )
    warm_state = warm_optimizer._warm_start_state()

    assert warm_state is not None
    assert warm_state[2] == []
    assert sum(bool(route) for route in warm_state[1]) == 1

    incomplete_optimizer = PackingAwareHybridALNSOptimizer(
        request,
        time_budget_seconds=0.2,
        initial_plan=_complete_plan(300_000, "vehicle-1"),
    )
    assert incomplete_optimizer._warm_start_state() is None

    captured = {}

    def fake_solve_hybrid(*_args, initial_solution=None, **_kwargs):
        captured["initial_solution"] = initial_solution
        assert initial_solution is not None
        return initial_solution

    monkeypatch.setattr(
        hybrid_engine_module,
        "solve_hybrid_alns",
        fake_solve_hybrid,
    )

    warm_result = warm_optimizer.solve()

    assert captured["initial_solution"] is not None
    assert warm_result.status == "SUCCESS"


def test_hybrid_elite_audit_preserves_route_count_diversity() -> None:
    one_route = (100, [[object()], []], [])
    another_one_route = (110, [[object()], []], [])
    two_routes = (120, [[object()], [object()]], [])

    selected = PackingAwareHybridALNSOptimizer._select_audit_candidates(
        [one_route, another_one_route, two_routes], limit=2
    )

    assert selected == [one_route, two_routes]


def _complete_plan(cost: int, route_id: str) -> FleetOptimizationResponse:
    return FleetOptimizationResponse(
        job_id="ils-test",
        status="SUCCESS",
        total_cost_vnd=cost,
        routes=[
            OptimizedRoute(
                route_id=route_id,
                vehicle_id="vehicle-1",
                start_time_sec=200,
                end_time_sec=360,
                plate_number="29H-001",
                vehicle_length_cm=400,
                vehicle_width_cm=200,
                total_distance_km=3,
                total_duration_minutes=10,
                stops=[
                    ScheduledStop(
                        sequence=1,
                        location_id="pickup",
                        location_name="Điểm lấy",
                        stop_type="PICKUP",
                        order_id="order-1",
                        allocation_id="order-1",
                        latitude=21.01,
                        longitude=105.81,
                        arrival_time_sec=300,
                        departure_time_sec=360,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_loaded=["item-1"],
                    )
                ],
                return_travel_time_sec=0,
                return_waiting_time_sec=0,
                spatial_validation=SpatialValidationResult(is_valid=True),
            )
        ],
    )


def test_multi_start_adds_hybrid_alns_and_ranks_it_with_the_same_rules(monkeypatch) -> None:
    ortools_plan = _complete_plan(500_000, "ortools-route")
    hybrid_plan = _complete_plan(300_000, "hybrid-route")

    def fake_worker(*_args):
        strategy = SEARCH_STRATEGIES[0]
        return (
            strategy.key,
            strategy.label,
            ortools_plan.model_dump(),
            500_000,
            None,
        )

    class FakeHybridALNS:
        def __init__(self, *_args, **_kwargs):
            pass

        def solve(self):
            return hybrid_plan

    monkeypatch.setattr(
        multi_start_module, "ProcessPoolExecutor", ThreadPoolExecutor
    )
    monkeypatch.setattr(multi_start_module, "_run_search_worker", fake_worker)
    monkeypatch.setattr(
        multi_start_module, "PackingAwareHybridALNSOptimizer", FakeHybridALNS
    )

    batch = MultiStartFleetOptimizer(
        _request(), strategies=[SEARCH_STRATEGIES[0]]
    ).solve(max_candidates=3)

    assert batch.solver_run_count == 2
    assert batch.fully_served_candidate_count == 2
    assert [candidate.search_strategy for candidate in batch.candidates] == [
        "Packing-aware Hybrid ALNS (seed 0)",
        SEARCH_STRATEGIES[0].label,
    ]
    assert batch.candidates[0].result.total_cost_vnd == 300_000


def test_multi_start_worker_does_not_duplicate_hybrid_fallback(monkeypatch) -> None:
    captured = {}
    plan = _complete_plan(500_000, "ortools-route")

    class FakeRoutingSolver:
        def __init__(self, _request, **kwargs):
            captured.update(kwargs)

        def solve_with_objective(self):
            return plan, 500_000

    monkeypatch.setattr(
        multi_start_module, "FleetRoutingSolver", FakeRoutingSolver
    )

    result = multi_start_module._run_search_worker(
        _request().model_dump(),
        SEARCH_STRATEGIES[0].key,
        10.0,
        1.0,
        0.65,
        0.20,
        0.15,
    )

    assert result[-1] is None
    assert captured["enable_hybrid_fallback"] is False
