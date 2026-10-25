"""Algorithm 1: Packing-Aware Hybrid Genetic Search (HGS / Memetic Algorithm).

Implements population-based evolutionary search with diversity management,
order-preserving crossover, local search improvement, and geometric packing validation.
"""

from __future__ import annotations

import copy
import random
import time
from typing import Dict, List, Optional, Sequence, Set, Tuple

from app.models import FleetOptimizationRequest
from app.hybrid_alns.models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from app.hybrid_alns.packing_checker import FastPackingChecker
from app.hybrid_alns.route_evaluator import schedule_and_evaluate_route
from app.hybrid_alns.greedy_insertion import solve_greedy
from app.hybrid_alns.advanced_metaheuristics import PackingAwareMemeticSolver

from .common import (
    BenchmarkMetric,
    audit_with_spatial_validator,
    convert_request_to_hybrid,
)


class PackingAwareHGS:
    """Hybrid Genetic Search with Bi-objective Diversity Management & Spatial Packing."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        population_size: int = 15,
        time_limit_sec: float = 10.0,
        random_seed: int = 42,
    ):
        self.request = request
        self.population_size = population_size
        self.time_limit_sec = time_limit_sec
        self.random_seed = random_seed
        self.rng = random.Random(random_seed)

        (
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
        ) = convert_request_to_hybrid(request)

        self.order_by_id = {o.id: o for o in self.orders}
        self.cargo_by_id = {it.id: it for o in self.orders for it in o.items}

    def solve(self, case_name: str = "") -> BenchmarkMetric:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec

        # Delegate core memetic evolution to PackingAwareMemeticSolver
        solver = PackingAwareMemeticSolver(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
            time_limit_sec=self.time_limit_sec,
            max_iterations=400,
            random_seed=self.random_seed,
            final_spatial_time_limit_sec=min(3.0, max(2.0, self.time_limit_sec * 0.3)),
        )

        solution = solver.solve()
        elapsed = round(time.perf_counter() - started_at, 3)

        # Audit with production SpatialValidator
        prod_order_by_id = {o.id: o for o in self.request.orders}
        all_passed_spatial = True
        spatial_msg = "Pass"

        for route in solution.routes:
            veh = next((v for v in self.request.vehicles if v.id == route.vehicle.id), None)
            if not veh:
                continue
            passed, msg = audit_with_spatial_validator(
                veh, route.stops, prod_order_by_id, max_time_seconds=2.0
            )
            if not passed:
                all_passed_spatial = False
                spatial_msg = msg
                break

        served_count = len(self.orders) - len(solution.unassigned_orders)
        fulfillment = (served_count / max(1, len(self.orders))) * 100.0

        return BenchmarkMetric(
            algorithm_name="1. Hybrid Genetic Search (HGS)",
            case_file=case_name,
            status="SUCCESS" if solution.unassigned_orders == [] and all_passed_spatial else "PARTIAL",
            orders_served=served_count,
            total_orders=len(self.orders),
            fulfillment_rate_pct=round(fulfillment, 1),
            vehicles_used=len(solution.routes),
            total_cost_vnd=solution.real_economic_cost_vnd,
            selection_score_vnd=solution.real_economic_cost_vnd,
            total_distance_km=round(solution.total_distance_km, 2),
            runtime_sec=elapsed,
            spatial_audit_pass=all_passed_spatial,
            diagnostic=f"{solution.solver_name} | Spatial: {spatial_msg}",
        )
