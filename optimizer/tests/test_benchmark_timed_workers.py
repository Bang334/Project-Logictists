from multiprocessing import active_children
from time import perf_counter, sleep
from unittest.mock import patch

import pytest

from benchmarks.savings_warm_start.timed_workers import publish_checkpoint, run_timed_workers


def _delayed_worker(task):
    if task["sleep_seconds"]:
        publish_checkpoint(task["checkpoint_path"], {"stream": task["stream"], "checkpoint": True})
    sleep(task["sleep_seconds"])
    return {"stream": task["stream"], "payload_size": len(task.get("payload", ""))}


def test_collects_completed_worker_and_reaps_overdue_worker():
    existing_workers = {process.pid for process in active_children()}
    started = perf_counter()
    results, errors, timed_out = run_timed_workers(
        _delayed_worker,
        [{"stream": "fast", "sleep_seconds": 0, "payload": "x" * 131_072},
         {"stream": "overdue", "sleep_seconds": 20}],
        started + 3,
    )
    assert perf_counter() - started < 8
    assert results == [
        {"stream": "fast", "payload_size": 131_072},
        {"stream": "overdue", "checkpoint": True},
    ]
    assert timed_out
    assert len(errors) == 1 and errors[0].startswith("overdue:")
    assert {process.pid for process in active_children()} <= existing_workers


def test_timed_portfolio_only_decodes_the_selected_audited_response(monkeypatch):
    from app.models import FleetOptimizationResponse
    from benchmarks.savings_warm_start import variant
    from test_benchmark_contract import comparison_request

    request = comparison_request()
    optimizer = variant.VariantHybridALNSOptimizer(request, stop_at_budget=True)
    payloads = [
        {
            "stream": stream,
            "response_dict": FleetOptimizationResponse(
                job_id=request.job_id, status="PARTIAL", diagnostics=[stream],
            ).model_dump(),
            "quality": [0, -served],
            "metric": {"quality": [0, -served]},
            "seed_meta": {},
        }
        for stream, served in (("direct-alns", 1), ("ortools-alns", 2))
    ]
    def completed_workers(_worker, tasks, _deadline):
        direct = next(task for task in tasks if task["stream"] == "direct-alns")
        ortools = next(task for task in tasks if task["stream"] == "ortools-alns")
        assert direct["defer_vehicle_search"]
        assert ortools["defer_vehicle_search"]
        return payloads, [], False

    monkeypatch.setattr(variant, "run_timed_workers", completed_workers)
    with patch.object(
        FleetOptimizationResponse, "model_validate", wraps=FleetOptimizationResponse.model_validate,
    ) as decode:
        winner = optimizer._solve_timed_portfolio(perf_counter() + 15)
    assert winner.diagnostics == ["ortools-alns"]
    assert optimizer._seed_meta["portfolio_streams"] == ["direct-alns", "ortools-alns"]
    assert decode.call_count == 1


@pytest.mark.parametrize("refined_score,expected", [(90, "refined"), (110, "incumbent")])
def test_worker_publishes_incumbent_before_using_spare_budget(monkeypatch, refined_score, expected):
    from app.models import FleetOptimizationResponse
    from benchmarks.savings_warm_start import variant
    from test_benchmark_contract import comparison_request

    request = comparison_request()
    root = variant.VariantHybridALNSOptimizer(request, cache_load_cycles=False)
    task = next(
        task for task in root._worker_tasks(perf_counter() + 15)
        if task["stream"] == "diversified-sa-alns"
    )
    task.update({
        "use_ortools_seed": False,
        "checkpoint_path": "test-only",
        "publish_deadline": perf_counter() + 15,
    })
    incumbent = FleetOptimizationResponse(job_id=request.job_id, status="SUCCESS", diagnostics=["incumbent"])
    refined = incumbent.model_copy(update={"diagnostics": ["refined"]})
    published = []

    def audit(stream, snapshot, plan, **kwargs):
        score = 100 if plan is incumbent else refined_score
        return {"response": plan, "quality": (0, -1, score), "metric": {"audit": {"complete_manifest": True}}}

    def polish(optimizer, plan, deadline):
        assert plan is incumbent
        assert published == ["incumbent"]
        assert not optimizer._defer_vehicle_search
        return refined

    def solve(optimizer, **kwargs):
        assert optimizer._defer_vehicle_search
        assert optimizer._optimize_production_vehicles([], []) is None
        return incumbent

    monkeypatch.setattr(variant.VariantHybridALNSOptimizer, "solve", solve)
    monkeypatch.setattr(variant.VariantHybridALNSOptimizer, "_polish_audited_response", polish)
    monkeypatch.setattr(variant, "_evaluate_stream_result", audit)
    monkeypatch.setattr(variant, "publish_checkpoint", lambda path, result: published.extend(
        result["response_dict"]["diagnostics"]
    ))

    result = variant._run_portfolio_worker(task)
    assert result["response_dict"]["diagnostics"] == [expected]
    assert published[-1] == expected


def test_short_budget_and_small_orders_run_in_process_without_spawning_workers(monkeypatch):
    from benchmarks.savings_warm_start import variant
    from test_benchmark_contract import comparison_request

    base = comparison_request()

    def fail_spawn(*args, **kwargs):
        raise AssertionError("Should not spawn worker processes for small orders or short budgets.")

    monkeypatch.setattr(variant, "run_timed_workers", fail_spawn)

    small_optimizer = variant.VariantHybridALNSOptimizer(
        base,
        time_budget_seconds=15.0,
        stop_at_budget=True,
        enable_portfolio=True,
        random_seed=0,
    )
    small_response = small_optimizer.solve()
    assert not small_response.unassigned_orders
    assert small_optimizer._seed_meta["winner_stream"] == "direct-inprocess"

    expanded_orders = [
        base.orders[i % len(base.orders)].model_copy(
            update={
                "id": f"o-inproc-{i}",
                "order_number": f"O-INPROC-{i}",
                "source_order_id": None,
                "split_group_id": None,
                "pickup_location": base.orders[i % len(base.orders)].pickup_location.model_copy(
                    update={"id": f"p-inproc-{i}"}
                ),
                "delivery_location": base.orders[i % len(base.orders)].delivery_location.model_copy(
                    update={"id": f"d-inproc-{i}"}
                ),
                "items": [
                    item.model_copy(update={"id": f"item-{i}-{j}"})
                    for j, item in enumerate(base.orders[i % len(base.orders)].items)
                ],
            }
        )
        for i in range(4)
    ]
    vehicles = [
        base.vehicles[0].model_copy(update={"id": f"v-inproc-{k}", "plate_number": f"TEST-{k}"})
        for k in range(2)
    ]
    drivers = [
        base.drivers[0].model_copy(update={"id": f"drv-inproc-{k}"})
        for k in range(2)
    ]
    mat_size = len(vehicles) + 2 * len(expanded_orders)
    short_req = base.model_copy(
        update={
            "vehicles": vehicles,
            "drivers": drivers,
            "orders": expanded_orders,
            "distance_matrix_meters": [
                [0 if r == c else 500 for c in range(mat_size)] for r in range(mat_size)
            ],
            "duration_matrix_seconds": [
                [0 if r == c else 60 for c in range(mat_size)] for r in range(mat_size)
            ],
        }
    )
    short_optimizer = variant.VariantHybridALNSOptimizer(
        short_req,
        time_budget_seconds=2.5,
        stop_at_budget=True,
        enable_portfolio=True,
        random_seed=0,
    )
    short_response = short_optimizer.solve()
    assert short_response.routes
    assert short_optimizer._seed_meta["winner_stream"] == "direct-inprocess"
