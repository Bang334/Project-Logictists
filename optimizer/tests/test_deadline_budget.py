import time

from test_benchmark_contract import comparison_request

import app.multi_start as multi_start_module
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import FleetOptimizationResponse, UnassignedOrder
from app.multi_start import MultiStartFleetOptimizer


def test_hybrid_solve_returns_timeout_when_hard_deadline_already_exhausted(monkeypatch):
    request = comparison_request()
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=10, random_seed=0)

    # Simulate a slow audit that exceeds the hard deadline on every candidate.
    def slow_build(*_args, **_kwargs):
        return FleetOptimizationResponse(
            job_id=request.job_id,
            status="SUCCESS",
            total_distance_km=10.0,
            total_duration_minutes=20.0,
            total_cost_vnd=100000,
            routes=[],
            unassigned_orders=[],
            diagnostics=[],
        )

    monkeypatch.setattr(engine, "_build_final_response", slow_build)

    expired_deadline = time.perf_counter() - 0.1
    started = time.perf_counter()
    result = engine.solve(hard_deadline=expired_deadline)
    elapsed = time.perf_counter() - started

    assert result.status == "TIMEOUT"
    assert elapsed < 3.0


def test_multi_start_returns_timeout_batch_instead_of_raising_when_budget_expired(monkeypatch):
    request = comparison_request()
    request.search_time_seconds = 1
    request.max_time_seconds = 1

    class FakeTimedOutHybrid:
        def __init__(self, req, **_kwargs):
            self.req = req

        def solve(self, hard_deadline=None):
            return FleetOptimizationResponse(
                job_id=self.req.job_id,
                status="TIMEOUT",
                total_distance_km=0.0,
                total_duration_minutes=0.0,
                total_cost_vnd=0,
                routes=[],
                unassigned_orders=[
                    UnassignedOrder(
                        order_id=o.id,
                        order_number=o.order_number or o.id,
                        reason_code="TIMEOUT",
                        reason_message="Expired before auditing",
                    )
                    for o in self.req.orders
                ],
                diagnostics=["Expired before auditing"],
            )

    def fail_if_fallback_called(*_args, **_kwargs):
        raise AssertionError("OR-Tools fallback should not run after budget is exhausted")

    monkeypatch.setattr(multi_start_module, "PackingAwareHybridALNSOptimizer", FakeTimedOutHybrid)
    monkeypatch.setattr(multi_start_module, "_REAL_HYBRID_OPTIMIZER", FakeTimedOutHybrid)
    monkeypatch.setattr(multi_start_module, "_run_search_worker", fail_if_fallback_called)

    optimizer = MultiStartFleetOptimizer(request)
    # Force job_deadline to appear nearly exhausted.
    optimizer._created_at = time.perf_counter() - 1.0
    batch = optimizer.solve(max_candidates=3)

    assert len(batch.candidates) == 1
    assert batch.candidates[0].result.status == "TIMEOUT"
    assert batch.fully_served_candidate_count == 0
