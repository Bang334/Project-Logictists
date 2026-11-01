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
        current_cost = self._plan_cost(fallback_routes, fallback_unassigned)
        fallback: PlanCandidate = (
            current_cost,
            copy.deepcopy(fallback_routes),
            list(fallback_unassigned),
        )
        elite_candidates: List[PlanCandidate] = [fallback]
        routes = copy.deepcopy(fallback_routes)
        unassigned = list(fallback_unassigned)

        depot_profiles = {
            (
                round(v.depot.latitude, 6),
                round(v.depot.longitude, 6),
                round((v.end_depot or v.depot).latitude, 6),
                round((v.end_depot or v.depot).longitude, 6),
            )
            for v in self.vehicles
        }
        vehicle_profiles = {
            (
                v.length_cm,
                v.width_cm,
                v.height_cm,
                v.payload_limit_kg,
                v.fixed_operating_cost_vnd,
            )
            for v in self.vehicles
        }

        if (
            not unassigned
            and len(depot_profiles) == 1
            and len(vehicle_profiles) == 1
            and self.time_limit_sec >= 2.0
        ):
            wave_cap = 3.0 if len(self.orders) >= 15 else 1.5
            wave_frac = 0.65 if len(self.orders) >= 15 else 0.35
            wave_deadline = min(
                deadline,
                time.perf_counter() + min(wave_cap, max(0.0, deadline - time.perf_counter()) * wave_frac),
            )
            wave_start = self._build_time_wave_start(wave_deadline)
            if wave_start is not None:
                w_cost, w_routes, w_unassigned = wave_start
                elite_candidates.append((w_cost, copy.deepcopy(w_routes), list(w_unassigned)))
                if w_cost < current_cost:
                    current_cost = w_cost
                    routes = copy.deepcopy(w_routes)
                    unassigned = list(w_unassigned)

        if (
            not unassigned
            and len(depot_profiles) == 1
            and len(vehicle_profiles) > 1
            and self.time_limit_sec >= 2.0
        ):
            warm_deadline = min(
                deadline,
                time.perf_counter() + min(1.5, max(0.0, deadline - time.perf_counter()) * 0.35),
            )
            warm_routes, warm_unassigned = self._sequential_construction(
                [order.id for order in self.orders],
                warm_deadline,
            )
            if not warm_unassigned:
                warm_cost = self._plan_cost(warm_routes, warm_unassigned)
                elite_candidates.append((warm_cost, copy.deepcopy(warm_routes), []))
                if warm_cost < current_cost:
                    current_cost = warm_cost
                    routes = copy.deepcopy(warm_routes)
                    unassigned = []

        if (
            not unassigned
            and len(depot_profiles) > 1
            and len(self.orders) >= 10
            and self.time_limit_sec >= 2.0
        ):
            md_deadline = min(
                deadline,
                time.perf_counter() + min(1.5, max(0.0, deadline - time.perf_counter()) * 0.35),
            )
            md_start = self._build_multi_depot_start(md_deadline)
            if md_start is not None:
                m_cost, m_routes, m_unassigned = md_start
                elite_candidates.append((m_cost, copy.deepcopy(m_routes), list(m_unassigned)))
                if m_cost < current_cost:
                    current_cost = m_cost
                    routes = copy.deepcopy(m_routes)
                    unassigned = list(m_unassigned)

        if (
            not unassigned
            and len(depot_profiles) == 1
            and len(self.orders) >= 10
            and self.time_limit_sec >= 2.0
        ):
            div_deadline = min(
                deadline,
                time.perf_counter() + min(1.8, max(0.0, deadline - time.perf_counter()) * 0.35),
            )
            div_start = self._build_diversified_start(div_deadline)
            if div_start is not None:
                d_cost, d_routes, d_unassigned = div_start
                elite_candidates.append((d_cost, copy.deepcopy(d_routes), list(d_unassigned)))
                if d_cost < current_cost:
                    current_cost = d_cost
                    routes = copy.deepcopy(d_routes)
                    unassigned = list(d_unassigned)

        if not unassigned and sum(bool(r) for r in routes) >= 2:
            elim_deadline = min(
                deadline,
                time.perf_counter() + min(3.0, max(0.0, deadline - time.perf_counter()) * 0.65),
            )
            elim_routes = self._eliminate_routes(routes, elim_deadline)
            for path_routes in self._last_elimination_path[1:]:
                p_cost = self._plan_cost(path_routes, unassigned)
                elite_candidates.append((p_cost, copy.deepcopy(path_routes), list(unassigned)))
            elim_cost = self._plan_cost(elim_routes, unassigned)
            if elim_cost < current_cost:
                current_cost = elim_cost
                routes = copy.deepcopy(elim_routes)
                elite_candidates.append((current_cost, copy.deepcopy(routes), list(unassigned)))

        order_ids = [order.id for order in self.orders]
        population: List[List[str]] = [list(order_ids)]
        consolidated_seq = self._assigned_order_ids(routes)
        if len(consolidated_seq) == len(order_ids) and consolidated_seq not in population:
            population.append(list(consolidated_seq))
        by_deadline = sorted(
            order_ids,
            key=lambda order_id: self.order_by_id[order_id].delivery_window_end_sec,
        )
        if by_deadline not in population:
            population.append(by_deadline)
        while len(population) < self.population_size:
            chromosome = list(order_ids)
            self.rng.shuffle(chromosome)
            population.append(chromosome)

        wave_seq = self._time_wave_order_sequence()
        if wave_seq and time.perf_counter() < deadline:
            wave_routes, wave_unassigned = self._sequential_construction(
                wave_seq,
                min(deadline, time.perf_counter() + min(1.5, max(0.0, deadline - time.perf_counter()) * 0.35)),
            )
            if not wave_unassigned:
                wave_cost = self._plan_cost(wave_routes, wave_unassigned)
                elite_candidates.append(
                    (wave_cost, copy.deepcopy(wave_routes), list(wave_unassigned))
                )

        search_deadline = deadline - min(0.6, self.time_limit_sec * 0.20)
        generation = 0
        while generation < self.max_iterations and time.perf_counter() < search_deadline:
            generation += 1
            scored = []
            for chromosome in population:
                if time.perf_counter() >= search_deadline:
                    break
                candidate = self._evaluate_chromosome(chromosome, search_deadline)
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

        if len(elite_candidates) >= 2:
            sp_time = min(0.3, max(0.1, self.time_limit_sec * 0.1))
            sp_res = self._solve_set_partitioning(elite_candidates, time_limit_sec=sp_time)
            if sp_res is not None:
                sp_cost, sp_routes, sp_unassigned = sp_res
                if not sp_unassigned:
                    elite_candidates.insert(0, (sp_cost, sp_routes, sp_unassigned))

        refine_deadline = max(deadline, time.perf_counter() + 0.15)
        if elite_candidates:
            leading = min(elite_candidates, key=lambda c: self._candidate_key(c[1], c[2]))
            l_cost, l_routes, l_unassigned = leading
            reassigned = self._best_vehicle_reassignment(l_routes, l_unassigned, refine_deadline)
            if reassigned is not None and self._candidate_key(reassigned[1], reassigned[2]) < self._candidate_key(l_routes, l_unassigned):
                l_cost, l_routes, l_unassigned = reassigned
                elite_candidates.insert(0, (l_cost, copy.deepcopy(l_routes), list(l_unassigned)))
            ex = self._best_order_exchange(l_routes, l_unassigned, refine_deadline)
            if ex is not None and ex[0] < l_cost:
                l_cost, l_routes, l_unassigned, aff = ex
                ref = self._best_intra_route_relocation(l_routes, l_unassigned, aff, refine_deadline)
                if ref is not None and ref[0] < l_cost:
                    l_cost, l_routes, l_unassigned = ref
                elite_candidates.insert(0, (l_cost, copy.deepcopy(l_routes), list(l_unassigned)))

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
