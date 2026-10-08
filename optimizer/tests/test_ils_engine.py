from concurrent.futures import ThreadPoolExecutor

import app.multi_start as multi_start_module
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
    assert route.stops[0].waiting_time_sec == 200
    assert route.stops[1].arrival_time_sec == 500
    assert route.stops[1].waiting_time_sec == 40
    assert route.return_travel_time_sec == 200
    assert route.end_time_sec == 760
    assert any("Packing-aware ILS" in line for line in result.diagnostics)


def test_ils_does_not_return_success_when_return_leg_exceeds_vehicle_shift() -> None:
    result = PackingAwareILSOptimizer(
        _request(available_end_sec=700),
        time_budget_seconds=0.2,
        random_seed=7,
    ).solve()

    assert result.status == "INFEASIBLE"
    assert result.routes == []
    assert [order.order_id for order in result.unassigned_orders] == ["order-1"]


def _complete_plan(cost: int, route_id: str) -> FleetOptimizationResponse:
    return FleetOptimizationResponse(
        job_id="ils-test",
        status="SUCCESS",
        total_cost_vnd=cost,
        routes=[
            OptimizedRoute(
                route_id=route_id,
                vehicle_id="vehicle-1",
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
                        items_loaded=["item-1"],
                    )
                ],
                spatial_validation=SpatialValidationResult(is_valid=True),
            )
        ],
    )


def test_multi_start_adds_ils_and_ranks_it_with_the_same_rules(monkeypatch) -> None:
    ortools_plan = _complete_plan(500_000, "ortools-route")
    ils_plan = _complete_plan(300_000, "ils-route")

    def fake_worker(*_args):
        strategy = SEARCH_STRATEGIES[0]
        return (
            strategy.key,
            strategy.label,
            ortools_plan.model_dump(),
            500_000,
            None,
        )

    class FakeILS:
        def __init__(self, *_args, **_kwargs):
            pass

        def solve(self):
            return ils_plan

    monkeypatch.setattr(
        multi_start_module, "ProcessPoolExecutor", ThreadPoolExecutor
    )
    monkeypatch.setattr(multi_start_module, "_run_search_worker", fake_worker)
    monkeypatch.setattr(
        multi_start_module, "PackingAwareILSOptimizer", FakeILS
    )

    batch = MultiStartFleetOptimizer(
        _request(), strategies=[SEARCH_STRATEGIES[0]]
    ).solve(max_candidates=3)

    assert batch.solver_run_count == 2
    assert batch.fully_served_candidate_count == 2
    assert [candidate.search_strategy for candidate in batch.candidates] == [
        "Packing-aware ILS",
        SEARCH_STRATEGIES[0].label,
    ]
    assert batch.candidates[0].result.total_cost_vnd == 300_000
