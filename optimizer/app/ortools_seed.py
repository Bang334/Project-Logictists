"""Fast single-model OR-Tools seed extraction for Hybrid ALNS warm-starting."""

from __future__ import annotations

import time
from typing import Dict, List, Optional, Sequence, Set, Tuple

from app.models import FleetOptimizationRequest, ScheduledStop
from app.routing_solver import FleetRoutingSolver
from app.search_policy import SearchProgressTracker
from app.search_strategies import find_search_strategy


def extract_ortools_seed_pool(
    request: FleetOptimizationRequest,
    *,
    strategy_keys: Sequence[str] = ("parallel-insertion-gls",),
    routing_seconds: float = 0.75,
    stagnation_seconds: float = 0.18,
) -> Tuple[List[List[List[ScheduledStop]]], Dict[str, object]]:
    """Build the OR-Tools routing model once and extract PDPTW seed routes without heavy auditing."""
    started = time.perf_counter()
    if not request.orders or not request.vehicles or routing_seconds <= 0.05 or not strategy_keys:
        return [], {
            "seed_seconds": 0.0,
            "seed_strategy": None,
            "seed_routes": 0,
            "seed_served_orders": 0,
        }

    first_strategy = find_search_strategy(strategy_keys[0])
    solver = FleetRoutingSolver(
        request,
        search_strategy=first_strategy,
        time_budget_seconds=max(0.2, routing_seconds),
        stagnation_seconds=stagnation_seconds,
        enable_hybrid_fallback=False,
    )
    if not solver.driver_safe_vehicle_indices:
        return [], {
            "seed_seconds": round(time.perf_counter() - started, 4),
            "seed_strategy": None,
            "seed_routes": 0,
            "seed_served_orders": 0,
        }

    manager, routing, time_dimension = solver._build_routing_model()
    required_indices = [
        manager.NodeToIndex(solver.vehicle_count + node_offset)
        for node_offset in range(2 * len(request.orders))
    ]
    total_orders = len(request.orders)

    seed_pool: List[List[List[ScheduledStop]]] = []
    best_strategy: Optional[str] = None
    best_served = 0
    best_routes_count = 0

    for idx, strategy_key in enumerate(strategy_keys):
        elapsed_total = time.perf_counter() - started
        remaining = routing_seconds - elapsed_total
        if remaining <= 0.08:
            break
        slice_sec = (
            remaining
            if idx == len(strategy_keys) - 1
            else min(remaining, max(0.25, routing_seconds * 0.7))
        )

        solver.search_strategy = find_search_strategy(strategy_key)
        search = solver._build_search_parameters()
        search.time_limit.seconds = int(slice_sec)
        search.time_limit.nanos = int((slice_sec - int(slice_sec)) * 1_000_000_000)

        attempt_started = time.perf_counter()
        progress = SearchProgressTracker(min(stagnation_seconds, slice_sec * 0.6))

        def observe_solution() -> None:
            attempt_elapsed = time.perf_counter() - attempt_started
            fully_served = all(
                routing.ActiveVar(node_idx).Value() == 1 for node_idx in required_indices
            )
            progress.observe(
                objective=int(routing.CostVar().Value()),
                fully_served=fully_served,
                elapsed_seconds=attempt_elapsed,
            )
            if progress.should_stop(attempt_elapsed):
                routing.solver().FinishCurrentSearch()

        routing.AddAtSolutionCallback(observe_solution)
        solution = routing.SolveWithParameters(search)
        if solution is None:
            continue

        drafts = solver._drafts_from_assignment(manager, routing, time_dimension, solution)
        routes: List[List[ScheduledStop]] = [[] for _ in request.vehicles]
        served_orders: Set[str] = set()
        for draft in drafts:
            if 0 <= draft.vehicle_index < len(routes):
                routes[draft.vehicle_index] = draft.scheduled_stops
                served_orders.update(draft.order_ids)

        if any(routes):
            seed_pool.append(routes)
            if len(served_orders) > best_served:
                best_served = len(served_orders)
                best_strategy = strategy_key
                best_routes_count = sum(bool(r) for r in routes)
            if best_served >= total_orders:
                break

    return seed_pool, {
        "seed_seconds": round(time.perf_counter() - started, 4),
        "seed_strategy": best_strategy,
        "seed_routes": best_routes_count,
        "seed_served_orders": best_served,
    }
