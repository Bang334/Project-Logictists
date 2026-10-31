"""Algorithm 1: Packing-Aware Hybrid Genetic Search (HGS / Memetic Algorithm).

Implements population-based evolutionary search with diversity management,
order-preserving crossover, local search improvement, and geometric packing validation.
"""

from __future__ import annotations

import copy
import random
import time
from typing import List

from app.models import FleetOptimizationRequest
from app.hybrid_alns.models import OptimizationSolution
from app.hybrid_alns.advanced_metaheuristics import (
    PackingAwareMemeticSolver,
    PlanCandidate,
)

from .common import (
    BenchmarkMetric,
    audit_with_spatial_validator,
    convert_request_to_hybrid,
)


class _HGSEngine(PackingAwareMemeticSolver):
    """PackingAwareMemeticSolver with time-wave elite seeding for multi-shift relays."""

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        fallback_routes, fallback_unassigned = self._initial_state()
        fallback: PlanCandidate = (
            self._plan_cost(fallback_routes, fallback_unassigned),
            copy.deepcopy(fallback_routes),
            list(fallback_unassigned),
        )
        order_ids = [order.id for order in self.orders]
        population: List[List[str]] = [list(order_ids)]
        by_deadline = sorted(
            order_ids,
            key=lambda order_id: self.order_by_id[order_id].delivery_window_end_sec,
        )
        population.append(by_deadline)
        while len(population) < self.population_size:
            chromosome = list(order_ids)
            self.rng.shuffle(chromosome)
            population.append(chromosome)

        elite_candidates: List[PlanCandidate] = [fallback]
        wave_seq = self._time_wave_order_sequence()
        if wave_seq and time.perf_counter() < deadline:
            wave_routes, wave_unassigned = self._sequential_construction(
                wave_seq,
                min(deadline, started_at + min(1.5, self.time_limit_sec * 0.35)),
            )
            if not wave_unassigned:
                wave_cost = self._plan_cost(wave_routes, wave_unassigned)
                elite_candidates.append(
                    (wave_cost, copy.deepcopy(wave_routes), list(wave_unassigned))
                )

        generation = 0
        while generation < self.max_iterations and time.perf_counter() < deadline:
            generation += 1
            scored = []
            for chromosome in population:
                if time.perf_counter() >= deadline:
                    break
                candidate = self._evaluate_chromosome(chromosome, deadline)
                scored.append((candidate[0], chromosome, candidate))
                elite_candidates.append(
                    (
                        candidate[0],
                        copy.deepcopy(candidate[1]),
                        list(candidate[2]),
                    )
                )
            if len(scored) < 2:
                break
            scored.sort(key=lambda row: row[0])
            next_population = [list(scored[0][1]), list(scored[1][1])]
            tournament_size = min(3, len(scored))
            while len(next_population) < self.population_size:
                first = min(
                    self.rng.sample(scored, tournament_size), key=lambda row: row[0]
                )[1]
                second = min(
                    self.rng.sample(scored, tournament_size), key=lambda row: row[0]
                )[1]
                child = self._crossover(first, second)
                if self.rng.random() < self.mutation_rate:
                    child = self._mutate(child)
                next_population.append(child)
            population = next_population

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            f"Packing-aware Memetic Search ({generation} generations)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
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

        solver = _HGSEngine(
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
