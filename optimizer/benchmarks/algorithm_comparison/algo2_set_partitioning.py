"""Algorithm 2: Route Pool Generation + CP-SAT Set Partitioning Matheuristic.

Decouples route generation (sampling diverse feasible single-vehicle routes) from global
solution assembly, using OR-Tools CP-SAT to solve the optimal set partitioning problem.
"""

from __future__ import annotations

import copy
import random
import time
from typing import Dict, List, Optional, Sequence, Set, Tuple
from ortools.sat.python import cp_model

from app.models import FleetOptimizationRequest
from app.hybrid_alns.models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OrderPair,
    ScheduledStop,
)
from app.hybrid_alns.packing_checker import FastPackingChecker
from app.hybrid_alns.route_evaluator import schedule_and_evaluate_route
from app.hybrid_alns.greedy_insertion import solve_greedy

from .common import (
    BenchmarkMetric,
    audit_with_spatial_validator,
    convert_request_to_hybrid,
)


class SetPartitioningMatheuristic:
    """Matheuristic that populates a route pool and solves exact Set Partitioning with CP-SAT."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        time_limit_sec: float = 10.0,
        random_seed: int = 42,
    ):
        self.request = request
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

    def _make_stops(self, order: OrderPair) -> Tuple[ScheduledStop, ScheduledStop]:
        pickup = ScheduledStop(
            sequence=0,
            stop_type="PICKUP",
            location_id=order.pickup_location.id,
            location_name=order.pickup_location.name,
            order_id=order.id,
            items_loaded=[item.id for item in order.items],
        )
        delivery = ScheduledStop(
            sequence=0,
            stop_type="DELIVERY",
            location_id=order.delivery_location.id,
            location_name=order.delivery_location.name,
            order_id=order.id,
            items_unloaded=[item.id for item in order.items],
        )
        return pickup, delivery

    def _evaluate_route(self, vehicle_idx: int, stops: List[ScheduledStop]):
        ev = schedule_and_evaluate_route(
            self.vehicles[vehicle_idx],
            self.drivers[vehicle_idx],
            stops,
            self.order_by_id,
            self.cargo_by_id,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
        )
        if not ev.feasible or ev.cost is None:
            return None
        # Packing check
        checker = FastPackingChecker(self.vehicles[vehicle_idx])
        valid, _ = checker.validate_route_stops(stops, self.cargo_by_id)
        if not valid:
            return None
        return ev

    def _generate_candidate_routes(self, deadline: float) -> List[Tuple[int, List[ScheduledStop], Set[str], int, float]]:
        """Phase 1: Generate diverse packing-feasible single routes using randomized heuristics."""
        pool: List[Tuple[int, List[ScheduledStop], Set[str], int, float]] = []
        seen_keys: Set[Tuple[int, Tuple[str, ...]]] = set()

        def add_to_pool(v_idx: int, stops: List[ScheduledStop], ev):
            if not stops:
                return
            route_sig = (v_idx, tuple(s.order_id + s.stop_type for s in stops))
            if route_sig in seen_keys:
                return
            seen_keys.add(route_sig)
            served = {s.order_id for s in stops if s.stop_type == "PICKUP" and s.order_id}
            pool.append((v_idx, stops, served, ev.cost.total_cost_vnd, ev.distance_km))

        # 1. Warm start with deterministic greedy solution
        initial = solve_greedy(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.dist_matrix,
            self.dur_matrix,
            self.node_to_idx,
        )
        for r in initial.routes:
            veh_idx = next((i for i, v in enumerate(self.vehicles) if v.id == r.vehicle.id), 0)
            ev = self._evaluate_route(veh_idx, r.stops)
            if ev:
                add_to_pool(veh_idx, r.stops, ev)

        # 2. Randomized construction runs with different vehicle-order seeds
        order_ids = [o.id for o in self.orders]
        sample_round = 0

        while time.perf_counter() < deadline and sample_round < 60:
            sample_round += 1
            shuffled_orders = list(order_ids)
            if sample_round % 3 == 0:
                shuffled_orders.sort(key=lambda o_id: self.order_by_id[o_id].pickup_window_start_sec)
            elif sample_round % 3 == 1:
                shuffled_orders.sort(key=lambda o_id: self.order_by_id[o_id].total_weight_kg, reverse=True)
            else:
                self.rng.shuffle(shuffled_orders)

            # Build sequential routes across vehicles
            for v_idx in range(len(self.vehicles)):
                if time.perf_counter() >= deadline:
                    break
                curr_stops: List[ScheduledStop] = []
                for o_id in shuffled_orders:
                    order = self.order_by_id[o_id]
                    if order.total_weight_kg > self.vehicles[v_idx].payload_limit_kg:
                        continue
                    p_stop, d_stop = self._make_stops(order)

                    best_c_stops = None
                    best_ev = None
                    best_delta = float("inf")

                    # Try insertion positions
                    for i in range(len(curr_stops) + 1):
                        for j in range(i + 1, len(curr_stops) + 2):
                            cand = curr_stops[:i] + [p_stop] + curr_stops[i : j - 1] + [d_stop] + curr_stops[j - 1 :]
                            ev = self._evaluate_route(v_idx, cand)
                            if ev is not None:
                                delta = ev.cost.total_cost_vnd
                                if delta < best_delta:
                                    best_delta = delta
                                    best_c_stops = cand
                                    best_ev = ev
                                break  # fast heuristic break

                    if best_c_stops is not None and best_ev is not None:
                        curr_stops = best_c_stops
                        add_to_pool(v_idx, curr_stops, best_ev)

        return pool

    def solve(self, case_name: str = "") -> BenchmarkMetric:
        started_at = time.perf_counter()
        pool_budget = max(1.0, self.time_limit_sec * 0.70)
        pool_deadline = started_at + pool_budget

        # Phase 1: Route sampling
        pool = self._generate_candidate_routes(pool_deadline)

        # Phase 2: CP-SAT Set Partitioning
        all_order_ids = {o.id for o in self.orders}
        order_to_routes: Dict[str, List[int]] = {o_id: [] for o_id in all_order_ids}
        for r_idx, (_, _, served, _, _) in enumerate(pool):
            for o_id in served:
                if o_id in order_to_routes:
                    order_to_routes[o_id].append(r_idx)

        # Build CP-SAT optimization model
        model = cp_model.CpModel()
        route_vars = [model.NewBoolVar(f"r_{i}") for i in range(len(pool))]
        unassigned_vars = {o_id: model.NewBoolVar(f"un_{o_id}") for o_id in all_order_ids}

        # Set covering with penalty for unassigned orders
        for o_id, r_indices in order_to_routes.items():
            model.Add(sum(route_vars[ri] for ri in r_indices) + unassigned_vars[o_id] == 1)

        # Each vehicle runs at most 1 route
        vehicle_to_routes: Dict[int, List[int]] = {}
        for r_idx, (v_idx, _, _, _, _) in enumerate(pool):
            vehicle_to_routes.setdefault(v_idx, []).append(r_idx)
        for v_idx, r_indices in vehicle_to_routes.items():
            model.Add(sum(route_vars[ri] for ri in r_indices) <= 1)

        # Each physical vehicle and driver on same day runs at most 1 route
        day_plate_routes: Dict[Tuple[int, str], List[int]] = {}
        day_driver_routes: Dict[Tuple[int, str], List[int]] = {}
        for r_idx, (v_idx, _, _, _, _) in enumerate(pool):
            veh = self.vehicles[v_idx]
            key = (veh.service_day_index, veh.source_vehicle_id or veh.plate_number or veh.id)
            day_plate_routes.setdefault(key, []).append(r_idx)
            if v_idx < len(self.drivers):
                drv = self.drivers[v_idx]
                d_key = (drv.service_day_index, drv.source_driver_id or drv.id)
                day_driver_routes.setdefault(d_key, []).append(r_idx)
        for key, r_indices in day_plate_routes.items():
            if len(r_indices) > 1:
                model.Add(sum(route_vars[ri] for ri in r_indices) <= 1)
        for d_key, r_indices in day_driver_routes.items():
            if len(r_indices) > 1:
                model.Add(sum(route_vars[ri] for ri in r_indices) <= 1)

        # Objective: minimize route costs + unassigned penalties
        unassigned_penalty = int(self.policy.unassigned_order_penalty_vnd)
        obj_terms = [cost * route_vars[ri] for ri, (_, _, _, cost, _) in enumerate(pool)]
        obj_terms.extend([unassigned_penalty * unassigned_vars[o_id] for o_id in all_order_ids])
        model.Minimize(sum(obj_terms))

        sat_time_limit = max(0.5, self.time_limit_sec - (time.perf_counter() - started_at))
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = sat_time_limit
        solver.parameters.num_workers = 2
        status = solver.Solve(model)

        elapsed = round(time.perf_counter() - started_at, 3)

        chosen_routes: List[Tuple[int, List[ScheduledStop], float, int]] = []
        unassigned: List[str] = []

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            for ri, (v_idx, stops, _, cost, dist) in enumerate(pool):
                if solver.Value(route_vars[ri]) == 1:
                    chosen_routes.append((v_idx, stops, dist, cost))
            for o_id in all_order_ids:
                if solver.Value(unassigned_vars[o_id]) == 1:
                    unassigned.append(o_id)

        # Phase 3: Spatial Validation on chosen routes
        prod_order_by_id = {o.id: o for o in self.request.orders}
        all_passed_spatial = True
        spatial_msg = "Pass"

        for v_idx, stops, _, _ in chosen_routes:
            veh = next((v for v in self.request.vehicles if v.id == self.vehicles[v_idx].id), None)
            if not veh:
                continue
            passed, msg = audit_with_spatial_validator(
                veh, stops, prod_order_by_id, max_time_seconds=2.0
            )
            if not passed:
                all_passed_spatial = False
                spatial_msg = msg
                break

        served_count = len(self.orders) - len(unassigned)
        fulfillment = (served_count / max(1, len(self.orders))) * 100.0
        total_cost = sum(c for _, _, _, c in chosen_routes) + len(unassigned) * unassigned_penalty
        total_dist = sum(d for _, _, d, _ in chosen_routes)

        return BenchmarkMetric(
            algorithm_name="2. Set Partitioning Matheuristic",
            case_file=case_name,
            status="SUCCESS" if not unassigned and all_passed_spatial else "PARTIAL",
            orders_served=served_count,
            total_orders=len(self.orders),
            fulfillment_rate_pct=round(fulfillment, 1),
            vehicles_used=len(chosen_routes),
            total_cost_vnd=int(total_cost),
            selection_score_vnd=int(total_cost),
            total_distance_km=round(total_dist, 2),
            runtime_sec=elapsed,
            spatial_audit_pass=all_passed_spatial,
            diagnostic=f"Pool size: {len(pool)} routes | CP-SAT: {solver.StatusName(status)} | Spatial: {spatial_msg}",
        )
