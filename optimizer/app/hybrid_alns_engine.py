"""Packing-aware Hybrid ALNS for the production fleet contract.

This module ports the search ideas proven in ``algo_lab`` into production-owned
code.  It deliberately depends only on the production request/response models
and keeps :class:`SpatialValidator` (called by ``_build_final_response``) as the
final source of truth.
"""

from __future__ import annotations

import copy
import math
import time
from itertools import permutations
from typing import Dict, List, Optional, Sequence, Set, Tuple

from .alns_engine import ALNSFleetOptimizer
from .driver_matcher import DriverMatcher
from .ils_engine import PackingAwareILSOptimizer
from .hybrid_alns.models import (
    CargoItem as HybridCargoItem,
    CostPolicy as HybridPolicy,
    DriverOption as HybridDriver,
    FleetVehicle as HybridVehicle,
    LocationPoint as HybridLocation,
    OptimizationSolution as HybridOptimizationSolution,
    OptimizedRoute as HybridOptimizedRoute,
    OrderPair as HybridOrder,
    RouteCostBreakdown as HybridRouteCostBreakdown,
    ScheduledStop as HybridScheduledStop,
)
from .hybrid_alns.solver import solve_hybrid_alns
from .hybrid_alns.stop_moves import ranked_order_moves, ranked_stop_moves, ranked_subtrip_moves
from .models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    OrderPair,
    OptimizedRoute,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    can_driver_drive_vehicle,
)
from .planning_objective import apply_planning_objective, calendar_salary_for_span, plan_lexicographic_key
from .route_costing import calculate_late_delivery_penalty, calculate_route_economic_metrics
Insertion = Tuple[float, int, List[ScheduledStop]]
SearchState = Tuple[int, List[List[ScheduledStop]], List[str]]


