"""Packing-aware Iterated Local Search for the production fleet contract.

The algorithm keeps the production validator as the source of truth.  Its
neighborhood only contains pickup/delivery relocations that pass payload,
time-window, vehicle-availability and fast packing checks; the returned plan
is then audited again by ``SpatialValidator``.
"""

import copy
import time
from typing import Dict, List, Optional, Set, Tuple

from .alns_engine import ALNSFleetOptimizer
from .baseline_calculator import BaselineCostCalculator
from .models import FleetOptimizationRequest, FleetOptimizationResponse, ScheduledStop
from .planning_objective import plan_lexicographic_key


class PackingAwareILSOptimizer(ALNSFleetOptimizer):
    """Best-improvement relocation with ruin/recreate perturbations."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        max_iterations: int = 150,
        time_budget_seconds: Optional[float] = None,
        random_seed: int = 0,
        include_benchmarks: bool = True,
    ) -> None:
        super().__init__(
            request,
            max_iterations=max_iterations,
            time_budget_seconds=time_budget_seconds,
            random_seed=random_seed,
        )
        self.include_benchmarks = include_benchmarks

    @staticmethod
    def _assigned_order_ids(routes: List[List[ScheduledStop]]) -> List[str]:
        return list(
            dict.fromkeys(
                stop.allocation_id or stop.order_id
                for route in routes
                for stop in route
                if stop.stop_type == "PICKUP"
                and (stop.allocation_id or stop.order_id)
            )
        )

    @staticmethod
    def _remove_order(
        routes: List[List[ScheduledStop]], order_id: str
    ) -> List[List[ScheduledStop]]:
        return [
            [
                stop
                for stop in route
                if (stop.allocation_id or stop.order_id) != order_id
            ]
            for route in routes
        ]

    def _candidate_key(
        self, routes: List[List[ScheduledStop]], unassigned: List[str]
    ) -> Tuple[int, int, int, int]:
        order_routes: Dict[str, Set[int]] = {}
        for v_idx, stops in enumerate(routes):
            for st in stops:
                if getattr(st, "stop_type", None) == "PICKUP":
                    oid = getattr(st, "allocation_id", None) or getattr(st, "order_id", None)
                    order_by_id = getattr(self, "order_by_id", {})
                    if oid in order_by_id:
                        parent_id = getattr(order_by_id[oid], "source_order_id", None) or oid
                        order_routes.setdefault(parent_id, set()).add(v_idx)
        extra_trips = sum(max(0, len(v_set) - 1) for v_set in order_routes.values())
        active_routes = sum(bool(r) for r in routes)
        eval_res = self._evaluate_plan_cost(routes, unassigned)
        total_economic = eval_res[1] if len(eval_res) > 1 else eval_res[0]
        return (len(unassigned), extra_trips, active_routes, total_economic)

    def _best_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        started_at: float,
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        current_key = self._candidate_key(routes, unassigned)
        best_neighbor = None
        assigned = self._assigned_order_ids(routes)
        self.rng.shuffle(assigned)

        for order_id in assigned[: min(12, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_order(routes, order_id)
            candidate_routes, failed = self._repair_greedy_insert(
                copy.deepcopy(reduced), [order_id], start_time=started_at
            )
            candidate_unassigned = list(dict.fromkeys(unassigned + failed))
            candidate_key = self._candidate_key(
                candidate_routes, candidate_unassigned
            )
            if candidate_key >= current_key:
                continue
            if best_neighbor is None or candidate_key < best_neighbor[0]:
                candidate_cost, _, _ = self._evaluate_plan_cost(
                    candidate_routes, candidate_unassigned
                )
                best_neighbor = (
                    candidate_key,
                    candidate_cost,
                    candidate_routes,
                    candidate_unassigned,
                )
        if best_neighbor is not None:
            return (best_neighbor[1], best_neighbor[2], best_neighbor[3])
        return None

    def _try_route_elimination(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        started_at: float,
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        active_indices = sorted(
            [i for i, r in enumerate(routes) if r],
            key=lambda i: len([st for st in routes[i] if st.stop_type == "PICKUP"]),
        )
        if len(active_indices) < 2:
            return None
        current_key = self._candidate_key(routes, unassigned)
        for cand_v in active_indices[:2]:
            if time.perf_counter() >= deadline:
                break
            cand_orders = list(dict.fromkeys(st.allocation_id or st.order_id for st in routes[cand_v] if st.stop_type == "PICKUP"))
            reduced = copy.deepcopy(routes)
            reduced[cand_v] = []
            rep_routes, failed = self._repair_greedy_insert(
                reduced, cand_orders, start_time=started_at, randomize=False
            )
            if not failed:
                c_key = self._candidate_key(rep_routes, unassigned)
                if c_key < current_key:
                    cost, _, _ = self._evaluate_plan_cost(rep_routes, unassigned)
                    return (cost, rep_routes, list(unassigned))
        return None

    def _try_order_swap_1_1(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        started_at: float,
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        active_indices = [i for i, r in enumerate(routes) if r]
        if len(active_indices) < 2:
            return None
        current_key = self._candidate_key(routes, unassigned)
        best_cand = None
        for i, v1 in enumerate(active_indices):
            for v2 in active_indices[i + 1:]:
                orders1 = list(dict.fromkeys(st.allocation_id or st.order_id for st in routes[v1] if st.stop_type == "PICKUP"))[:4]
                orders2 = list(dict.fromkeys(st.allocation_id or st.order_id for st in routes[v2] if st.stop_type == "PICKUP"))[:4]
                for o1 in orders1:
                    for o2 in orders2:
                        if time.perf_counter() >= deadline:
                            if best_cand is not None:
                                return (best_cand[1], best_cand[2], best_cand[3])
                            return None
                        red = self._remove_order(routes, o1)
                        red = self._remove_order(red, o2)
                        red2, f1 = self._repair_greedy_insert(copy.deepcopy(red), [o1], start_time=started_at)
                        if f1:
                            continue
                        red3, f2 = self._repair_greedy_insert(red2, [o2], start_time=started_at)
                        if f2:
                            continue
                        c_key = self._candidate_key(red3, unassigned)
                        if c_key < current_key:
                            if best_cand is None or c_key < best_cand[0]:
                                cost, _, _ = self._evaluate_plan_cost(red3, unassigned)
                                best_cand = (c_key, cost, red3, list(unassigned))
        if best_cand is not None:
            return (best_cand[1], best_cand[2], best_cand[3])
        return None

    def _try_vehicle_reassignment(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str]]]:
        current_cost, _, _ = self._evaluate_plan_cost(routes, unassigned)
        current_key = self._candidate_key(routes, unassigned)
        best_cand = None
        active_indices = [i for i, r in enumerate(routes) if r]
        empty_indices = [i for i, r in enumerate(routes) if not r]

        for src_i in active_indices:
            src_v = self.vehicles[src_i]
            stops = routes[src_i]
            w = 0.0
            max_w = 0.0
            for st in stops:
                oid = st.allocation_id or st.order_id
                ord_obj = self.order_by_id.get(oid) if oid else None
                if ord_obj:
                    w += ord_obj.total_weight_kg if st.stop_type == "PICKUP" else -ord_obj.total_weight_kg
                    if w > max_w:
                        max_w = w
            for tgt_i in empty_indices:
                tgt_v = self.vehicles[tgt_i]
                if (
                    tgt_v.service_day_index >= src_v.service_day_index
                    and tgt_v.fixed_operating_cost_vnd >= src_v.fixed_operating_cost_vnd
                    and tgt_v.fuel_consumption_liters_per_100_km >= src_v.fuel_consumption_liters_per_100_km
                ):
                    continue
                if max_w > tgt_v.payload_limit_kg + 0.01:
                    continue
                if not self._vehicle_has_compatible_driver(tgt_v) or any(
                    not self._order_allows_vehicle(self.order_by_id[s.allocation_id or s.order_id], tgt_v)
                    for s in stops
                    if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id) in self.order_by_id
                ):
                    continue
                if self._schedule_stops(tgt_i, stops) is not None and self._validate_stops_cached(tgt_i, stops):
                    cand_routes = copy.deepcopy(routes)
                    cand_routes[src_i] = []
                    cand_routes[tgt_i] = copy.deepcopy(stops)
                    c_cost, _, _ = self._evaluate_plan_cost(cand_routes, unassigned)
                    c_key = self._candidate_key(cand_routes, unassigned)
                    if c_key < current_key:
                        if best_cand is None or c_key < best_cand[0]:
                            best_cand = (c_key, c_cost, cand_routes, list(unassigned))
        if best_cand is not None:
            return (best_cand[1], best_cand[2], best_cand[3])
        return None

    def solve(self) -> FleetOptimizationResponse:
        started_at = time.perf_counter()
        deadline = started_at + self.time_limit_sec
        current_routes: List[List[ScheduledStop]] = [
            [] for _ in self.vehicles
        ]
        self._allow_layout_search = False
        current_routes, current_unassigned = self._repair_greedy_insert(
            current_routes,
            [order.id for order in self.orders],
            start_time=started_at,
            randomize=False,
        )
        current_cost, _, _ = self._evaluate_plan_cost(
            current_routes, current_unassigned
        )
        current_key = self._candidate_key(current_routes, current_unassigned)
        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_cost = current_cost
        best_key = current_key
        initial_routes = copy.deepcopy(current_routes)
        initial_unassigned = list(current_unassigned)
        iteration = 0
        perturbation = 0

        elite_candidates = [
            (best_key, copy.deepcopy(best_routes), list(best_unassigned))
        ]

        while iteration < self.max_iterations and time.perf_counter() < deadline:
            iteration += 1
            neighbor = self._best_relocation(
                current_routes,
                current_unassigned,
                started_at,
                deadline,
            )
            if neighbor is not None:
                current_cost, current_routes, current_unassigned = neighbor
                current_key = self._candidate_key(current_routes, current_unassigned)
                if current_key < best_key:
                    best_key = current_key
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                    perturbation = 0
                    elite_candidates.append(
                        (best_key, copy.deepcopy(best_routes), list(best_unassigned))
                    )
                continue

            elim = self._try_route_elimination(
                current_routes, current_unassigned, started_at, deadline
            )
            if elim is not None:
                current_cost, current_routes, current_unassigned = elim
                current_key = self._candidate_key(current_routes, current_unassigned)
                if current_key < best_key:
                    best_key = current_key
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                    perturbation = 0
                    elite_candidates.append(
                        (best_key, copy.deepcopy(best_routes), list(best_unassigned))
                    )
                continue

            swapped = self._try_order_swap_1_1(
                current_routes, current_unassigned, started_at, deadline
            )
            if swapped is not None:
                current_cost, current_routes, current_unassigned = swapped
                current_key = self._candidate_key(current_routes, current_unassigned)
                if current_key < best_key:
                    best_key = current_key
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                    perturbation = 0
                    elite_candidates.append(
                        (best_key, copy.deepcopy(best_routes), list(best_unassigned))
                    )
                continue

            reassigned = self._try_vehicle_reassignment(current_routes, current_unassigned)
            if reassigned is not None:
                current_cost, current_routes, current_unassigned = reassigned
                current_key = self._candidate_key(current_routes, current_unassigned)
                if current_key < best_key:
                    best_key = current_key
                    best_cost = current_cost
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                    perturbation = 0
                    elite_candidates.append(
                        (best_key, copy.deepcopy(best_routes), list(best_unassigned))
                    )
                continue

            assigned_count = len(self._assigned_order_ids(best_routes))
            if assigned_count == 0 or time.perf_counter() >= deadline:
                break

            perturbation += 1
            removal_ratio = min(0.4, 0.15 + 0.05 * perturbation)
            remove_count = min(
                assigned_count,
                max(2, round(assigned_count * removal_ratio)),
            )
            perturbed, removed = self._destroy_random(
                copy.deepcopy(best_routes), remove_count
            )
            current_routes, failed = self._repair_greedy_insert(
                perturbed,
                list(dict.fromkeys(best_unassigned + removed)),
                start_time=started_at,
            )
            current_unassigned = failed
            current_cost, _, _ = self._evaluate_plan_cost(
                current_routes, current_unassigned
            )
            current_key = self._candidate_key(current_routes, current_unassigned)
            if current_key < best_key:
                best_key = current_key
                best_cost = current_cost
                best_routes = copy.deepcopy(current_routes)
                best_unassigned = list(current_unassigned)
                perturbation = 0
                elite_candidates.append(
                    (best_key, copy.deepcopy(best_routes), list(best_unassigned))
                )

        reassigned = self._try_vehicle_reassignment(best_routes, best_unassigned)
        if reassigned is not None:
            best_cost, best_routes, best_unassigned = reassigned
            best_key = self._candidate_key(best_routes, best_unassigned)
            elite_candidates.insert(0, (best_key, copy.deepcopy(best_routes), list(best_unassigned)))

        # Select up to 3 distinct elite candidates
        elite_candidates.sort(key=lambda x: x[0])
        unique_elites = []
        seen_sig = set()
        for cand in elite_candidates:
            sig = tuple(tuple(getattr(st, "allocation_id", None) or getattr(st, "order_id", None) or str(st) for st in r) for r in cand[1])
            if sig not in seen_sig:
                seen_sig.add(sig)
                unique_elites.append(cand)
            if len(unique_elites) >= 3:
                break

        def _safe_build(c_routes, c_unassigned, *, include_benchmarks=True, spatial_budget=None):
            try:
                return self._build_final_response(
                    c_routes,
                    c_unassigned,
                    include_benchmarks=include_benchmarks and getattr(self, "include_benchmarks", True),
                    spatial_time_budget_seconds=spatial_budget,
                )
            except TypeError:
                return self._build_final_response(c_routes, c_unassigned)

        spatial_budget = min(1.5, max(0.5, self.time_limit_sec * 0.35))
        valid_responses: List[FleetOptimizationResponse] = []
        for _key, cand_routes, cand_unassigned in unique_elites:
            resp = _safe_build(
                cand_routes,
                cand_unassigned,
                include_benchmarks=False,
                spatial_budget=spatial_budget,
            )
            if getattr(resp, "unassigned_orders", None) == []:
                valid_responses.append(resp)
            elif not valid_responses:
                valid_responses.append(resp)

        if not valid_responses:
            response = _safe_build(best_routes, best_unassigned)
        else:
            response = min(
                valid_responses,
                key=lambda r: (
                    len({getattr(o, "order_id", str(o)) for o in getattr(r, "unassigned_orders", [])}),
                    *plan_lexicographic_key(r),
                ),
            )

        if getattr(self, "include_benchmarks", True) and getattr(response, "benchmarks", None) is None and hasattr(self, "request") and getattr(self.request, "vehicles", None):
            try:
                nodes = []
                for v in getattr(self, "vehicles", []):
                    nodes.append({"id": v.depot.id, "latitude": v.depot.latitude, "longitude": v.depot.longitude})
                for o in getattr(self, "orders", []):
                    nodes.append({"id": o.pickup_location.id, "latitude": o.pickup_location.latitude, "longitude": o.pickup_location.longitude, "order": o})
                    nodes.append({"id": o.delivery_location.id, "latitude": o.delivery_location.latitude, "longitude": o.delivery_location.longitude, "order": o})
                calc = BaselineCostCalculator(self.request, nodes)
                response.benchmarks = calc.build_comparison(
                    getattr(response, "routes", []),
                    getattr(response, "total_cost_vnd", 0),
                    round(getattr(response, "total_distance_km", 0.0), 2),
                    round(getattr(response, "total_duration_minutes", 0.0), 2),
                    ortools_is_feasible=(getattr(response, "status", "") == "SUCCESS"),
                )
            except Exception as error:
                if hasattr(response, "diagnostics") and isinstance(response.diagnostics, list):
                    response.diagnostics.append(f"Không tính được benchmark phương án: {error}")

        response.diagnostics = [
            diagnostic
            for diagnostic in response.diagnostics
            if not diagnostic.startswith("ALNS hoàn tất:")
        ] + [
            "Packing-aware ILS hoàn tất "
            f"{iteration} vòng với seed {self.random_seed}: "
            f"{len(response.routes)} tuyến hợp lệ, "
            f"{len(response.unassigned_orders)} đơn chưa phân công.",
            "Kết quả là best-found trong ngân sách thời gian, không chứng minh tối ưu toàn cục.",
        ]
        return response
