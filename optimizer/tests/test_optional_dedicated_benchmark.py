"""Benchmark runners can skip optional dedicated-trip reports, never audits."""
import pytest

from app.baseline_calculator import BaselineCostCalculator
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.ils_engine import PackingAwareILSOptimizer
from test_benchmark_contract import comparison_request


def test_expired_comparison_budget_reports_timeout_before_solving(monkeypatch):
    calculator = BaselineCostCalculator(comparison_request(), [], deadline=0)
    def unexpected_solve(*args):
        pytest.fail("Started a baseline routing search after the deadline")
    monkeypatch.setattr(calculator, "_solve_direct_schedule", unexpected_solve)
    metric = calculator.compute_direct_dedicated()
    assert not metric.routes
    assert metric.violations[0].startswith("TIMEOUT:")


@pytest.mark.parametrize("engine_type", [PackingAwareHybridALNSOptimizer, PackingAwareILSOptimizer])
def test_disabling_dedicated_report_keeps_actual_plan_and_spatial_audit(engine_type, monkeypatch):
    calls = []
    original = BaselineCostCalculator.build_comparison
    def record(*args, **kwargs):
        calls.append(True)
        return original(*args, **kwargs)
    monkeypatch.setattr(BaselineCostCalculator, "build_comparison", record)
    result = engine_type(comparison_request(), time_budget_seconds=0.05,
        include_benchmarks=False).solve()
    assert not calls
    assert result.benchmarks is None
    assert not result.unassigned_orders
    assert all(route.spatial_validation.is_valid for route in result.routes)
    assert {cid for route in result.routes for stop in route.stops for cid in stop.items_unloaded} == {"pkg-0", "pkg-1"}


@pytest.mark.parametrize("engine_type", [PackingAwareHybridALNSOptimizer, PackingAwareILSOptimizer])
def test_production_default_still_includes_dedicated_report(engine_type):
    result = engine_type(comparison_request(), time_budget_seconds=0.05).solve()
    assert result.benchmarks is not None
    assert not result.unassigned_orders

def test_direct_routing_slice_timeout_is_reported_as_timeout(monkeypatch):
    from app.baseline_calculator import _DirectRoutingTimeout

    calculator = BaselineCostCalculator(comparison_request(), [])
    def no_first_schedule(*args):
        raise _DirectRoutingTimeout
    monkeypatch.setattr(calculator, "_solve_direct_schedule", no_first_schedule)
    report = calculator.compute_direct_dedicated()
    assert not report.is_feasible
    assert report.violations[0].startswith("TIMEOUT:")