class PackingAwareHybridALNSOptimizer(PackingAwareILSOptimizer):
    """Adaptive destroy/repair search with route consolidation and elite audit."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        max_iterations: int = 800,
        time_budget_seconds: Optional[float] = None,
        random_seed: int = 0,
        initial_plan: Optional[FleetOptimizationResponse] = None,
        include_benchmarks: bool = True,
    ) -> None:
        super().__init__(
            request,
            max_iterations=max_iterations,
            time_budget_seconds=time_budget_seconds,
            random_seed=random_seed,
            include_benchmarks=include_benchmarks,
        )
        self.initial_plan = initial_plan
        self._use_ranked_repair = True
        self._native_search_budget_available = True
        self._seed_search_deadline: Optional[float] = None
        self._construction_audit_fallback: Optional[Tuple[List[List[ScheduledStop]], List[str]]] = None
        self._post_audit_budget_sec = min(0.28, max(0.15, self.time_limit_sec * 0.14))
        self.destroy_weights: Dict[str, float] = {
            "route": 2.0,
            "small": 2.0,
            "cluster": 1.8,
            "worst": 1.5,
            "related": 1.2,
            "heavy": 1.2,
            "string": 1.0,
            "random": 0.8,
        }
        self.repair_weights: Dict[str, float] = {
            "regret2": 1.5,
            "regret3": 1.5,
            "greedy": 0.8,
        }
        self._exact_spatial_cache: Dict[Tuple, SpatialValidationResult] = {}
        self._audit_route_cache: Dict[Tuple[int, Tuple[Tuple[str, str], ...]], OptimizedRoute] = {}
        self._compatible_driver_cache: Dict[str, bool] = {}
        self._order_weight_by_id: Dict[str, float] = {
            order.id: order.total_weight_kg for order in self.orders
        }
        self._stop_templates_by_order_id: Dict[str, Tuple[ScheduledStop, ScheduledStop]] = {
            order.id: (
                ScheduledStop(
                    sequence=0,
                    stop_type="PICKUP",
                    location_id=order.pickup_location.id,
                    location_name=order.pickup_location.name,
                    order_id=order.id,
                    allocation_id=order.id,
                    latitude=order.pickup_location.latitude,
                    longitude=order.pickup_location.longitude,
                    arrival_time_sec=0,
                    departure_time_sec=0,
                    service_time_sec=order.service_seconds("PICKUP"),
                    items_loaded=[it.id for it in order.items],
                    items_unloaded=[],
                ),
                ScheduledStop(
                    sequence=0,
                    stop_type="DELIVERY",
                    location_id=order.delivery_location.id,
                    location_name=order.delivery_location.name,
                    order_id=order.id,
                    allocation_id=order.id,
                    latitude=order.delivery_location.latitude,
                    longitude=order.delivery_location.longitude,
                    arrival_time_sec=0,
                    departure_time_sec=0,
                    service_time_sec=order.service_seconds("DELIVERY"),
                    items_loaded=[],
                    items_unloaded=[it.id for it in order.items],
                ),
            )
            for order in self.orders
        }

    def _vehicle_has_compatible_driver(self, vehicle) -> bool:
        vid = vehicle.id
        cached = self._compatible_driver_cache.get(vid)
        if cached is not None:
            return cached
        ok = super()._vehicle_has_compatible_driver(vehicle)
        self._compatible_driver_cache[vid] = ok
        return ok

    def _can_schedule_stops(self, v_idx: int, stops: List[ScheduledStop]) -> bool:
        """Fast boolean feasibility check without allocating Pydantic stop copies."""
        vehicle = self.vehicles[v_idx]
        current_time = float(vehicle.available_start_sec)
        previous_index = v_idx
        delivered_split_groups: Set[str] = set()
        dur_matrix = self.request.duration_matrix_seconds
        avail_end = vehicle.available_end_sec

        for stop in stops:
            allocation_id = stop.allocation_id or stop.order_id or ""
            indices = self.order_node_indices.get(allocation_id)
            order = self.order_by_id.get(allocation_id)
            if indices is None or order is None:
                return False
            is_pickup = stop.stop_type == "PICKUP"
            node_index = indices[0] if is_pickup else indices[1]
            split_group = order.split_group_id
            if split_group:
                if is_pickup and split_group in delivered_split_groups:
                    return False
                if not is_pickup:
                    delivered_split_groups.add(split_group)

            travel_time = float(dur_matrix[previous_index][node_index])
            current_time += travel_time
            window_start = (
                order.pickup_window_start_sec
                if is_pickup
                else order.delivery_window_start_sec
            )
            window_end = (
                order.pickup_window_end_sec
                if is_pickup
                else order.delivery_window_end_sec
            )
            if current_time < window_start:
                current_time = float(window_start)
            if current_time > window_end or current_time > avail_end:
                return False

            arrival = round(current_time)
            departure = arrival + order.service_seconds(stop.stop_type)
            if departure > avail_end:
                return False
            current_time = float(departure)
            previous_index = node_index

        return_travel = round(dur_matrix[previous_index][v_idx])
        return round(current_time) + return_travel <= avail_end

    def _schedule_stops(
        self, v_idx: int, stops: List[ScheduledStop]
    ) -> Optional[Tuple[List[ScheduledStop], int, int]]:
        """Defer Pydantic model_copy until the full route timeline is proven valid."""
        vehicle = self.vehicles[v_idx]
        current_time = float(vehicle.available_start_sec)
        previous_index = v_idx
        delivered_split_groups: Set[str] = set()
        dur_matrix = self.request.duration_matrix_seconds
        avail_end = vehicle.available_end_sec
        timeline: List[Tuple[int, ScheduledStop, int, int, int, int, int]] = []

        for sequence, stop in enumerate(stops, start=1):
            allocation_id = stop.allocation_id or stop.order_id or ""
            indices = self.order_node_indices.get(allocation_id)
            order = self.order_by_id.get(allocation_id)
            if indices is None or order is None:
                return None
            is_pickup = stop.stop_type == "PICKUP"
            node_index = indices[0] if is_pickup else indices[1]
            split_group = order.split_group_id
            if split_group:
                if is_pickup and split_group in delivered_split_groups:
                    return None
                if not is_pickup:
                    delivered_split_groups.add(split_group)

            travel_time = float(dur_matrix[previous_index][node_index])
            leg_start = current_time
            current_time += travel_time
            window_start = (
                order.pickup_window_start_sec
                if is_pickup
                else order.delivery_window_start_sec
            )
            window_end = (
                order.pickup_window_end_sec
                if is_pickup
                else order.delivery_window_end_sec
            )
            if current_time < window_start:
                current_time = float(window_start)
            if current_time > window_end or current_time > avail_end:
                return None

            arrival = round(current_time)
            leg_elapsed_seconds = max(0, arrival - round(leg_start))
            travel_seconds = min(leg_elapsed_seconds, max(0, round(travel_time)))
            waiting_seconds = leg_elapsed_seconds - travel_seconds
            service_duration = order.service_seconds(stop.stop_type)
            departure = arrival + service_duration
            if departure > avail_end:
                return None

            timeline.append((
                sequence,
                stop,
                arrival,
                departure,
                travel_seconds,
                waiting_seconds,
                service_duration,
            ))
            current_time = float(departure)
            previous_index = node_index

        return_travel = round(dur_matrix[previous_index][v_idx])
        route_end = round(current_time) + return_travel
        if route_end > avail_end:
            return None
        scheduled = [
            stop.model_copy(
                update={
                    "sequence": sequence,
                    "arrival_time_sec": arrival,
                    "departure_time_sec": departure,
                    "travel_time_sec": travel_seconds,
                    "waiting_time_sec": waiting_seconds,
                    "service_time_sec": service_duration,
                }
            )
            for sequence, stop, arrival, departure, travel_seconds, waiting_seconds, service_duration in timeline
        ]
        return scheduled, route_end, return_travel

    def _can_insert_order(
        self,
        v_idx: int,
        current_stops: List[ScheduledStop],
        order: OrderPair,
        p_pos: int,
        d_pos: int,
        check_packing: bool = True,
    ) -> Tuple[bool, List[ScheduledStop]]:
        v = self.vehicles[v_idx]
        if not self._order_allows_vehicle(order, v):
            return False, []
        if not self._vehicle_has_compatible_driver(v):
            return False, []

        p_tpl, d_tpl = self._stop_templates_by_order_id[order.id]
        probe_stops = (
            current_stops[:p_pos]
            + [p_tpl]
            + current_stops[p_pos : d_pos - 1]
            + [d_tpl]
            + current_stops[d_pos - 1 :]
        )

        w = 0.0
        max_w = v.payload_limit_kg + 0.01
        weights = self._order_weight_by_id
        for st in probe_stops:
            oid = st.order_id or st.allocation_id or ""
            if st.stop_type == "PICKUP":
                w += weights.get(oid, 0.0)
                if w > max_w:
                    return False, []
            elif st.stop_type == "DELIVERY":
                w -= weights.get(oid, 0.0)

        if not self._can_schedule_stops(v_idx, probe_stops):
            return False, []

        if check_packing and not self._validate_stops_cached(v_idx, probe_stops):
            return False, []

        cand_stops = [st.model_copy() for st in probe_stops]
        w = 0.0
        for st in cand_stops:
            oid = st.order_id or st.allocation_id or ""
            if st.stop_type == "PICKUP":
                w += weights.get(oid, 0.0)
            elif st.stop_type == "DELIVERY":
                w -= weights.get(oid, 0.0)
            st.current_weight_kg = w
        return True, cand_stops

    def _warm_start_state(self) -> Optional[SearchState]:
        if self.initial_plan is None or not self.initial_plan.routes:
            return None
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        vehicle_index_by_id = {
            vehicle.id: index for index, vehicle in enumerate(self.vehicles)
        }
        assigned: Set[str] = set()
        for route in self.initial_plan.routes:
            vehicle_index = vehicle_index_by_id.get(route.route_id or "")
            if vehicle_index is None:
                continue
            internal_stops: List[ScheduledStop] = []
            route_pickups: List[str] = []
            route_deliveries: List[str] = []
            for stop in route.stops:
                allocation_id = stop.allocation_id or stop.order_id
                if allocation_id not in self.order_by_id:
                    internal_stops = []
                    break
                internal_stops.append(
                    stop.model_copy(
                        update={
                            "order_id": allocation_id,
                            "allocation_id": allocation_id,
                        }
                    )
                )
                if stop.stop_type == "PICKUP":
                    route_pickups.append(allocation_id)
                else:
                    route_deliveries.append(allocation_id)
            is_complete_route = (
                len(route_pickups) == len(set(route_pickups))
                and len(route_deliveries) == len(set(route_deliveries))
                and set(route_pickups) == set(route_deliveries)
            )
            if (
                internal_stops
                and is_complete_route
                and not assigned.intersection(route_pickups)
                and self._vehicle_has_compatible_driver(
                    self.vehicles[vehicle_index]
                )
                and all(
                    self._order_allows_vehicle(
                        self.order_by_id[order_id],
                        self.vehicles[vehicle_index],
                    )
                    for order_id in route_pickups
                )
                and self._schedule_stops(vehicle_index, internal_stops) is not None
                and self._validate_stops_cached(vehicle_index, internal_stops)
            ):
                routes[vehicle_index] = internal_stops
                assigned.update(route_pickups)
        if not any(routes):
            return None
        unassigned = [
            order.id for order in self.orders if order.id not in assigned
        ]
        cost, _, _ = self._evaluate_plan_cost(routes, unassigned)
        return cost, routes, unassigned

    @staticmethod
    def _assigned_order_ids(routes: Sequence[Sequence[ScheduledStop]]) -> List[str]:
        return list(
            dict.fromkeys(
                allocation_id
                for route in routes
                for stop in route
                if stop.stop_type == "PICKUP"
                and (allocation_id := stop.allocation_id or stop.order_id)
            )
        )

    @staticmethod
    def _remove_orders(
        routes: Sequence[Sequence[ScheduledStop]], order_ids: Set[str]
    ) -> List[List[ScheduledStop]]:
        return [
            [
                stop
                for stop in route
                if (stop.allocation_id or stop.order_id) not in order_ids
            ]
            for route in routes
        ]

    def _weighted_choice(self, weights: Dict[str, float]) -> str:
        names = list(weights)
        point = self.rng.random() * sum(max(0.05, weights[name]) for name in names)
        for name in names:
            point -= max(0.05, weights[name])
            if point <= 0:
                return name
        return names[-1]

    @staticmethod
    def _update_weight(weights: Dict[str, float], name: str, score: float) -> None:
        weights[name] = 0.8 * weights[name] + 0.2 * score

    def _insertion_positions(self, route_length: int) -> List[Tuple[int, int]]:
        if route_length <= 12:
            return [
                (pickup, delivery)
                for pickup in range(route_length + 1)
                for delivery in range(pickup + 1, route_length + 2)
            ]
        positions: Set[Tuple[int, int]] = {
            (pickup, pickup + 1) for pickup in range(route_length + 1)
        }
        positions.add((0, route_length + 1))
        step = max(1, route_length // 5)
        anchors = sorted(
            {0, route_length, *range(step, route_length, step)}
        )
        for pickup in anchors:
            for delivery in anchors:
                if delivery > pickup:
                    positions.add((pickup, min(delivery, route_length + 1)))
        return sorted(positions)

    def _evaluate_plan_cost(
        self,
        routes_stops: List[List[ScheduledStop]],
        unassigned_ids: List[str],
    ) -> Tuple[int, int, float]:
        penalized, economic, distance = super()._evaluate_plan_cost(
            routes_stops, unassigned_ids
        )
        # Search-only guidance from the benchmarked solver. It encourages route
        # consolidation but is never reported as a financial cost.
        active_routes = sum(bool(route) for route in routes_stops)
        return penalized + active_routes * 1_000_000, economic, distance

    def _candidate_insertions(
        self,
        routes: List[List[ScheduledStop]],
        order: OrderPair,
        deadline: float,
        excluded_vehicle_indices: Optional[Set[int]] = None,
        eligible_vehicle_indices: Optional[Sequence[int]] = None,
        limit: int = 3,
    ) -> List[Insertion]:
        quick_candidates: List[Insertion] = []
        excluded = excluded_vehicle_indices or set()
        checked_empty_profiles: Set[Tuple[object, ...]] = set()
        existing_span = max((self.vehicles[index].service_day_index+1
            for index, route in enumerate(routes) if route), default=0)
        calendar_by_span = {existing_span: calendar_salary_for_span(self.objective_request, existing_span)}

        vehicle_indices = (
            list(eligible_vehicle_indices)
            if eligible_vehicle_indices is not None
            else list(range(len(routes)))
        )
        for vehicle_index in vehicle_indices:
            current_stops = routes[vehicle_index]
            if time.perf_counter() >= deadline:
                break
            if vehicle_index in excluded:
                continue
            vehicle = self.vehicles[vehicle_index]
            if not self._order_allows_vehicle(order, vehicle):
                continue
            span = max(existing_span, vehicle.service_day_index+1)
            if span not in calendar_by_span:
                calendar_by_span[span] = calendar_salary_for_span(self.objective_request, span)
            calendar_extension = calendar_by_span[span] - calendar_by_span[existing_span]
            if not current_stops:
                profile = (
                    vehicle.source_vehicle_id or vehicle.id,
                    vehicle.service_day_index,
                    vehicle.payload_limit_kg,
                    vehicle.length_cm,
                    vehicle.width_cm,
                    vehicle.height_cm,
                    vehicle.depot.id,
                )
                if profile in checked_empty_profiles:
                    continue
                checked_empty_profiles.add(profile)

            base_distance = self._calc_route_distance_km(vehicle_index, current_stops)
            source_order_id = order.source_order_id or order.id
            shares_source_order = any(
                (self.order_by_id[stop.allocation_id or stop.order_id].source_order_id
                    or self.order_by_id[stop.allocation_id or stop.order_id].id) == source_order_id
                for stop in current_stops
                if (stop.allocation_id or stop.order_id) in self.order_by_id
            )
            for pickup_position, delivery_position in self._insertion_positions(
                len(current_stops)
            ):
                if time.perf_counter() >= deadline:
                    break
                feasible, candidate_stops = self._can_insert_order(
                    vehicle_index,
                    current_stops,
                    order,
                    pickup_position,
                    delivery_position,
                    check_packing=False,
                )
                if not feasible:
                    continue
                candidate_distance = self._calc_route_distance_km(
                    vehicle_index, candidate_stops
                )
                incremental_distance = candidate_distance - base_distance
                incremental_cost = (
                    vehicle.fuel_consumption_liters_per_100_km
                    / 100.0
                    * incremental_distance
                    * self.policy.fuel_price_per_liter_vnd
                    + (vehicle.fixed_operating_cost_vnd if not current_stops else 0)
                    + (150_000 if not current_stops else 0)
                    + round(1_200 * incremental_distance)
                    - (50_000 if shares_source_order else 0)
                    + calendar_extension
                )
                quick_candidates.append(
                    (incremental_cost, vehicle_index, candidate_stops)
                )

        quick_candidates.sort(key=lambda candidate: candidate[0])
        candidates: List[Insertion] = []
        for candidate in quick_candidates:
            _, vehicle_index, candidate_stops = candidate
            if time.perf_counter() >= deadline:
                break
            if not self._validate_stops_cached(vehicle_index, candidate_stops):
                continue
            candidates.append(candidate)
            if len(candidates) >= limit:
                break
        return candidates

    def _repair_greedy_insert(
        self, routes_stops: List[List[ScheduledStop]], unassigned_ids: List[str],
        start_time: Optional[float] = None, randomize: bool = True,
        deadline: Optional[float] = None,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Rank temporal/cost options before spending time on packing checks.

        Exhaustive packing at every insertion position can consume the whole
        construction budget on the first few orders. Reuse the same scheduler,
        source-order preference and conservative checker, in cost order.
        """
        phase_deadline = self._seed_search_deadline
        # Parent neighborhoods pass the phase start rather than a deadline.
        # Its allocated budget can exceed the nominal solver limit after a
        # reconstruction borrows native time; keep that deadline authoritative.
        if phase_deadline is not None:
            deadline = min(deadline, phase_deadline) if deadline is not None else phase_deadline
        if not self._use_ranked_repair:
            return super()._repair_greedy_insert(
                routes_stops, unassigned_ids,
                start_time=None if phase_deadline is not None else start_time,
                randomize=randomize, deadline=deadline,
            )
        started = time.perf_counter() if start_time is None else start_time
        if deadline is None:
            deadline = started + self.time_limit_sec
        pending = [self.order_by_id[order_id] for order_id in unassigned_ids]
        if randomize:
            self.rng.shuffle(pending)
        else:
            pending.sort(key=lambda order: (
                order.source_order_id or order.id,
                -sum(item.weight_kg for item in order.items),
                -sum(item.length_cm * item.width_cm for item in order.items),
                order.delivery_window_end_sec - order.pickup_window_start_sec,
            ))
        missing: List[str] = []
        for order in pending:
            if time.perf_counter() >= deadline:
                missing.append(order.id)
                continue
            options = self._candidate_insertions(routes_stops, order, deadline, limit=1)
            if not options:
                missing.append(order.id)
                continue
            _, index, stops = options[0]
            routes_stops[index] = stops
        return routes_stops, missing

    def _repair(
        self,
        routes: List[List[ScheduledStop]],
        order_ids: Sequence[str],
        operator: str,
        deadline: float,
        excluded_vehicle_indices: Optional[Set[int]] = None,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        pending = list(dict.fromkeys(order_ids))
        failed_without_option: Set[str] = set()
        regret_k = 1 if operator == "greedy" else (2 if operator == "regret2" else 3)

        while pending and time.perf_counter() < deadline:
            choices: List[Tuple[float, float, str, Insertion]] = []
            for order_id in pending:
                if time.perf_counter() >= deadline:
                    break
                options = self._candidate_insertions(
                    routes,
                    self.order_by_id[order_id],
                    deadline,
                    excluded_vehicle_indices,
                )
                if not options:
                    failed_without_option.add(order_id)
                    continue
                best_cost = options[0][0]
                if regret_k == 1:
                    regret = -best_cost
                else:
                    missing_choice_cost = (
                        best_cost + self.policy.unassigned_order_penalty_vnd
                    )
                    regret = sum(
                        (options[index][0] if index < len(options) else missing_choice_cost)
                        - best_cost
                        for index in range(1, regret_k)
                    )
                choices.append((regret, -best_cost, order_id, options[0]))

            if not choices:
                break
            if regret_k == 1:
                _, _, selected_id, selected = max(choices, key=lambda item: item[1])
            else:
                _, _, selected_id, selected = max(
                    choices, key=lambda item: (item[0], item[1])
                )
            _, vehicle_index, stops = selected
            routes[vehicle_index] = stops
            pending.remove(selected_id)
            failed_without_option.discard(selected_id)

        return routes, list(
            dict.fromkeys(
                order_id
                for order_id in pending
                if order_id in failed_without_option or time.perf_counter() >= deadline
            )
        )

    def _destroy_route(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        active = [
            (index, self._assigned_order_ids([stops]))
            for index, stops in enumerate(routes)
            if stops
        ]
        if not active:
            return routes, []
        # Small routes are the most promising consolidation targets.
        vehicle_index, order_ids = min(active, key=lambda item: len(item[1]))
        removed = set(order_ids)
        return self._remove_orders(routes, removed), list(removed)

    def _destroy_worst(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        current_cost, _, _ = self._evaluate_plan_cost(routes, [])
        savings: List[Tuple[int, str]] = []
        for order_id in self._assigned_order_ids(routes):
            reduced = self._remove_orders(routes, {order_id})
            reduced_cost, _, _ = self._evaluate_plan_cost(reduced, [])
            savings.append((current_cost - reduced_cost, order_id))
        savings.sort(reverse=True)
        removed = {order_id for _, order_id in savings[:remove_count]}
        return self._remove_orders(routes, removed), list(removed)

    def _destroy_small_routes(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        small_indices = [
            index
            for index, route in enumerate(routes)
            if route and len(self._assigned_order_ids([route])) <= 2
        ]
        if not small_indices:
            return self._destroy_route(routes, remove_count)
        removed: List[str] = []
        candidate = copy.deepcopy(routes)
        for index in small_indices[:2]:
            removed.extend(self._assigned_order_ids([candidate[index]]))
            candidate[index] = []
        return candidate, list(dict.fromkeys(removed))

    def _destroy_cluster(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        if not assigned:
            return routes, []
        seed = self.rng.choice(assigned)
        seed_pickup, _ = self.order_node_indices[seed]
        clustered = sorted(
            assigned,
            key=lambda order_id: self.request.distance_matrix_meters[
                seed_pickup
            ][self.order_node_indices[order_id][0]],
        )
        removed = set(clustered[: min(remove_count, len(clustered))])
        return self._remove_orders(routes, removed), list(removed)

    def _destroy_heavy(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        ranked = sorted(
            assigned,
            key=lambda order_id: (
                sum(item.weight_kg for item in self.order_by_id[order_id].items),
                sum(
                    item.length_cm * item.width_cm
                    for item in self.order_by_id[order_id].items
                ),
            ),
            reverse=True,
        )
        removed = set(ranked[: min(remove_count, len(ranked))])
        return self._remove_orders(routes, removed), list(removed)

    def _relatedness(self, first_id: str, second_id: str) -> float:
        first = self.order_by_id[first_id]
        second = self.order_by_id[second_id]
        first_pickup, first_delivery = self.order_node_indices[first_id]
        second_pickup, second_delivery = self.order_node_indices[second_id]
        spatial = (
            self.request.distance_matrix_meters[first_pickup][second_pickup]
            + self.request.distance_matrix_meters[first_delivery][second_delivery]
        )
        temporal = abs(
            first.pickup_window_start_sec - second.pickup_window_start_sec
        ) + abs(first.delivery_window_end_sec - second.delivery_window_end_sec)
        first_weight = sum(item.weight_kg for item in first.items)
        second_weight = sum(item.weight_kg for item in second.items)
        return spatial + temporal * 5.0 + abs(first_weight - second_weight) * 100.0

    def _destroy_related(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        assigned = self._assigned_order_ids(routes)
        if not assigned:
            return routes, []
        seed = self.rng.choice(assigned)
        related = sorted(assigned, key=lambda order_id: self._relatedness(seed, order_id))
        removed = set(related[:remove_count])
        return self._remove_orders(routes, removed), list(removed)

    def _destroy_string(
        self, routes: List[List[ScheduledStop]], remove_count: int
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        active = [stops for stops in routes if stops]
        if not active:
            return routes, []
        route = self.rng.choice(active)
        pickups = [
            stop.allocation_id or stop.order_id
            for stop in route
            if stop.stop_type == "PICKUP" and (stop.allocation_id or stop.order_id)
        ]
        start = self.rng.randrange(len(pickups))
        removed = set(pickups[start : start + remove_count])
        return self._remove_orders(routes, removed), list(removed)

    def _destroy(
        self,
        name: str,
        routes: List[List[ScheduledStop]],
        remove_count: int,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        if name == "route":
            return self._destroy_route(routes, remove_count)
        if name == "small":
            return self._destroy_small_routes(routes, remove_count)
        if name == "cluster":
            return self._destroy_cluster(routes, remove_count)
        if name == "worst":
            return self._destroy_worst(routes, remove_count)
        if name == "related":
            return self._destroy_related(routes, remove_count)
        if name == "heavy":
            return self._destroy_heavy(routes, remove_count)
        if name == "string":
            return self._destroy_string(routes, remove_count)
        return self._destroy_random(routes, remove_count)

    def _sequential_construction(
        self,
        order_sequence: Sequence[str],
        deadline: float,
        *,
        alpha: float = 0.0,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        unassigned: List[str] = []
        for order_id in order_sequence:
            if time.perf_counter() >= deadline:
                unassigned.append(order_id)
                continue
            options = self._candidate_insertions(
                routes,
                self.order_by_id[order_id],
                deadline,
                limit=max(1, min(12, len(self.vehicles) * 2)),
            )
            if not options:
                unassigned.append(order_id)
                continue
            best_delta = options[0][0]
            worst_delta = options[-1][0]
            threshold = best_delta + alpha * (worst_delta - best_delta)
            restricted = [option for option in options if option[0] <= threshold]
            _, vehicle_index, stops = self.rng.choice(restricted or [options[0]])
            routes[vehicle_index] = stops
        return routes, unassigned

    def _conservative_cycle_construction(
        self,
        order_sequence: Sequence[str],
        deadline: float,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Build a spatially safe fallback from adjacent pickup-delivery cycles.

        No cargo from a later order is loaded before the current order is
        delivered.  The exact validator still audits the result, but this
        construction avoids relying on the fast LIFO approximation for shared
        cargo layouts.
        """
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        unassigned: List[str] = []
        for sequence_index, order_id in enumerate(order_sequence):
            if time.perf_counter() >= deadline:
                unassigned.extend(order_sequence[sequence_index:])
                break
            order = self.order_by_id[order_id]
            best: Optional[Tuple[float, int, List[ScheduledStop]]] = None
            for vehicle_index, current_route in enumerate(routes):
                feasible, candidate_stops = self._can_insert_order(
                    vehicle_index,
                    current_route,
                    order,
                    len(current_route),
                    len(current_route) + 1,
                )
                if not feasible:
                    continue
                previous_distance = self._calc_route_distance_km(
                    vehicle_index, current_route
                )
                candidate_distance = self._calc_route_distance_km(
                    vehicle_index, candidate_stops
                )
                activation_cost = (
                    self.vehicles[vehicle_index].fixed_operating_cost_vnd
                    if not current_route
                    else 0
                )
                score = activation_cost + max(
                    0.0, candidate_distance - previous_distance
                ) * 1_000.0
                option = (score, vehicle_index, candidate_stops)
                if best is None or option[0] < best[0]:
                    best = option
            if best is None:
                unassigned.append(order_id)
            else:
                routes[best[1]] = best[2]
        return routes, unassigned

    def _time_wave_order_sequence(self) -> List[str]:
        waves_by_start: Dict[int, List[str]] = {}
        for order in self.orders:
            waves_by_start.setdefault(order.pickup_window_start_sec, []).append(
                order.id
            )
        if len(waves_by_start) < 2:
            return []
        waves: List[List[str]] = []
        for wave_index, pickup_start in enumerate(sorted(waves_by_start)):
            wave = list(waves_by_start[pickup_start])
            if wave_index % 2:
                wave.reverse()
            waves.append(wave)
        sequence: List[str] = []
        offset = 0
        while any(offset < len(wave) for wave in waves):
            sequence.extend(
                wave[offset] for wave in waves if offset < len(wave)
            )
            offset += 1
        return sequence

    def _construction_population(
        self, deadline: float
    ) -> List[SearchState]:
        """Build deterministic and randomized starts from distinct search basins."""
        by_time = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda order: (
                    order.pickup_window_start_sec,
                    order.delivery_window_end_sec,
                ),
            )
        ]
        by_area = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda order: sum(
                    item.length_cm * item.width_cm for item in order.items
                ),
                reverse=True,
            )
        ]
        by_weight = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda order: sum(item.weight_kg for item in order.items),
                reverse=True,
            )
        ]
        sequences: List[Tuple[List[str], float]] = [
            (by_time, 0.0),
            (by_area, 0.0),
            (by_weight, 0.15),
        ]
        wave = self._time_wave_order_sequence()
        if wave:
            sequences.insert(0, (wave, 0.0))

        depot_ids = {vehicle.depot.id for vehicle in self.vehicles}
        randomized_count = 8 if len(depot_ids) > 1 else 3
        randomized: List[List[str]] = []
        all_ids = [order.id for order in self.orders]
        for _ in range(randomized_count):
            chromosome = list(all_ids)
            self.rng.shuffle(chromosome)
            randomized.append(chromosome)
        half = len(randomized) // 2
        interleaved = [
            randomized[index]
            for offset in range(half + 1)
            for index in (offset, half + offset)
            if index < len(randomized)
        ]
        sequences.extend((sequence, 0.25) for sequence in interleaved)

        candidates: List[SearchState] = []
        for sequence, alpha in sequences:
            if time.perf_counter() >= deadline:
                break
            routes, unassigned = self._sequential_construction(
                sequence, deadline, alpha=alpha
            )
            cost, _, _ = self._evaluate_plan_cost(routes, unassigned)
            candidates.append((cost, routes, unassigned))
        return candidates

    def _best_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        *args,
        deadline: Optional[float] = None,
        sample_limit: int = 8,
    ) -> Optional[SearchState]:
        started_at = None
        if len(args) == 2:
            started_at, deadline = args
        elif len(args) == 1:
            deadline = args[0]
        if deadline is None:
            deadline = time.perf_counter() + 2.0
        if started_at is not None:
            # Delegate to parent ILS relocation which is verified fast and uses candidate_key
            res = super()._best_relocation(routes, unassigned, started_at, deadline)
            if res is not None:
                return (res[0], res[1], res[2])
        incumbent, _, _ = self._evaluate_plan_cost(routes, unassigned)
        best: Optional[SearchState] = None
        assigned = self._assigned_order_ids(routes)
        self.rng.shuffle(assigned)
        for order_id in assigned[: min(sample_limit, len(assigned))]:
            if time.perf_counter() >= deadline:
                break
            reduced = self._remove_orders(routes, {order_id})
            options = self._candidate_insertions(
                reduced,
                self.order_by_id[order_id],
                deadline,
                limit=4,
            )
            for _, vehicle_index, stops in options:
                candidate_routes = copy.deepcopy(reduced)
                candidate_routes[vehicle_index] = stops
                candidate_cost, _, _ = self._evaluate_plan_cost(
                    candidate_routes, unassigned
                )
                if candidate_cost < incumbent and (
                    best is None or candidate_cost < best[0]
                ):
                    best = (candidate_cost, candidate_routes, list(unassigned))
        return best

    def _orders_by_removal_saving(
        self, vehicle_index: int, route: List[ScheduledStop]
    ) -> List[str]:
        route_cost = self._calc_route_distance_km(vehicle_index, route)
        order_ids = self._assigned_order_ids([route])
        return sorted(
            order_ids,
            key=lambda order_id: route_cost
            - self._calc_route_distance_km(
                vehicle_index,
                [
                    stop
                    for stop in route
                    if (stop.allocation_id or stop.order_id) != order_id
                ],
            ),
            reverse=True,
        )

    def _best_order_exchange(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[Tuple[int, List[List[ScheduledStop]], List[str], Tuple[int, int]]]:
        best = None
        attempts = 0
        active = [index for index, route in enumerate(routes) if route]
        for position, first_index in enumerate(active):
            for second_index in active[position + 1 :]:
                first_orders = self._orders_by_removal_saving(
                    first_index, routes[first_index]
                )[:4]
                second_orders = self._orders_by_removal_saving(
                    second_index, routes[second_index]
                )[:4]
                for first_order in first_orders:
                    for second_order in second_orders:
                        if time.perf_counter() >= deadline or attempts >= 16:
                            return best
                        attempts += 1
                        reduced = self._remove_orders(
                            routes, {first_order, second_order}
                        )
                        first_options = self._candidate_insertions(
                            reduced,
                            self.order_by_id[first_order],
                            deadline,
                            eligible_vehicle_indices=[second_index],
                            limit=1,
                        )
                        if not first_options:
                            continue
                        first_candidate = copy.deepcopy(reduced)
                        first_candidate[second_index] = first_options[0][2]
                        second_options = self._candidate_insertions(
                            first_candidate,
                            self.order_by_id[second_order],
                            deadline,
                            eligible_vehicle_indices=[first_index],
                            limit=1,
                        )
                        if not second_options:
                            continue
                        first_candidate[first_index] = second_options[0][2]
                        cost, _, _ = self._evaluate_plan_cost(
                            first_candidate, unassigned
                        )
                        candidate = (
                            cost,
                            first_candidate,
                            list(unassigned),
                            (first_index, second_index),
                        )
                        if best is None or cost < best[0]:
                            best = candidate
        return best

    def _best_intra_route_relocation(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        vehicle_indices: Sequence[int],
        deadline: float,
    ) -> Optional[SearchState]:
        incumbent, _, _ = self._evaluate_plan_cost(routes, unassigned)
        best: Optional[SearchState] = None
        for vehicle_index in vehicle_indices:
            for order_id in self._orders_by_removal_saving(
                vehicle_index, routes[vehicle_index]
            )[:4]:
                if time.perf_counter() >= deadline:
                    return best
                reduced = self._remove_orders(routes, {order_id})
                options = self._candidate_insertions(
                    reduced,
                    self.order_by_id[order_id],
                    deadline,
                    eligible_vehicle_indices=[vehicle_index],
                    limit=6,
                )
                for _, _, stops in options:
                    candidate_routes = copy.deepcopy(reduced)
                    candidate_routes[vehicle_index] = stops
                    cost, _, _ = self._evaluate_plan_cost(
                        candidate_routes, unassigned
                    )
                    if cost < incumbent and (best is None or cost < best[0]):
                        best = (cost, candidate_routes, list(unassigned))
        return best

    def _best_route_split(
        self,
        routes: List[List[ScheduledStop]],
        unassigned: List[str],
        deadline: float,
    ) -> Optional[SearchState]:
        """Move one order to an unused resource to escape a tight packing basin."""
        empty_indices = [index for index, route in enumerate(routes) if not route]
        if not empty_indices:
            return None
        best: Optional[SearchState] = None
        for source_route in routes:
            order_ids = self._assigned_order_ids([source_route])
            if len(order_ids) < 2:
                continue
            for order_id in order_ids:
                if time.perf_counter() >= deadline:
                    return best
                reduced = self._remove_orders(routes, {order_id})
                options = self._candidate_insertions(
                    reduced,
                    self.order_by_id[order_id],
                    deadline,
                    eligible_vehicle_indices=empty_indices,
                    limit=max(1, min(6, len(empty_indices))),
                )
                for _, vehicle_index, stops in options:
                    candidate_routes = copy.deepcopy(reduced)
                    candidate_routes[vehicle_index] = stops
                    cost, _, _ = self._evaluate_plan_cost(
                        candidate_routes, unassigned
                    )
                    if best is None or cost < best[0]:
                        best = (cost, candidate_routes, list(unassigned))
        return best

    @staticmethod
    def _state_signature(routes: Sequence[Sequence[ScheduledStop]]) -> Tuple:
        return tuple(
            tuple(
                (stop.stop_type, stop.allocation_id or stop.order_id)
                for stop in route
            )
            for route in routes
        )

    def _remember_elite(
        self,
        elites: List[SearchState],
        state: SearchState,
        max_size: int = 16,
    ) -> None:
        signature = self._state_signature(state[1])
        if any(self._state_signature(existing[1]) == signature for existing in elites):
            return
        elites.append((state[0], copy.deepcopy(state[1]), list(state[2])))
        elites.sort(key=lambda candidate: (len(candidate[2]), candidate[0]))
        del elites[max_size:]

    def _consolidate(
        self,
        state: SearchState,
        deadline: float,
    ) -> SearchState:
        best_cost, best_routes, best_unassigned = state
        active_indices = sorted(
            (index for index, route in enumerate(best_routes) if route),
            key=lambda index: len(self._assigned_order_ids([best_routes[index]])),
        )
        for victim_index in active_indices:
            if time.perf_counter() >= deadline:
                break
            removed = self._assigned_order_ids([best_routes[victim_index]])
            candidate_routes = copy.deepcopy(best_routes)
            candidate_routes[victim_index] = []
            candidate_routes, failed = self._repair(
                candidate_routes,
                removed,
                "regret3",
                deadline,
                excluded_vehicle_indices={victim_index},
            )
            candidate_unassigned = list(dict.fromkeys(best_unassigned + failed))
            candidate_cost, _, _ = self._evaluate_plan_cost(
                candidate_routes, candidate_unassigned
            )
            if (len(candidate_unassigned), candidate_cost) < (
                len(best_unassigned),
                best_cost,
            ):
                best_cost = candidate_cost
                best_routes = candidate_routes
                best_unassigned = candidate_unassigned
        return best_cost, best_routes, best_unassigned

    def _refine_pairwise_empty_cycles(
        self,
        routes: List[List[ScheduledStop]],
        deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Merge route pairs through conservative empty-load order cycles.

        This is the production counterpart of the lab's pairwise refinement.
        Each order is fully delivered before the next pickup, so space is reused
        without moving cargo that remains onboard.
        """
        current = copy.deepcopy(routes)
        while time.perf_counter() < deadline:
            active = [index for index, route in enumerate(current) if route]
            if len(active) <= 1:
                break
            current_cost, _, _ = self._evaluate_plan_cost(current, [])
            best_merge: Optional[Tuple[int, List[List[ScheduledStop]]]] = None

            pairs = [
                (first, second)
                for position, first in enumerate(active)
                for second in active[position + 1 :]
            ]
            pairs.sort(
                key=lambda pair: len(current[pair[0]]) + len(current[pair[1]])
            )
            for first, second in pairs:
                if time.perf_counter() >= deadline:
                    break
                stops_by_order: Dict[str, Dict[str, ScheduledStop]] = {}
                route_orderings: List[List[str]] = []
                malformed = False
                for route_index in (first, second):
                    order_ids: List[str] = []
                    for stop in current[route_index]:
                        order_id = stop.allocation_id or stop.order_id
                        if not order_id:
                            malformed = True
                            break
                        if order_id not in stops_by_order:
                            stops_by_order[order_id] = {}
                            order_ids.append(order_id)
                        stops_by_order[order_id][stop.stop_type] = stop
                    route_orderings.append(order_ids)
                if malformed or any(
                    set(by_type) != {"PICKUP", "DELIVERY"}
                    for by_type in stops_by_order.values()
                ):
                    continue
                all_order_ids = list(stops_by_order)
                candidate_orderings = (
                    route_orderings[0] + route_orderings[1],
                    route_orderings[1] + route_orderings[0],
                    sorted(
                        all_order_ids,
                        key=lambda order_id: (
                            self.order_by_id[order_id].delivery_window_end_sec,
                            self.order_by_id[order_id].pickup_window_start_sec,
                        ),
                    ),
                )
                for target_index in (first, second):
                    vehicle = self.vehicles[target_index]
                    if not self._vehicle_has_compatible_driver(vehicle) or any(
                        not self._order_allows_vehicle(
                            self.order_by_id[order_id], vehicle
                        )
                        for order_id in all_order_ids
                    ):
                        continue
                    for ordering in candidate_orderings:
                        if time.perf_counter() >= deadline:
                            break
                        cycle_stops = [
                            stops_by_order[order_id][stop_type]
                            for order_id in ordering
                            for stop_type in ("PICKUP", "DELIVERY")
                        ]
                        schedule_result = self._schedule_stops(
                            target_index, cycle_stops
                        )
                        if schedule_result is None:
                            continue
                        scheduled = schedule_result[0]
                        if not self._validate_stops_cached(
                            target_index, scheduled
                        ):
                            continue
                        candidate_routes = copy.deepcopy(current)
                        candidate_routes[first] = []
                        candidate_routes[second] = []
                        candidate_routes[target_index] = scheduled
                        candidate_cost, _, _ = self._evaluate_plan_cost(
                            candidate_routes, []
                        )
                        if candidate_cost >= current_cost:
                            continue
                        if best_merge is None or candidate_cost < best_merge[0]:
                            best_merge = (candidate_cost, candidate_routes)

            if best_merge is None:
                break
            current = best_merge[1]
        return current

    @staticmethod
    def _response_rank(response: FleetOptimizationResponse) -> Tuple[int, int, int]:
        status_rank = {"SUCCESS": 0, "PARTIAL": 1, "INFEASIBLE": 2}.get(
            response.status, 3
        )
        return status_rank, len(response.unassigned_orders), response.total_cost_vnd

    @staticmethod
    def _select_audit_candidates(
        candidates: Sequence[SearchState],
        limit: int = 6,
        max_per_route_count: int = 4,
        fallback: Optional[SearchState] = None,
    ) -> List[SearchState]:
        if limit <= 0:
            return []
        selected: List[SearchState] = []
        overflow: List[SearchState] = []
        route_count_frequency: Dict[int, int] = {}
        if fallback is not None:
            selected.append(fallback)
            route_count_frequency[sum(bool(route) for route in fallback[1])] = 1
            if len(selected) >= limit:
                return selected
        for candidate in candidates:
            if candidate is fallback:
                continue
            route_count = sum(bool(route) for route in candidate[1])
            if route_count not in route_count_frequency:
                selected.append(candidate)
                route_count_frequency[route_count] = 1
                if len(selected) >= limit:
                    return selected
            else:
                overflow.append(candidate)
        for candidate in overflow:
            route_count = sum(bool(route) for route in candidate[1])
            if route_count_frequency.get(route_count, 0) >= max_per_route_count:
                continue
            selected.append(candidate)
            route_count_frequency[route_count] = (
                route_count_frequency.get(route_count, 0) + 1
            )
            if len(selected) >= limit:
                break
        return selected

    def _rank_candidate_for_audit(
        self, routes: List[List[ScheduledStop]], unassigned: List[str],
    ) -> Tuple[int, int, int, int, int, int]:
        """Price tentative plans consistently before spending the audit budget.

        The fast search surrogate assumes generic driver pay and holding time.
        It must not evict a better real-cost candidate from the bounded audit.
        These ranking-only routes explicitly remain spatially unverified.
        """
        nodes = [{"id": vehicle.depot.id} for vehicle in self.vehicles]
        for order in self.orders:
            nodes.extend([{"id": order.pickup_location.id}, {"id": order.delivery_location.id}])
        costed_routes: List[OptimizedRoute] = []
        invalid_key = (len(self.orders) + 1, 0, 0, 0, 0, 0)
        route_cache = getattr(self, "_audit_route_cache", None)
        if route_cache is None:
            route_cache = {}
            self._audit_route_cache = route_cache
        for index, stops in enumerate(routes):
            if not stops:
                continue
            sig = tuple((stop.allocation_id or stop.order_id or "", stop.stop_type) for stop in stops)
            cache_key = (index, sig)
            cached_route = route_cache.get(cache_key)
            if cached_route is None:
                scheduled = self._schedule_stops(index, stops)
                if scheduled is None:
                    return invalid_key
                scheduled_stops, route_end, return_travel = scheduled
                weight = 0.0
                for stop in scheduled_stops:
                    order = self.order_by_id[stop.allocation_id or stop.order_id]
                    weight += order.total_weight_kg * (1 if stop.stop_type == "PICKUP" else -1)
                    stop.current_weight_kg = max(0.0, weight)
                vehicle = self.vehicles[index]
                base, surcharge, holding, ton_km, ton_hours = calculate_route_economic_metrics(
                    self.request, nodes, self.order_by_id, vehicle, scheduled_stops,
                )
                late = sum(calculate_late_delivery_penalty(
                    self.order_by_id[stop.allocation_id or stop.order_id], stop.arrival_time_sec, self.policy,
                ) for stop in scheduled_stops if stop.stop_type == "DELIVERY")
                start = max(vehicle.available_start_sec,
                    scheduled_stops[0].arrival_time_sec - scheduled_stops[0].travel_time_sec)
                cached_route = OptimizedRoute(
                    route_id=vehicle.id, vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                    service_day_index=vehicle.service_day_index, plate_number=vehicle.plate_number,
                    vehicle_length_cm=vehicle.length_cm, vehicle_width_cm=vehicle.width_cm,
                    start_time_sec=start, end_time_sec=route_end, return_travel_time_sec=return_travel,
                    total_distance_km=round(self._calc_route_distance_km(index, scheduled_stops), 2),
                    total_duration_minutes=round((route_end-start)/60.0, 1), stops=scheduled_stops,
                    spatial_validation=SpatialValidationResult(is_valid=False),
                    cost=RouteCostBreakdown(
                        base_fuel_cost_vnd=base, load_fuel_surcharge_vnd=surcharge,
                        fuel_cost_vnd=base+surcharge, cargo_holding_cost_vnd=holding,
                        late_delivery_penalty_vnd=late, cargo_distance_ton_km=ton_km,
                        cargo_time_ton_hours=ton_hours, vehicle_fixed_cost_vnd=vehicle.fixed_operating_cost_vnd,
                        driver_fixed_salary_allocation_vnd=0, driver_trip_pay_vnd=0,
                        total_cost_vnd=base+surcharge+holding+late+vehicle.fixed_operating_cost_vnd,
                    ),
                )
                route_cache[cache_key] = cached_route
            costed_routes.append(
                cached_route.model_copy(
                    update={
                        "assigned_driver": None,
                        "cost": cached_route.cost.model_copy() if cached_route.cost else None,
                    }
                )
            )
        try:
            DriverMatcher(self.request).assign_drivers_to_routes(costed_routes)
        except ValueError:
            # An impossible driver matching is a normal infeasible candidate.
            return invalid_key
        tentative = FleetOptimizationResponse(
            job_id=self.request.job_id, status="PARTIAL", routes=costed_routes,
            total_cost_vnd=sum(route.cost.total_cost_vnd for route in costed_routes if route.cost),
        )
        apply_planning_objective(self.objective_request, tentative)
        return (len(set(unassigned)), *plan_lexicographic_key(tentative))

    def _best_audited_response(
        self, responses: Sequence[FleetOptimizationResponse],
    ) -> FleetOptimizationResponse:
        # Final builders return costed routes without a planning objective.
        # Compute it for every repaired plan before selecting the winner.
        for response in responses:
            apply_planning_objective(self.objective_request, response)
        return min(responses, key=lambda response: (
            len({order.order_id for order in response.unassigned_orders}),
            *plan_lexicographic_key(response),
        ))

    def _production_vehicle_reassignment(
        self, routes: List[List[ScheduledStop]], unassigned: List[str],
    ) -> Optional[SearchState]:
        """Retain the incumbent when an operating-cost move hurts company score."""
        reassigned = self._try_vehicle_reassignment(routes, unassigned)
        if reassigned is not None and self._rank_candidate_for_audit(
            reassigned[1], reassigned[2],
        ) < self._rank_candidate_for_audit(routes, unassigned):
            return reassigned
        return None

    def _optimize_production_vehicles(
        self, routes: List[List[ScheduledStop]], unassigned: List[str],
    ) -> Optional[SearchState]:
        """Reassign idle vehicles and swap active vehicles when company score improves."""
        cur_routes = routes
        cur_unassigned = unassigned
        cur_rank = self._rank_candidate_for_audit(cur_routes, cur_unassigned)
        changed = False
        for _ in range(len(self.vehicles)):
            reassigned = self._try_vehicle_reassignment(cur_routes, cur_unassigned)
            if reassigned is None:
                break
            cand_rank = self._rank_candidate_for_audit(reassigned[1], reassigned[2])
            if cand_rank < cur_rank:
                cur_routes, cur_unassigned, cur_rank = reassigned[1], reassigned[2], cand_rank
                changed = True
            else:
                break
        active = [idx for idx, r in enumerate(cur_routes) if r]
        for idx_a in range(len(active)):
            for idx_b in range(idx_a + 1, len(active)):
                i = active[idx_a]
                j = active[idx_b]
                vi = self.vehicles[i]
                vj = self.vehicles[j]
                if not self._vehicle_has_compatible_driver(vi) or not self._vehicle_has_compatible_driver(vj):
                    continue
                if any(
                    not self._order_allows_vehicle(self.order_by_id[s.allocation_id or s.order_id], vj)
                    for s in cur_routes[i]
                    if s.stop_type == "PICKUP"
                ):
                    continue
                if any(
                    not self._order_allows_vehicle(self.order_by_id[s.allocation_id or s.order_id], vi)
                    for s in cur_routes[j]
                    if s.stop_type == "PICKUP"
                ):
                    continue
                if not self._validate_stops_cached(j, cur_routes[i]) or not self._validate_stops_cached(i, cur_routes[j]):
                    continue
                swapped = list(cur_routes)
                swapped[i] = cur_routes[j]
                swapped[j] = cur_routes[i]
                cand_rank = self._rank_candidate_for_audit(swapped, cur_unassigned)
                if cand_rank < cur_rank:
                    cur_routes, cur_rank = swapped, cand_rank
                    changed = True
        if changed:
            cost, _, _ = self._evaluate_plan_cost(cur_routes, cur_unassigned)
            return (cost, cur_routes, cur_unassigned)
        return None

    def _routes_from_audited_response(
        self, response: FleetOptimizationResponse,
    ) -> Optional[List[List[ScheduledStop]]]:
        indices = {vehicle.id: index for index, vehicle in enumerate(self.vehicles)}
        routes: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        for route in response.routes:
            index = indices.get(route.route_id or route.vehicle_id)
            if index is None:
                return None
            routes[index] = [stop.model_copy(update={
                "order_id": stop.allocation_id or stop.order_id,
            }) for stop in route.stops]
        return routes

    def _polish_audited_response(
        self, response: FleetOptimizationResponse, deadline: float,
    ) -> FleetOptimizationResponse:
        """Improve the plan produced by repair, keeping its audited fallback.

        Pre-audit local search cannot improve a stop order that repair has not
        created yet. Re-price these moves with the production objective, and
        audit again before accepting any of them.
        """
        if response.unassigned_orders or not response.routes:
            return response
        best = response
        order_weights = {
            order.id: sum(item.weight_kg for item in order.items)
            for order in self.orders
        }
        order_areas = {
            order.id: sum(item.length_cm * item.width_cm for item in order.items)
            for order in self.orders
        }
        rejected_route_keys: Set[Tuple[int, Tuple[Tuple[str, str], ...]]] = set()
        scheduled_route_keys: Set[Tuple[int, Tuple[Tuple[str, str], ...]]] = set()

        def _route_capacity_and_schedule_ok(vehicle_index: int, route: List[ScheduledStop]) -> bool:
            if not route:
                return True
            sig = tuple((stop.allocation_id or stop.order_id or "", stop.stop_type) for stop in route)
            cache_key = (vehicle_index, sig)
            if cache_key in rejected_route_keys:
                return False
            if cache_key in scheduled_route_keys:
                return True
            vehicle = self.vehicles[vehicle_index]
            max_weight = vehicle.payload_limit_kg
            max_area = vehicle.length_cm * vehicle.width_cm
            load_weight = 0.0
            load_area = 0.0
            for stop in route:
                oid = stop.allocation_id or stop.order_id or ""
                w = order_weights.get(oid, 0.0)
                a = order_areas.get(oid, 0.0)
                if stop.stop_type == "PICKUP":
                    load_weight += w
                    load_area += a
                    if load_weight > max_weight + 1e-6 or load_area > max_area + 1e-6:
                        rejected_route_keys.add(cache_key)
                        return False
                else:
                    load_weight = max(0.0, load_weight - w)
                    load_area = max(0.0, load_area - a)
            if not self._can_schedule_stops(vehicle_index, route):
                rejected_route_keys.add(cache_key)
                return False
            scheduled_route_keys.add(cache_key)
            return True

        while time.perf_counter() < deadline:
            routes = self._routes_from_audited_response(best)
            if routes is None:
                return best
            node_routes: List[List[int]] = []
            for route in routes:
                nodes = []
                for stop in route:
                    node = self._stop_node_index(stop)
                    if node is None:
                        return best
                    nodes.append(node)
                node_routes.append(nodes)
            actions = [[(stop.allocation_id or stop.order_id or "", stop.stop_type)
                for stop in route] for route in routes]
            stop_moves = ranked_stop_moves(
                node_routes,
                actions,
                list(range(len(routes))), list(range(len(routes))),
                self.request.distance_matrix_meters, deadline,
            )
            pair_moves = ranked_order_moves(
                node_routes, actions, list(range(len(routes))), list(range(len(routes))),
                self.request.distance_matrix_meters, deadline,
            )
            subtrip_moves = ranked_subtrip_moves(
                node_routes, actions, list(range(len(routes))), list(range(len(routes))),
                self.request.distance_matrix_meters, deadline,
            )
            # Rank route-eliminating moves first, then distance-improving single-stop
            # moves, then cross-route order/subtrip moves so thousands of infeasible pair moves
            # cannot starve cheap intra-route improvements.
            moves = sorted(
                [(0, 0 if delta < 0 else 2, delta, 0, (vehicle, source, target))
                    for delta, vehicle, source, target in stop_moves]
                + [(trips, 1 if delta < 0 else 2, delta, 1, (source, pickup, delivery, target, p, d))
                    for trips, delta, source, pickup, delivery, target, p, d in pair_moves]
                + [(trips, 1 if delta < 0 else 2, delta, 2, (source, start, end, target, pos))
                    for trips, delta, source, start, end, target, pos in subtrip_moves]
            )
            incumbent_key = (0, *plan_lexicographic_key(best))
            improved = False
            for _, _, _, kind, positions in moves:
                if time.perf_counter() >= deadline:
                    return best
                candidate = list(routes)
                if kind == 0:
                    vehicle_index, source, target = positions
                    route = routes[vehicle_index]
                    reduced = route[:source] + route[source+1:]
                    candidate[vehicle_index] = reduced[:target] + [route[source]] + reduced[target:]
                    changed_indices = (vehicle_index,)
                elif kind == 1:
                    source, pickup, delivery, target, p, d = positions
                    route = routes[source]
                    order = self.order_by_id[route[pickup].allocation_id or route[pickup].order_id]
                    if (not self._order_allows_vehicle(order, self.vehicles[target])
                        or not self._vehicle_has_compatible_driver(self.vehicles[target])):
                        continue
                    candidate[source] = [stop for index, stop in enumerate(route)
                        if index not in (pickup, delivery)]
                    destination = list(candidate[target])
                    destination.insert(p, route[pickup])
                    destination.insert(d, route[delivery])
                    candidate[target] = destination
                    changed_indices = (source, target) if source != target else (source,)
                else:
                    source, start, end, target, pos = positions
                    route = routes[source]
                    segment = route[start:end]
                    if not self._vehicle_has_compatible_driver(self.vehicles[target]):
                        continue
                    if any(
                        not self._order_allows_vehicle(
                            self.order_by_id[stop.allocation_id or stop.order_id],
                            self.vehicles[target],
                        )
                        for stop in segment
                        if stop.stop_type == "PICKUP"
                    ):
                        continue
                    candidate[source] = route[:start] + route[end:]
                    destination = list(candidate[target])
                    candidate[target] = destination[:pos] + segment + destination[pos:]
                    changed_indices = (source, target) if source != target else (source,)
                if any(not _route_capacity_and_schedule_ok(index, candidate[index])
                    for index in changed_indices if candidate[index]):
                    continue
                # A cheap conservative check avoids spending the ranking/audit budget
                # on moves that cannot load/unload their cargo.
                prev_layout_search = getattr(self, "_allow_layout_search", True)
                self._allow_layout_search = False
                try:
                    spatial_ok = True
                    for index in changed_indices:
                        if not candidate[index]:
                            continue
                        if not self._validate_stops_cached(index, candidate[index]):
                            sig = tuple((stop.allocation_id or stop.order_id or "", stop.stop_type) for stop in candidate[index])
                            rejected_route_keys.add((index, sig))
                            spatial_ok = False
                            break
                finally:
                    self._allow_layout_search = prev_layout_search
                if not spatial_ok:
                    continue
                if self._rank_candidate_for_audit(candidate, []) >= incumbent_key:
                    continue
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    return best
                audited = self._build_final_response(
                    candidate, [], include_benchmarks=False,
                    spatial_time_budget_seconds=remaining,
                )
                if self._best_audited_response([best, audited]) is audited:
                    best = audited
                    improved = True
                    break
            if not improved and time.perf_counter() < deadline:
                exchanged = self._best_order_exchange(routes, [], deadline)
                if exchanged is not None:
                    _, ex_routes, _, (first_index, second_index) = exchanged
                    reassigned = self._optimize_production_vehicles(ex_routes, [])
                    if reassigned is not None:
                        ex_routes = reassigned[1]
                    if self._rank_candidate_for_audit(ex_routes, []) < incumbent_key:
                        remaining = deadline - time.perf_counter()
                        if remaining > 0:
                            audited = self._build_final_response(
                                ex_routes, [], include_benchmarks=False,
                                spatial_time_budget_seconds=remaining,
                            )
                            if self._best_audited_response([best, audited]) is audited:
                                best = audited
                                improved = True
            if not improved and time.perf_counter() < deadline:
                reassigned = self._optimize_production_vehicles(routes, [])
                if reassigned is not None and self._rank_candidate_for_audit(reassigned[1], []) < incumbent_key:
                    remaining = deadline - time.perf_counter()
                    if remaining > 0:
                        audited = self._build_final_response(
                            reassigned[1], [], include_benchmarks=False,
                            spatial_time_budget_seconds=remaining,
                        )
                        if self._best_audited_response([best, audited]) is audited:
                            best = audited
                            improved = True
            if not improved:
                break
        return best

    def _validate_exact_route(
        self,
        vehicle_index: int,
        stops: List[ScheduledStop],
        max_time_seconds: float,
    ) -> bool:
        if max_time_seconds <= 0:
            return False
        actions = [
            StopAction(
                stop_id=stop.location_id,
                sequence=stop.sequence,
                stop_type=stop.stop_type,
                address=stop.location_name,
                latitude=stop.latitude,
                longitude=stop.longitude,
                items_to_load=[
                    self.cargo_by_id[item_id]
                    for item_id in stop.items_loaded
                    if item_id in self.cargo_by_id
                ],
                items_to_unload=list(stop.items_unloaded),
            )
            for stop in stops
        ]
        return self._validate_spatial_actions(
            vehicle_index,
            actions,
            max_time_seconds=max_time_seconds,
        ).is_valid

    def _validate_spatial_actions(
        self,
        vehicle_index: int,
        actions: List[StopAction],
        max_time_seconds: Optional[float] = None,
    ) -> SpatialValidationResult:
        vehicle = self.vehicles[vehicle_index]
        cache_key = (
            (
                vehicle.length_cm,
                vehicle.width_cm,
                vehicle.height_cm,
                vehicle.payload_limit_kg,
                vehicle.door_position,
                vehicle.door_width_cm,
            ),
            tuple(
                (
                    action.stop_type,
                    tuple(item.id for item in action.items_to_load),
                    tuple(action.items_to_unload),
                )
                for action in actions
            ),
        )
        cached = self._exact_spatial_cache.get(cache_key)
        if cached is not None:
            return cached.model_copy(deep=True)
        result = super()._validate_spatial_actions(
            vehicle_index,
            actions,
            max_time_seconds=max_time_seconds,
        )
        # A bounded search failure may only mean timeout. Cache proven valid
        # layouts, but allow a later full-budget audit to retry invalid ones.
        if result.is_valid:
            self._exact_spatial_cache[cache_key] = result.model_copy(deep=True)
        return result

    def _repair_spatial_routes(
        self,
        routes: List[List[ScheduledStop]],
        repair_time_seconds: float,
    ) -> List[List[ScheduledStop]]:
        """Resequence invalid routes into conservative pickup-delivery cycles.

        A cycle never borrows space from cargo that has not been delivered and
        never moves an onboard package.  Every replacement is scheduled first
        and then checked by the exact production validator.
        """
        repaired = copy.deepcopy(routes)
        deadline = time.perf_counter() + max(0.1, repair_time_seconds)

        for vehicle_index, route in enumerate(repaired):
            if not route or time.perf_counter() >= deadline:
                continue
            scheduled_result = self._schedule_stops(vehicle_index, route)
            if scheduled_result is None:
                continue
            scheduled = scheduled_result[0]
            remaining = deadline - time.perf_counter()
            if self._validate_exact_route(
                vehicle_index,
                scheduled,
                min(1.5, max(0.1, remaining * 0.3)),
            ):
                repaired[vehicle_index] = scheduled
                continue

            stops_by_order: Dict[str, Dict[str, ScheduledStop]] = {}
            pickup_order: List[str] = []
            malformed = False
            for stop in route:
                order_id = stop.allocation_id or stop.order_id
                if not order_id or stop.stop_type not in {"PICKUP", "DELIVERY"}:
                    malformed = True
                    break
                if order_id not in stops_by_order:
                    stops_by_order[order_id] = {}
                    pickup_order.append(order_id)
                if stop.stop_type in stops_by_order[order_id]:
                    malformed = True
                    break
                stops_by_order[order_id][stop.stop_type] = stop
            if malformed or any(
                set(by_type) != {"PICKUP", "DELIVERY"}
                for by_type in stops_by_order.values()
            ):
                continue

            if len(pickup_order) <= 7:
                orderings = permutations(pickup_order)
            else:
                deadline_order = sorted(
                    pickup_order,
                    key=lambda order_id: (
                        self.order_by_id[order_id].delivery_window_end_sec,
                        self.order_by_id[order_id].pickup_window_start_sec,
                    ),
                )
                pickup_window_order = sorted(
                    pickup_order,
                    key=lambda order_id: (
                        self.order_by_id[order_id].pickup_window_start_sec,
                        self.order_by_id[order_id].delivery_window_end_sec,
                    ),
                )
                orderings = iter(
                    (
                        tuple(pickup_order),
                        tuple(deadline_order),
                        tuple(pickup_window_order),
                        tuple(reversed(pickup_order)),
                    )
                )

            candidates: List[Tuple[float, List[ScheduledStop]]] = []
            seen: Set[Tuple[str, ...]] = set()
            for ordering in orderings:
                if time.perf_counter() >= deadline:
                    break
                ordering_tuple = tuple(ordering)
                if ordering_tuple in seen:
                    continue
                seen.add(ordering_tuple)
                cycle_stops = [
                    stops_by_order[order_id][stop_type]
                    for order_id in ordering_tuple
                    for stop_type in ("PICKUP", "DELIVERY")
                ]
                candidate_schedule = self._schedule_stops(
                    vehicle_index, cycle_stops
                )
                if candidate_schedule is None:
                    continue
                scheduled_cycle = candidate_schedule[0]
                candidates.append(
                    (
                        self._calc_route_distance_km(
                            vehicle_index, scheduled_cycle
                        ),
                        scheduled_cycle,
                    )
                )

            candidates.sort(key=lambda candidate: candidate[0])
            for _, scheduled_cycle in candidates:
                remaining = deadline - time.perf_counter()
                if remaining <= 0:
                    break
                if self._validate_exact_route(
                    vehicle_index, scheduled_cycle, remaining
                ):
                    repaired[vehicle_index] = scheduled_cycle
                    break

        return repaired

    def _matched_vehicle_driver_indices(self) -> List[Tuple[int, int]]:
        """Build a maximum legal one-to-one resource matching for hybrid search."""
        candidates: Dict[int, List[int]] = {}
        for vehicle_index, vehicle in enumerate(self.vehicles):
            vehicle_type = vehicle.vehicle_type or vehicle.model or ""
            candidates[vehicle_index] = sorted(
                (
                    driver_index
                    for driver_index, driver in enumerate(self.drivers)
                    if driver.service_day_index == vehicle.service_day_index
                    and can_driver_drive_vehicle(
                        driver.license_class,
                        vehicle.payload_limit_kg,
                        vehicle_type,
                    )
                ),
                key=lambda driver_index: (
                    self.drivers[driver_index].trip_base_pay_vnd,
                    self.drivers[driver_index].per_km_pay_vnd,
                    self.drivers[driver_index].fixed_salary_monthly_vnd,
                    0 if (
                        self.drivers[driver_index].source_driver_id == vehicle.source_vehicle_id
                        or self.drivers[driver_index].id.split('#')[0] == vehicle.id.split('#')[0]
                    ) else 1,
                    abs(driver_index - vehicle_index),
                    self.drivers[driver_index].id,
                ),
            )

        driver_to_vehicle: Dict[int, int] = {}

        def assign(vehicle_index: int, seen_drivers: Set[int]) -> bool:
            # Preserve earlier cost preferences when an unused legal driver
            # exists. Augment only when necessary to retain maximum coverage.
            for driver_index in candidates[vehicle_index]:
                if driver_index not in seen_drivers and driver_index not in driver_to_vehicle:
                    seen_drivers.add(driver_index)
                    driver_to_vehicle[driver_index] = vehicle_index
                    return True
            for driver_index in candidates[vehicle_index]:
                if driver_index in seen_drivers:
                    continue
                seen_drivers.add(driver_index)
                previous_vehicle = driver_to_vehicle.get(driver_index)
                if previous_vehicle is None or assign(
                    previous_vehicle, seen_drivers
                ):
                    driver_to_vehicle[driver_index] = vehicle_index
                    return True
            return False

        for vehicle_index in sorted(
            candidates,
            key=lambda index: (len(candidates[index]), index),
        ):
            assign(vehicle_index, set())

        return sorted(
            (
                (vehicle_index, driver_index)
                for driver_index, vehicle_index in driver_to_vehicle.items()
            ),
            key=lambda pair: pair[0],
        )

    def _build_hybrid_initial_solution(
        self,
        vehicles: Sequence[HybridVehicle],
        drivers: Sequence[HybridDriver],
        original_vehicle_indices: Sequence[int],
        pickup_key_by_order: Dict[str, str],
        delivery_key_by_order: Dict[str, str],
    ) -> Optional[HybridOptimizationSolution]:
        warm_state = self._warm_start_state()
        self._native_search_budget_available = True
        solver_name = "OR-Tools production warm start"
        self._ils_elite_routes_pool = []
        if warm_state is not None:
            _, production_routes, warm_unassigned = warm_state
            self._construction_audit_fallback = (copy.deepcopy(production_routes), list(warm_unassigned))
            self._ils_elite_routes_pool.append(
                (self._candidate_key(production_routes, warm_unassigned),
                    copy.deepcopy(production_routes), list(warm_unassigned))
            )
        else:
            solver_name = "Fleet ALNS initial solution"
            t_start = time.perf_counter()
            old_layout_search = getattr(self, "_allow_layout_search", False)
            old_ranked_repair = self._use_ranked_repair
            old_seed_deadline = self._seed_search_deadline
            self._allow_layout_search = False
            self._use_ranked_repair = False

            # 1. Nghiệm khởi tạo ban đầu: repair_greedy_insert
            routes_a: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
            routes_a, unassigned_a = self._repair_greedy_insert(
                routes_a,
                [order.id for order in self.orders],
                start_time=t_start,
                randomize=False,
            )
            cur_routes = routes_a
            cur_unassigned = unassigned_a
            cur_cost, _, _ = self._evaluate_plan_cost(cur_routes, cur_unassigned)
            cur_key = self._candidate_key(cur_routes, cur_unassigned)
            best_routes = copy.deepcopy(cur_routes)
            best_unassigned = list(cur_unassigned)
            best_key = cur_key
            best_cost = cur_cost

            self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))
            self._construction_audit_fallback = (copy.deepcopy(best_routes), list(best_unassigned))

            # Phân bổ ngân sách tìm kiếm thực sự sau khi greedy hoàn thành
            budget_p1 = max(1.5, (self.time_limit_sec or 2.0) * 0.65)
            if cur_unassigned:
                # Construction-limited instances spend the native allocation
                # on completing/rebuilding the seed instead. Keep the same
                # combined search budget and the post-audit reserve.
                budget_p1 += self.time_limit_sec - self._post_audit_budget_sec
                self._native_search_budget_available = False
            search_started_at = time.perf_counter()
            deadline_p1 = search_started_at + budget_p1
            self._seed_search_deadline = deadline_p1

            # Construction may stop with missing orders. Spend the fresh phase
            # budget on coverage before moving already served orders for cost.
            if cur_unassigned:
                # A partial greedy basin can remain fragmented even after
                # filling its missing orders. Rebuild within this same phase
                # using ranked probes, retaining the original as a fallback.
                self._use_ranked_repair = True
                cur_routes, cur_unassigned = self._repair_greedy_insert(
                    [[] for _ in self.vehicles], [order.id for order in self.orders],
                    start_time=search_started_at,
                    deadline=min(deadline_p1, search_started_at+self.time_limit_sec), randomize=False,
                )
                if cur_unassigned and time.perf_counter() < deadline_p1:
                    cur_routes, cur_unassigned = self._repair_greedy_insert(
                        cur_routes, cur_unassigned, start_time=time.perf_counter(),
                        deadline=deadline_p1, randomize=False,
                    )
                cur_cost, _, _ = self._evaluate_plan_cost(cur_routes, cur_unassigned)
                cur_key = self._candidate_key(cur_routes, cur_unassigned)
                if cur_key < best_key:
                    best_key, best_cost = cur_key, cur_cost
                    best_routes = copy.deepcopy(cur_routes)
                    best_unassigned = list(cur_unassigned)
                    self._ils_elite_routes_pool.append(
                        (best_key, copy.deepcopy(best_routes), list(best_unassigned))
                    )
                    self._construction_audit_fallback = (copy.deepcopy(best_routes), list(best_unassigned))

            # Chạy chu trình tìm kiếm ILS/ALNS khám phá & gom xe
            perturbation = 0
            iteration = 0
            while iteration < 200 and time.perf_counter() < deadline_p1:
                iteration += 1
                reloc = super()._best_relocation(cur_routes, cur_unassigned, search_started_at, deadline_p1)
                if reloc is not None:
                    cur_cost, cur_routes, cur_unassigned = reloc
                    cur_key = self._candidate_key(cur_routes, cur_unassigned)
                    if cur_key < best_key:
                        best_key, best_cost = cur_key, cur_cost
                        best_routes = copy.deepcopy(cur_routes)
                        best_unassigned = list(cur_unassigned)
                        self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))
                        perturbation = 0
                    continue

                elim = self._try_route_elimination(cur_routes, cur_unassigned, search_started_at, deadline_p1)
                if elim is not None:
                    cur_cost, cur_routes, cur_unassigned = elim
                    cur_key = self._candidate_key(cur_routes, cur_unassigned)
                    if cur_key < best_key:
                        best_key, best_cost = cur_key, cur_cost
                        best_routes = copy.deepcopy(cur_routes)
                        best_unassigned = list(cur_unassigned)
                        self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))
                        perturbation = 0
                    continue

                swapped = self._try_order_swap_1_1(cur_routes, cur_unassigned, search_started_at, deadline_p1)
                if swapped is not None:
                    cur_cost, cur_routes, cur_unassigned = swapped
                    cur_key = self._candidate_key(cur_routes, cur_unassigned)
                    if cur_key < best_key:
                        best_key, best_cost = cur_key, cur_cost
                        best_routes = copy.deepcopy(cur_routes)
                        best_unassigned = list(cur_unassigned)
                        self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))
                        perturbation = 0
                    continue

                reassigned = self._try_vehicle_reassignment(cur_routes, cur_unassigned)
                if reassigned is not None:
                    cur_cost, cur_routes, cur_unassigned = reassigned
                    cur_key = self._candidate_key(cur_routes, cur_unassigned)
                    if cur_key < best_key:
                        best_key, best_cost = cur_key, cur_cost
                        best_routes = copy.deepcopy(cur_routes)
                        best_unassigned = list(cur_unassigned)
                        self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))
                        perturbation = 0
                    continue

                assigned_count = len(self._assigned_order_ids(best_routes))
                if assigned_count == 0 or time.perf_counter() >= deadline_p1:
                    break
                perturbation += 1
                removal_ratio = min(0.35, 0.15 + 0.05 * perturbation)
                remove_count = min(assigned_count, max(2, round(assigned_count * removal_ratio)))
                # This seed stream complements ALNS's route/cluster removal.
                # Scattered removals explore cross-route exchanges that whole
                # route destruction can repeatedly reconstruct identically.
                perturbed, removed = self._destroy_random(copy.deepcopy(best_routes), remove_count)

                cur_routes, failed = self._repair_greedy_insert(
                    perturbed, list(dict.fromkeys(best_unassigned + removed)),
                    start_time=search_started_at, deadline=deadline_p1,
                )
                cur_unassigned = failed
                cur_cost, _, _ = self._evaluate_plan_cost(cur_routes, cur_unassigned)
                cur_key = self._candidate_key(cur_routes, cur_unassigned)
                if cur_key < best_key:
                    best_key, best_cost = cur_key, cur_cost
                    best_routes = copy.deepcopy(cur_routes)
                    best_unassigned = list(cur_unassigned)
                    self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))
                    perturbation = 0

            reassigned = self._production_vehicle_reassignment(best_routes, best_unassigned)
            if reassigned is not None:
                best_cost, best_routes, best_unassigned = reassigned
                best_key = self._candidate_key(best_routes, best_unassigned)
                self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))

            self._allow_layout_search = old_layout_search
            self._use_ranked_repair = old_ranked_repair
            self._seed_search_deadline = old_seed_deadline
            production_routes = best_routes
        hybrid_position_by_original = {
            original_index: hybrid_index
            for hybrid_index, original_index in enumerate(original_vehicle_indices)
        }
        routes: List[HybridOptimizedRoute] = []
        assigned: Set[str] = set()
        for original_index, production_stops in enumerate(production_routes):
            hybrid_index = hybrid_position_by_original.get(original_index)
            if hybrid_index is None or not production_stops:
                continue
            converted_stops: List[HybridScheduledStop] = []
            for sequence, stop in enumerate(production_stops, start=1):
                order_id = stop.allocation_id or stop.order_id
                order = self.order_by_id.get(order_id or "")
                if order is None:
                    converted_stops = []
                    break
                converted_stops.append(
                    HybridScheduledStop(
                        sequence=sequence,
                        stop_type=stop.stop_type,
                        location_id=(
                            pickup_key_by_order[order.id]
                            if stop.stop_type == "PICKUP"
                            else delivery_key_by_order[order.id]
                        ),
                        location_name=(
                            order.pickup_location.name
                            if stop.stop_type == "PICKUP"
                            else order.delivery_location.name
                        ),
                        order_id=order.id,
                        order_number=order.order_number,
                        arrival_time_sec=stop.arrival_time_sec,
                        departure_time_sec=stop.departure_time_sec,
                        current_weight_kg=stop.current_weight_kg,
                        items_loaded=list(stop.items_loaded),
                        items_unloaded=list(stop.items_unloaded),
                    )
                )
                if stop.stop_type == "PICKUP":
                    assigned.add(order.id)
            if converted_stops:
                routes.append(
                    HybridOptimizedRoute(
                        vehicle=vehicles[hybrid_index],
                        driver=drivers[hybrid_index],
                        stops=converted_stops,
                        total_distance_km=0.0,
                        total_duration_minutes=0.0,
                        cost_breakdown=HybridRouteCostBreakdown(),
                    )
                )

        if not routes:
            return None
        unassigned = [order.id for order in self.orders if order.id not in assigned]
        return HybridOptimizationSolution(
            solver_name=solver_name,
            execution_time_sec=0.0,
            routes=routes,
            unassigned_orders=unassigned,
            real_economic_cost_vnd=0,
            penalized_objective_vnd=0,
            total_distance_km=0.0,
            fulfillment_rate=round(
                len(assigned) / max(1, len(self.orders)) * 100.0,
                1,
            ),
            is_spatial_valid=True,
            is_temporally_valid=True,
            is_contract_valid=True,
            solution_audited=False,
            random_seed=self.random_seed,
        )

    def solve(self) -> FleetOptimizationResponse:
        resource_pairs = self._matched_vehicle_driver_indices()
        if not resource_pairs:
            result = self._build_final_response(
                [[] for _ in self.vehicles],
                [order.id for order in self.orders],
                include_benchmarks=self.include_benchmarks,
            )
            result.diagnostics.append(
                "Hybrid ALNS không có cặp xe–tài xế hợp lệ theo ngày và hạng bằng."
            )
            return result

        vehicles: List[HybridVehicle] = []
        drivers: List[HybridDriver] = []
        original_vehicle_indices: List[int] = []
        node_id_to_index: Dict[str, int] = {}

        for original_vehicle_index, driver_index in resource_pairs:
            vehicle = self.vehicles[original_vehicle_index]
            driver = self.drivers[driver_index]
            depot_key = f"depot_{vehicle.id}"
            vehicles.append(
                HybridVehicle(
                    id=vehicle.id,
                    plate_number=vehicle.plate_number,
                    length_cm=float(vehicle.length_cm),
                    width_cm=float(vehicle.width_cm),
                    height_cm=float(vehicle.height_cm),
                    payload_limit_kg=float(vehicle.payload_limit_kg),
                    depot=HybridLocation(
                        id=depot_key,
                        name=vehicle.depot.name or "Depot",
                        latitude=float(vehicle.depot.latitude),
                        longitude=float(vehicle.depot.longitude),
                    ),
                    door_position=vehicle.door_position,
                    fuel_consumption_liters_per_100_km=float(
                        vehicle.fuel_consumption_liters_per_100_km
                    ),
                    load_fuel_surcharge_percent_at_full_payload=float(
                        vehicle.load_fuel_surcharge_percent_at_full_payload
                    ),
                    fixed_operating_cost_vnd=int(
                        vehicle.fixed_operating_cost_vnd
                    ),
                    source_vehicle_id=vehicle.source_vehicle_id,
                    service_day_index=vehicle.service_day_index,
                    available_start_sec=vehicle.available_start_sec,
                    available_end_sec=vehicle.available_end_sec,
                )
            )
            drivers.append(
                HybridDriver(
                    id=driver.id,
                    full_name=driver.full_name,
                    license_class=driver.license_class,
                    fixed_salary_monthly_vnd=int(
                        driver.fixed_salary_monthly_vnd
                    ),
                    trip_base_pay_vnd=int(driver.trip_base_pay_vnd),
                    per_km_pay_vnd=int(driver.per_km_pay_vnd),
                    source_driver_id=driver.source_driver_id,
                    service_day_index=driver.service_day_index,
                )
            )
            original_vehicle_indices.append(original_vehicle_index)
            node_id_to_index[depot_key] = original_vehicle_index

        orders: List[HybridOrder] = []
        pickup_key_by_order: Dict[str, str] = {}
        delivery_key_by_order: Dict[str, str] = {}
        for order_index, order in enumerate(self.orders):
            pickup_key = f"p_{order.id}"
            delivery_key = f"d_{order.id}"
            pickup_key_by_order[order.id] = pickup_key
            delivery_key_by_order[order.id] = delivery_key
            orders.append(
                HybridOrder(
                    id=order.id,
                    order_number=order.order_number,
                    pickup_location=HybridLocation(
                        id=pickup_key,
                        name=order.pickup_location.name or "Pickup",
                        latitude=float(order.pickup_location.latitude),
                        longitude=float(order.pickup_location.longitude),
                    ),
                    delivery_location=HybridLocation(
                        id=delivery_key,
                        name=order.delivery_location.name or "Delivery",
                        latitude=float(order.delivery_location.latitude),
                        longitude=float(order.delivery_location.longitude),
                    ),
                    items=[
                        HybridCargoItem(
                            id=item.id,
                            order_id=order.id,
                            length_cm=float(item.length_cm),
                            width_cm=float(item.width_cm),
                            height_cm=float(item.height_cm),
                            weight_kg=float(item.weight_kg),
                            # D11 permits floor rotation of rectangular cargo,
                            # including older snapshots marked non-rotatable.
                            can_rotate=True,
                            description=item.description or "",
                        )
                        for item in order.items
                    ],
                    service_time_sec=int(order.service_time_sec),
                    pickup_window_start_sec=int(
                        order.pickup_window_start_sec
                    ),
                    pickup_window_end_sec=int(order.pickup_window_end_sec),
                    delivery_window_start_sec=int(
                        order.delivery_window_start_sec
                    ),
                    delivery_window_end_sec=int(
                        order.delivery_window_end_sec
                    ),
                    order_value_vnd=int(order.order_value_vnd),
                    allowed_source_vehicle_ids=list(
                        order.allowed_source_vehicle_ids
                    ),
                    source_order_id=order.source_order_id or order.id,
                    split_group_id=order.split_group_id,
                    pickup_service_time_sec=(
                        int(order.pickup_service_time_sec)
                        if order.pickup_service_time_sec is not None
                        else None
                    ),
                    delivery_service_time_sec=(
                        int(order.delivery_service_time_sec)
                        if order.delivery_service_time_sec is not None
                        else None
                    ),
                )
            )
            node_id_to_index[pickup_key] = len(self.vehicles) + 2 * order_index
            node_id_to_index[delivery_key] = (
                len(self.vehicles) + 2 * order_index + 1
            )

        policy = HybridPolicy(
            fuel_price_per_liter_vnd=int(
                self.policy.fuel_price_per_liter_vnd
            ),
            monthly_working_minutes=int(self.policy.monthly_working_minutes),
            cargo_holding_cost_vnd_per_ton_hour=int(
                self.policy.cargo_holding_cost_vnd_per_ton_hour
            ),
            unassigned_order_penalty_vnd=int(
                self.policy.unassigned_order_penalty_vnd
            ),
            late_delivery_penalty_mode=self.policy.late_delivery_penalty_mode,
            late_delivery_penalty_value=float(
                self.policy.late_delivery_penalty_value
            ),
        )
        initial_solution = self._build_hybrid_initial_solution(
            vehicles,
            drivers,
            original_vehicle_indices,
            pickup_key_by_order,
            delivery_key_by_order,
        )

        operator_weights: Dict[str, Dict[str, float]] = {}
        solution = initial_solution
        if self._native_search_budget_available:
            solution = solve_hybrid_alns(
                vehicles, drivers, orders, policy,
                self.request.distance_matrix_meters,
                self.request.duration_matrix_seconds, node_id_to_index,
                time_limit_sec=self.time_limit_sec,
                post_audit_reserve_sec=self._post_audit_budget_sec,
                max_iterations=self.max_iterations, random_seed=self.random_seed,
                initial_solution=initial_solution, operator_weights_out=operator_weights,
                search_profile="historical_portfolio",
                final_spatial_time_limit_sec=min(3.5, max(2.0, self.time_limit_sec * 0.35)),
                final_repair_time_limit_sec=min(4.5, max(2.5, self.time_limit_sec * 0.45)),
            )
        if "destroy" in operator_weights:
            self.destroy_weights = operator_weights["destroy"]
        if "repair" in operator_weights:
            self.repair_weights = operator_weights["repair"]

        original_index_by_vehicle_id = {
            self.vehicles[index].id: index
            for index in original_vehicle_indices
        }
        order_id_by_number = {
            order.order_number: order.id for order in self.orders
        }

        candidate_sols = [solution] if solution is not None else []
        if initial_solution is not None:
            candidate_sols.append(initial_solution)
        for extra_sol in getattr(solution, "_candidate_solutions", []):
            if extra_sol is not solution and extra_sol is not initial_solution:
                candidate_sols.append(extra_sol)

        all_candidate_plans: List[Tuple[List[List[ScheduledStop]], List[str]]] = []
        for cand_sol in candidate_sols:
            c_routes_stops: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
            for route in cand_sol.routes:
                vehicle_index = original_index_by_vehicle_id.get(route.vehicle.id)
                if vehicle_index is None:
                    continue
                converted_stops: List[ScheduledStop] = []
                for sequence, stop in enumerate(route.stops, start=1):
                    order = self.order_by_id.get(stop.order_id or "")
                    if order is None:
                        continue
                    location = (
                        order.pickup_location
                        if stop.stop_type == "PICKUP"
                        else order.delivery_location
                    )
                    converted_stops.append(
                        ScheduledStop(
                            sequence=sequence,
                            stop_type=stop.stop_type,
                            location_id=location.id,
                            location_name=location.name,
                            order_id=order.id,
                            allocation_id=order.id,
                            latitude=location.latitude,
                            longitude=location.longitude,
                            arrival_time_sec=int(stop.arrival_time_sec),
                            departure_time_sec=int(stop.departure_time_sec),
                            items_loaded=list(stop.items_loaded),
                            items_unloaded=list(stop.items_unloaded),
                        )
                    )
                c_routes_stops[vehicle_index] = converted_stops

            unassigned_ids = [
                order_id_by_number.get(value, value)
                for value in cand_sol.unassigned_orders
            ]
            all_candidate_plans.append((c_routes_stops, unassigned_ids))

        for _, ils_routes, ils_unassigned in getattr(self, "_ils_elite_routes_pool", []):
            all_candidate_plans.append((copy.deepcopy(ils_routes), list(ils_unassigned)))

        unique_plans = []
        seen_signatures = set()
        pool = getattr(self, "_ils_elite_routes_pool", [])
        construction_signature = None
        fallback_state = self._construction_audit_fallback
        if fallback_state is None and pool:
            _, seed_routes, seed_missing = pool[0]
            fallback_state = (seed_routes, seed_missing)
        if fallback_state is not None:
            seed_routes, seed_missing = fallback_state
            construction_signature = (self._state_signature(seed_routes), tuple(sorted(seed_missing)))
        construction_fallback = None
        for c_routes, c_unassigned in all_candidate_plans:
            route_signature = self._state_signature(c_routes)
            sig = (route_signature, tuple(sorted(c_unassigned)))
            if sig not in seen_signatures:
                seen_signatures.add(sig)
                reassigned = self._optimize_production_vehicles(c_routes, c_unassigned)
                if reassigned is not None:
                    r_routes, r_unassigned = reassigned[1], reassigned[2]
                else:
                    r_routes, r_unassigned = c_routes, c_unassigned
                candidate = (self._rank_candidate_for_audit(r_routes, r_unassigned), r_routes, r_unassigned)
                unique_plans.append(candidate)
                if sig == construction_signature:
                    construction_fallback = candidate

        unique_plans.sort(key=lambda x: x[0])

        audit_candidates = self._select_audit_candidates(unique_plans, limit=6, fallback=construction_fallback)
        valid_responses: List[FleetOptimizationResponse] = []
        for _, c_routes_stops, unassigned_ids in audit_candidates:
            cand_resp = self._build_final_response(
                c_routes_stops,
                unassigned_ids,
                include_benchmarks=False,
                spatial_time_budget_seconds=max(8.0, sum(bool(r) for r in c_routes_stops) * 3.0),
            )
            if not cand_resp.unassigned_orders:
                valid_responses.append(cand_resp)
            elif not valid_responses:
                valid_responses.append(cand_resp)

        polish_deadline = max(
            time.perf_counter() + 0.05,
            time.perf_counter() + self._post_audit_budget_sec,
        )
        full_valid = [r for r in valid_responses if not r.unassigned_orders]
        if full_valid:
            for r in full_valid:
                apply_planning_objective(self.objective_request, r)
            full_valid.sort(key=plan_lexicographic_key)
            best_so_far: Optional[FleetOptimizationResponse] = None
            for idx, resp in enumerate(full_valid[:2]):
                rem = polish_deadline - time.perf_counter()
                if rem <= 0:
                    polished = resp
                else:
                    slice_deadline = (
                        time.perf_counter() + max(0.05, rem * 0.65)
                        if idx == 0 and len(full_valid) > 1
                        else polish_deadline
                    )
                    polished = self._polish_audited_response(resp, slice_deadline)
                best_so_far = (
                    polished
                    if best_so_far is None
                    else self._best_audited_response([best_so_far, polished])
                )
            if len(full_valid) > 2:
                best_so_far = self._best_audited_response([best_so_far, *full_valid[2:]])
            result = best_so_far
        else:
            result = self._best_audited_response(valid_responses)
            result = self._polish_audited_response(result, polish_deadline)

        if self.include_benchmarks and getattr(result, "benchmarks", None) is None:
            try:
                from .baseline_calculator import BaselineCostCalculator
                nodes = []
                for v in getattr(self, "vehicles", []):
                    nodes.append({"id": v.depot.id, "latitude": v.depot.latitude, "longitude": v.depot.longitude})
                for o in getattr(self, "orders", []):
                    nodes.append({"id": o.pickup_location.id, "latitude": o.pickup_location.latitude, "longitude": o.pickup_location.longitude, "order": o})
                    nodes.append({"id": o.delivery_location.id, "latitude": o.delivery_location.latitude, "longitude": o.delivery_location.longitude, "order": o})
                calc = BaselineCostCalculator(self.request, nodes)
                result.benchmarks = calc.build_comparison(
                    getattr(result, "routes", []),
                    getattr(result, "total_cost_vnd", 0),
                    round(getattr(result, "total_distance_km", 0.0), 2),
                    round(getattr(result, "total_duration_minutes", 0.0), 2),
                    ortools_is_feasible=(getattr(result, "status", "") == "SUCCESS"),
                )
            except Exception:
                pass
        result.diagnostics = [
            diagnostic
            for diagnostic in result.diagnostics
            if not diagnostic.startswith("ALNS hoàn tất")
        ] + [
            (
                f"Hybrid ALNS hoàn tất với seed {self.random_seed}; "
                "đã audit lại bằng SpatialValidator production."
            ),
            f"Solver nội bộ: {solution.solver_name if solution is not None else 'Dựng lại production trong ngân sách'}.",
            (
                "Kết quả là best-found trong ngân sách thời gian, "
                "không chứng minh tối ưu toàn cục."
            ),
        ]
        apply_planning_objective(self.objective_request, result)
        return result
