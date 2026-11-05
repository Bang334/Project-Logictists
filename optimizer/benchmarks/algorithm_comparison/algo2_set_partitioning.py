"""Algorithm 2: Guided Variable Neighborhood Search + Pool Matheuristic (GVNS-Pool).

Replaces the weak standalone Set Partitioning column generator with a strong
packing-aware Guided Variable Neighborhood Search (GVNS) coupled with
route-elimination consolidation and exact CP-SAT Set Partitioning recombination
over the verified elite route pool.
"""

from __future__ import annotations

import copy
import math
import time
from typing import List

from app.models import FleetOptimizationRequest
from app.hybrid_alns.models import OptimizationSolution
from app.hybrid_alns.advanced_metaheuristics import (
    PackingAwareVNSSolver,
    PlanCandidate,
)

from .common import (
    BenchmarkMetric,
    audit_with_spatial_validator,
    convert_request_to_hybrid,
)


class _GVNSPoolEngine(PackingAwareVNSSolver):
    """Guided VNS with warm-start consolidation and CP-SAT Set Partitioning pool."""

    def _best_relocation(
        self,
        routes,
        unassigned,
        deadline: float,
        *,
        sample_limit: int = 12,
    ):
        return self._best_relocation_candidate(
            routes,
            unassigned,
            deadline,
            sample_limit=sample_limit,
            option_limit=6,
        )

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        routes, unassigned = self._initial_state()
        current_cost = self._plan_cost(routes, unassigned)
        fallback: PlanCandidate = (
            current_cost,
            copy.deepcopy(routes),
            list(unassigned),
        )
        elite_candidates: List[PlanCandidate] = [fallback]

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

        current_routes = copy.deepcopy(routes)
        current_unassigned = list(unassigned)
        best_routes = copy.deepcopy(routes)
        best_unassigned = list(unassigned)
        best_cost = current_cost

        neighborhoods = (
            ("route", "regret3"),
            ("related", "regret2"),
            ("string", "regret3"),
            ("worst", "regret3"),
            ("random", "greedy"),
        )
        neighborhood_index = 0
        iteration = 0
        shake_cycle = 0
        temperature = max(1.0, current_cost * 0.015)

        vns_deadline = max(time.perf_counter(), deadline - min(0.6, self.time_limit_sec * 0.20))
        while iteration < self.max_iterations and time.perf_counter() < vns_deadline:
            iteration += 1
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break
            destroy_name, repair_name = neighborhoods[neighborhood_index]
            remove_count = min(
                assigned_count,
                1 + neighborhood_index + (1 if assigned_count >= 12 else 0),
            )
            destroyed, removed = self.destroy_operators[destroy_name](
                copy.deepcopy(current_routes), remove_count
            )
            candidate_routes, candidate_unassigned = self._repair(
                destroyed,
                list(dict.fromkeys(current_unassigned + removed)),
                repair_name,
                vns_deadline,
            )
            candidate_cost = self._plan_cost(candidate_routes, candidate_unassigned)
            delta = candidate_cost - current_cost
            accepted = delta < 0 or self.rng.random() < math.exp(-delta / max(1.0, temperature))
            temperature *= 0.994

            if accepted:
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost
                if delta < 0:
                    neighborhood_index = 0
                    for v_i, r_stops in enumerate(candidate_routes):
                        if r_stops and len(self._route_pool) < 600:
                            self._route_pool.append((v_i, copy.deepcopy(r_stops)))
                else:
                    neighborhood_index = (neighborhood_index + 1) % len(neighborhoods)
                if candidate_cost < best_cost and len(candidate_unassigned) <= len(best_unassigned):
                    best_cost = candidate_cost
                    best_routes = copy.deepcopy(candidate_routes)
                    best_unassigned = list(candidate_unassigned)
                    elite_candidates.append(
                        (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
                    )
                continue

            neighborhood_index += 1
            if neighborhood_index < len(neighborhoods):
                continue

            neighborhood_index = 0
            relocated = self._best_relocation(best_routes, best_unassigned, vns_deadline)
            if relocated is not None and relocated[0] < best_cost:
                best_cost, best_routes, best_unassigned = relocated
                current_cost, current_routes, current_unassigned = (
                    best_cost,
                    copy.deepcopy(best_routes),
                    list(best_unassigned),
                )
                elite_candidates.append(
                    (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
                )
                for v_i, r_stops in enumerate(best_routes):
                    if r_stops and len(self._route_pool) < 600:
                        self._route_pool.append((v_i, copy.deepcopy(r_stops)))
                shake_cycle = 0
                continue

            exchanged = self._best_order_exchange(best_routes, best_unassigned, vns_deadline)
            if exchanged is not None and exchanged[0] < best_cost:
                best_cost, best_routes, best_unassigned, affected = exchanged
                refined = self._best_intra_route_relocation(best_routes, best_unassigned, affected, vns_deadline)
                if refined is not None and refined[0] < best_cost:
                    best_cost, best_routes, best_unassigned = refined
                current_cost, current_routes, current_unassigned = (
                    best_cost,
                    copy.deepcopy(best_routes),
                    list(best_unassigned),
                )
                elite_candidates.append(
                    (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
                )
                for v_i, r_stops in enumerate(best_routes):
                    if r_stops and len(self._route_pool) < 600:
                        self._route_pool.append((v_i, copy.deepcopy(r_stops)))
                shake_cycle = 0
                continue

            reassigned = self._best_vehicle_reassignment(best_routes, best_unassigned, vns_deadline)
            if reassigned is not None and reassigned[0] < best_cost:
                best_cost, best_routes, best_unassigned = reassigned
                current_cost, current_routes, current_unassigned = (
                    best_cost,
                    copy.deepcopy(best_routes),
                    list(best_unassigned),
                )
                elite_candidates.append(
                    (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
                )
                for v_i, r_stops in enumerate(best_routes):
                    if r_stops and len(self._route_pool) < 600:
                        self._route_pool.append((v_i, copy.deepcopy(r_stops)))
                shake_cycle = 0
                continue

            shake_cycle += 1
            shake_count = min(
                assigned_count,
                max(2, round(assigned_count * min(0.35, 0.15 + 0.05 * shake_cycle))),
            )
            shaken, removed = self.destroy_operators["related" if shake_cycle % 2 else "random"](
                copy.deepcopy(best_routes), shake_count
            )
            current_routes, current_unassigned = self._repair(
                shaken,
                list(dict.fromkeys(best_unassigned + removed)),
                "regret3",
                vns_deadline,
            )
            current_cost = self._plan_cost(current_routes, current_unassigned)
            if current_cost < best_cost:
                best_cost = current_cost
                best_routes = copy.deepcopy(current_routes)
                best_unassigned = list(current_unassigned)
                elite_candidates.append(
                    (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
                )

        refine_deadline = max(deadline, time.perf_counter() + 0.15)
        if len(elite_candidates) >= 2:
            sp_result = self._solve_set_partitioning(
                elite_candidates,
                time_limit_sec=min(0.3, max(0.1, self.time_limit_sec * 0.1)),
            )
            if sp_result is not None and not sp_result[2]:
                elite_candidates.insert(0, sp_result)

        if elite_candidates:
            leading = min(elite_candidates, key=lambda c: self._candidate_key(c[1], c[2]))
            l_cost, l_routes, l_unassigned = leading
            reassigned = self._best_vehicle_reassignment(l_routes, l_unassigned, refine_deadline)
            if reassigned is not None and self._candidate_key(reassigned[1], reassigned[2]) < self._candidate_key(l_routes, l_unassigned):
                elite_candidates.insert(0, (reassigned[0], copy.deepcopy(reassigned[1]), list(reassigned[2])))

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            f"GVNS + Set-Partitioning Pool ({iteration} VNS iters)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
        )


class GuidedVNSPoolMatheuristic:
    """Guided Variable Neighborhood Search + Set Partitioning Pool Recombination."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        time_limit_sec: float = 10.0,
        random_seed: int = 42,
    ):
        self.request = request
        self.time_limit_sec = time_limit_sec
        self.random_seed = random_seed

        (
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
        ) = convert_request_to_hybrid(request)

    def solve(self, case_name: str = "") -> BenchmarkMetric:
        started_at = time.perf_counter()

        solver = _GVNSPoolEngine(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
            time_limit_sec=self.time_limit_sec,
            max_iterations=350,
            random_seed=self.random_seed + 7,
            final_spatial_time_limit_sec=min(3.0, max(2.0, self.time_limit_sec * 0.3)),
            final_repair_time_limit_sec=min(4.0, max(2.5, self.time_limit_sec * 0.4)),
            max_elite_audit_candidates=8,
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
            algorithm_name="2. Guided VNS + Pool Matheuristic (GVNS-Pool)",
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


# Backward-compatible export alias
SetPartitioningMatheuristic = GuidedVNSPoolMatheuristic
