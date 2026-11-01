"""Construction must avoid packing every temporal insertion before ranking."""
import copy
import time

from app.alns_engine import ALNSFleetOptimizer
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from test_benchmark_contract import comparison_request


def test_ranked_repair_keeps_the_cheapest_valid_insertion_with_fewer_packing_probes(monkeypatch):
    results, probe_counts = [], []
    for ranked in [False, True]:
        engine = PackingAwareHybridALNSOptimizer(comparison_request(), time_budget_seconds=2)
        engine._allow_layout_search = False
        valid, seed = engine._can_insert_order(0, [], engine.orders[0], 0, 1)
        assert valid
        probes = []
        original = engine._validate_stops_cached

        def packing(*args):
            probes.append(True)
            return original(*args)

        monkeypatch.setattr(engine, "_validate_stops_cached", packing)
        repair = engine._repair_greedy_insert if ranked else lambda *a, **kw: ALNSFleetOptimizer._repair_greedy_insert(engine, *a, **kw)
        routes, missing = repair([copy.deepcopy(seed)], [engine.orders[1].id],
            randomize=False, deadline=time.perf_counter()+2)
        assert not missing
        results.append((engine._candidate_key(routes, missing), engine._state_signature(routes)))
        probe_counts.append(len(probes))
    assert results[0] == results[1]
    assert 0 < probe_counts[1] < probe_counts[0]


def test_expired_ranked_repair_preserves_every_pending_order(monkeypatch):
    engine = PackingAwareHybridALNSOptimizer(comparison_request())
    pending = [order.id for order in engine.orders]

    def unexpected_probe(*args, **kwargs):
        raise AssertionError("An expired construction must not probe insertions")

    monkeypatch.setattr(engine, "_candidate_insertions", unexpected_probe)
    routes, missing = engine._repair_greedy_insert([[]], pending, randomize=False,
        deadline=time.perf_counter()-1)
    assert routes == [[]]
    assert set(missing) == set(pending)


def test_ranked_construction_prices_calendar_extension_without_forbidding_later_work():
    request = comparison_request()
    request.vehicles = [request.vehicles[0].model_copy(update={
        "id": f"v-day-{day}", "source_vehicle_id": "physical-vehicle", "service_day_index": day,
        "available_start_sec": day*86400+28800, "available_end_sec": day*86400+61200,
        "fixed_operating_cost_vnd": 10000 if day == 0 else 0,
    }) for day in range(2)]
    request.drivers = [request.drivers[0].model_copy(update={
        "id": f"driver-day-{day}", "source_driver_id": "physical-driver", "service_day_index": day,
        "fixed_salary_monthly_vnd": 1_000_000,
    }) for day in range(2)]
    size = len(request.vehicles)+len(request.orders)*2
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(size)] for i in range(size)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(size)] for i in range(size)]
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2)
    routes, missing = engine._repair_greedy_insert([[], []], [o.id for o in engine.orders], randomize=False)
    assert not missing
    assert routes[0] and not routes[1], "Lower fixed cost must not hide another day of calendar payroll"
    # A genuine later window must remain feasible, rather than becoming a hard same-day rule.
    for order in request.orders:
        order.pickup_window_start_sec = 86400+28800
        order.delivery_window_start_sec = 86400+28800
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2)
    routes, missing = engine._repair_greedy_insert([[], []], [o.id for o in engine.orders], randomize=False)
    assert not missing
    assert not routes[0] and routes[1]
