"""Algorithm 3: Calibrated Adaptive Simulated Annealing + ILS (CASA-ILS).

Replaces the weak Logic-Based Benders decomposition (which suffered from master/subproblem
cuts disconnecting 2D spatial packing from routing distance) with a high-performance
Calibrated Adaptive Simulated Annealing + Iterated Local Search (CASA-ILS) metaheuristic.
"""

from __future__ import annotations

import copy
import math
import time
from typing import List

from app.models import FleetOptimizationRequest
from app.hybrid_alns.models import OptimizationSolution
from app.hybrid_alns.advanced_metaheuristics import (
    AdaptivePackingAwareSimulatedAnnealingSolver,
    PlanCandidate,
)

from .common import (
    BenchmarkMetric,
    audit_with_spatial_validator,
    convert_request_to_hybrid,
)


class _CASAILSEngine(AdaptivePackingAwareSimulatedAnnealingSolver):
    """Calibrated Adaptive SA + ILS with time-wave/multi-depot warm starts and route elimination."""

    def solve(self) -> OptimizationSolution:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        routes, unassigned = self._initial_state()
        initial_cost = self._plan_cost(routes, unassigned)
        fallback: PlanCandidate = (
            initial_cost,
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
                if w_cost < initial_cost:
                    initial_cost = w_cost
                    routes = copy.deepcopy(w_routes)
                    unassigned = list(w_unassigned)

        if (
            not unassigned
            and len(depot_profiles) > 1
            and len(self.orders) >= 10
            and self.time_limit_sec >= 2.0
        ):
            md_deadline = min(
                deadline,
                time.perf_counter() + min(3.5, max(0.0, deadline - time.perf_counter()) * 0.65),
            )
            md_start = self._build_multi_depot_start(md_deadline)
            if md_start is not None:
                m_cost, m_routes, m_unassigned = md_start
                elite_candidates.append((m_cost, copy.deepcopy(m_routes), list(m_unassigned)))
                if m_cost < initial_cost:
                    initial_cost = m_cost
                    routes = copy.deepcopy(m_routes)
                    unassigned = list(m_unassigned)

        if len(depot_profiles) == 1:
            diversified, extra_elites = self._try_diversified_start(
                routes,
                unassigned,
                started_at,
                deadline,
            )
            if extra_elites:
                elite_candidates.extend(extra_elites)
            if diversified is not None and diversified[0] < initial_cost:
                initial_cost, d_routes, d_unassigned = diversified
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
            if elim_cost < initial_cost:
                initial_cost = elim_cost
                routes = copy.deepcopy(elim_routes)
                elite_candidates.append((initial_cost, copy.deepcopy(routes), list(unassigned)))

        current_routes = copy.deepcopy(routes)
        current_unassigned = list(unassigned)
        current_cost = initial_cost
        best_routes = copy.deepcopy(routes)
        best_unassigned = list(unassigned)
        best_cost = initial_cost
        search_started_at = time.perf_counter()
        sa_deadline = max(search_started_at, deadline - min(1.2, self.time_limit_sec * 0.18))
        search_duration = max(0.001, sa_deadline - search_started_at)
        initial_temperature = max(50_000.0, current_cost * 0.04)
        positive_deltas: List[int] = []
        stagnant = 0
        iteration = 0

        destroy_weights = {
            name: 1.0 for name in tuple(self.destroy_operators) + ("route",)
        }
        repair_weights = {name: 1.0 for name in self.repair_operators}

        while iteration < self.max_iterations and time.perf_counter() < sa_deadline:
            assigned_count = len(self._assigned_order_ids(current_routes))
            if assigned_count == 0:
                break
            iteration += 1
            progress = min(
                1.0,
                max(0.0, (time.perf_counter() - search_started_at) / search_duration),
            )
            initial_temperature = self._calibrated_temperature(
                positive_deltas,
                initial_temperature,
            )
            final_temperature = max(1.0, initial_temperature * 0.03)
            temperature = initial_temperature * (
                final_temperature / initial_temperature
            ) ** (progress ** 1.15)
            if stagnant >= self.intensify_after // 2:
                temperature = max(temperature, initial_temperature * 0.35)

            base_fraction = 0.12 if stagnant < self.intensify_after // 2 else 0.28
            remove_cap = max(1, min(8, round(assigned_count * base_fraction)))
            remove_count = self.rng.randint(1, remove_cap)
            destroy_name = self._weighted_choice(destroy_weights)
            repair_name = self._weighted_choice(repair_weights)
            destroy_operator = (
                self._destroy_route
                if destroy_name == "route"
                else self.destroy_operators[destroy_name]
            )
            destroyed, removed = destroy_operator(
                copy.deepcopy(current_routes),
                remove_count,
            )
            candidate_routes, candidate_unassigned = self._repair(
                destroyed,
                list(dict.fromkeys(current_unassigned + removed)),
                repair_name,
                sa_deadline,
            )
            candidate_cost = self._plan_cost(
                candidate_routes,
                candidate_unassigned,
            )
            delta = candidate_cost - current_cost
            if delta > 0 and len(positive_deltas) < 24:
                positive_deltas.append(delta)
            accepted = delta <= 0 or self.rng.random() < math.exp(
                -delta / max(1.0, temperature)
            )
            score = 0.25
            if accepted:
                current_routes = candidate_routes
                current_unassigned = candidate_unassigned
                current_cost = candidate_cost
                score = 1.0 if delta >= 0 else 3.0

            cand_vehicles = sum(bool(r) for r in candidate_routes)
            curr_vehicles = sum(bool(r) for r in current_routes)
            if cand_vehicles < curr_vehicles and not candidate_unassigned:
                score += 4.0

            if candidate_cost < best_cost:
                best_cost = candidate_cost
                best_routes = copy.deepcopy(candidate_routes)
                best_unassigned = list(candidate_unassigned)
                elite_candidates.append(
                    (
                        best_cost,
                        copy.deepcopy(best_routes),
                        list(best_unassigned),
                    )
                )
                stagnant = 0
                score = 6.0
            else:
                stagnant += 1
            self._update_weight(destroy_weights, destroy_name, score)
            self._update_weight(repair_weights, repair_name, score)

            if (
                stagnant >= self.intensify_after
                and time.perf_counter() < sa_deadline
            ):
                intensified = self._best_relocation_candidate(
                    best_routes,
                    best_unassigned,
                    sa_deadline,
                    sample_limit=16,
                    option_limit=8,
                )
                if intensified is not None and intensified[0] < best_cost:
                    best_cost, best_routes, best_unassigned = intensified
                    current_cost = best_cost
                    current_routes = copy.deepcopy(best_routes)
                    current_unassigned = list(best_unassigned)
                    elite_candidates.append(
                        (
                            best_cost,
                            copy.deepcopy(best_routes),
                            list(best_unassigned),
                        )
                    )
                else:
                    current_routes = copy.deepcopy(best_routes)
                    current_unassigned = list(best_unassigned)
                    current_cost = best_cost
                stagnant = 0

        # Final ILS intensification (inter-route relocation + reciprocal exchange)
        while time.perf_counter() < deadline:
            relocated = self._best_relocation_candidate(
                best_routes,
                best_unassigned,
                deadline,
                sample_limit=min(16, len(self.orders)),
                option_limit=6,
            )
            if relocated is None or relocated[0] >= best_cost:
                break
            best_cost, best_routes, best_unassigned = relocated
            elite_candidates.append(
                (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
            )

        if time.perf_counter() < deadline:
            exchanged = self._best_order_exchange(
                best_routes,
                best_unassigned,
                deadline,
            )
            if exchanged is not None and exchanged[0] < best_cost:
                best_cost, best_routes, best_unassigned, affected = exchanged
                refined = self._best_intra_route_relocation(
                    best_routes, best_unassigned, affected, deadline
                )
                if refined is not None and refined[0] < best_cost:
                    best_cost, best_routes, best_unassigned = refined
                elite_candidates.append(
                    (best_cost, copy.deepcopy(best_routes), list(best_unassigned))
                )

        return self._finalize_best_valid(
            elite_candidates,
            fallback,
            started_at,
            f"Calibrated Adaptive SA + ILS ({iteration} SA iters)",
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
            repair_time_limit_sec=self.final_repair_time_limit_sec,
            max_audit_candidates=self.max_elite_audit_candidates,
        )


class CalibratedAdaptiveSAILSOptimizer:
    """Calibrated Adaptive Simulated Annealing + Iterated Local Search (CASA-ILS)."""

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

        solver = _CASAILSEngine(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
            time_limit_sec=self.time_limit_sec,
            max_iterations=350,
            random_seed=self.random_seed + 19,
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
            algorithm_name="3. Calibrated Adaptive SA + ILS (CASA-ILS)",
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
LogicBasedBendersOptimizer = CalibratedAdaptiveSAILSOptimizer
