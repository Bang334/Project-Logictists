"""A separate ILS seed budget must survive slow initial construction."""
import copy
import pytest

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from benchmarks.algorithm_comparison.common import convert_request_to_hybrid
from test_benchmark_contract import comparison_request


def test_slow_greedy_does_not_expire_the_new_ils_repair_budget(monkeypatch):
    import app.hybrid_alns_engine as module
    request = comparison_request()
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1)
    original = engine._repair_greedy_insert
    complete, missing = original([[]], [o.id for o in engine.orders], randomize=False)
    assert not missing
    clock = [0.0]
    calls = []
    repair_results = []

    def repair(routes, pending, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            clock[0] = 2.1  # Construction took longer than the total nominal limit.
            return copy.deepcopy(complete), []
        result = original(routes, pending, **kwargs)
        repair_results.append(result[1])
        clock[0] += 0.5
        return result

    monkeypatch.setattr(module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(engine, "_repair_greedy_insert", repair)
    vehicles, drivers, orders, *_ = convert_request_to_hybrid(request)
    result = engine._build_hybrid_initial_solution(
        vehicles, drivers, [0],
        {o.id: o.pickup_location.id for o in orders},
        {o.id: o.delivery_location.id for o in orders},
    )
    assert result is not None
    assert repair_results
    assert any(not failed for failed in repair_results), "Every local repair timed out despite the new ILS phase budget"


def test_partial_warm_seed_keeps_missing_orders_and_is_not_marked_audited(monkeypatch):
    request = comparison_request()
    for order in request.orders:
        order.split_group_id = None
        order.source_order_id = order.id
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1)
    partial, failed = engine._repair_greedy_insert([[]], [engine.orders[0].id], randomize=False)
    assert not failed
    missing = [engine.orders[1].id]
    monkeypatch.setattr(engine, "_warm_start_state", lambda: (0, partial, missing))
    vehicles, drivers, orders, *_ = convert_request_to_hybrid(request)
    result = engine._build_hybrid_initial_solution(
        vehicles, drivers, [0],
        {o.id: o.pickup_location.id for o in orders},
        {o.id: o.delivery_location.id for o in orders},
    )
    assert result is not None
    assert result.unassigned_orders == missing
    assert engine._ils_elite_routes_pool[0][2] == missing
    assert result.solution_audited is False


def test_seed_search_rebuilds_partial_construction_before_relocating_served_ones(monkeypatch):
    import app.hybrid_alns_engine as module
    from app.ils_engine import PackingAwareILSOptimizer
    request = comparison_request()
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1)
    original = engine._repair_greedy_insert
    partial, failed = original([[]], [engine.orders[0].id], randomize=False)
    assert not failed
    missing = [engine.orders[1].id]
    calls = []
    clock = [0.0]

    def repair(routes, pending, **kwargs):
        calls.append(list(pending))
        if len(calls) == 1:
            clock[0] = 0.2
            return copy.deepcopy(partial), missing
        return original(routes, pending, **kwargs)

    def relocate(self, routes, unassigned, started_at, deadline):
        assert not unassigned, "Cost relocation started before repairing the missing order"
        assert deadline-started_at == pytest.approx(2.4)
        clock[0] = deadline + 1
        return None

    monkeypatch.setattr(module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(engine, "_repair_greedy_insert", repair)
    monkeypatch.setattr(PackingAwareILSOptimizer, "_best_relocation", relocate)
    vehicles, drivers, orders, *_ = convert_request_to_hybrid(request)
    result = engine._build_hybrid_initial_solution(
        vehicles, drivers, [0],
        {o.id: o.pickup_location.id for o in orders},
        {o.id: o.delivery_location.id for o in orders},
    )
    assert calls[1] == [order.id for order in engine.orders]
    assert result is not None and not result.unassigned_orders
    assert engine._use_ranked_repair is True
    assert engine._construction_audit_fallback is not None
    assert not engine._construction_audit_fallback[1]
    assert engine._native_search_budget_available is False


def test_post_audit_reserve_does_not_shorten_seed_route_consolidation(monkeypatch):
    import app.hybrid_alns_engine as module
    from app.ils_engine import PackingAwareILSOptimizer
    request = comparison_request()
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2)
    clock = [0.0]
    durations = []
    def relocate(self, routes, unassigned, started_at, deadline):
        assert self._use_ranked_repair is False, "A complete construction must retain its original search stream"
        assert self._native_search_budget_available is True
        durations.append(deadline-started_at)
        clock[0] = deadline+1
        return None
    monkeypatch.setattr(module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(PackingAwareILSOptimizer, "_best_relocation", relocate)
    vehicles, drivers, orders, *_ = convert_request_to_hybrid(request)
    engine._build_hybrid_initial_solution(vehicles,drivers,[0],
        {o.id:o.pickup_location.id for o in orders}, {o.id:o.delivery_location.id for o in orders})
    assert durations == pytest.approx([1.5])


@pytest.mark.parametrize("ranked", [False, True])
def test_borrowed_native_budget_reaches_repairs_called_by_parent_neighborhood(monkeypatch, ranked):
    import app.hybrid_alns_engine as module
    from app.ils_engine import PackingAwareILSOptimizer
    request = comparison_request()
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1)
    original = engine._repair_greedy_insert
    partial, missing = original([[]], [engine.orders[0].id], randomize=False)
    assert not missing
    clock, calls = [0.0], []

    def repair(routes, pending, **kwargs):
        calls.append(True)
        if len(calls) == 1:
            clock[0] = 0.2
            return copy.deepcopy(partial), [engine.orders[1].id]
        result = original(routes, pending, **kwargs)
        clock[0] = 1.3  # Beyond the nominal 1s, inside the allocated 2.4s phase.
        return result

    def relocate(self, routes, unassigned, started_at, deadline):
        assert clock[0] < deadline
        order_id = engine.orders[-1].id
        reduced = engine._remove_order(routes, order_id)
        engine._use_ranked_repair = ranked
        _repaired, failed = original(reduced, [order_id], start_time=started_at, randomize=False)
        assert not failed, "Parent neighborhood discarded repair despite unused borrowed budget"
        clock[0] = deadline+1
        return None

    monkeypatch.setattr(module.time, "perf_counter", lambda: clock[0])
    monkeypatch.setattr(engine, "_repair_greedy_insert", repair)
    monkeypatch.setattr(PackingAwareILSOptimizer, "_best_relocation", relocate)
    vehicles, drivers, orders, *_ = convert_request_to_hybrid(request)
    engine._build_hybrid_initial_solution(vehicles, drivers, [0],
        {o.id:o.pickup_location.id for o in orders}, {o.id:o.delivery_location.id for o in orders})
    assert engine._seed_search_deadline is None
