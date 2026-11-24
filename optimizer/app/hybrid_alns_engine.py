"""Packing-aware Hybrid ALNS for the production fleet contract.

This module ports the search ideas proven in ``algo_lab`` into production-owned
code.  It deliberately depends only on the production request/response models
and keeps :class:`SpatialValidator` (called by ``_build_final_response``) as the
final source of truth.
"""

from __future__ import annotations

import copy
import random
import math
import time
from itertools import permutations
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

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
from .hybrid_alns.savings_constructor import build_savings_routes
from .hybrid_alns.solver import solve_hybrid_alns
from .hybrid_alns.stop_moves import (
    MAX_RESEQUENCE_STOPS,
    is_single_stop_relocation,
    ranked_order_moves,
    ranked_short_route_sequences,
    ranked_stop_moves,
    ranked_subtrip_moves,
)
from .models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    UnassignedOrder,
    OrderPair,
    OptimizedRoute,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    can_driver_drive_vehicle,
)
from .planning_objective import (
    apply_planning_objective,
    calendar_salary_for_span,
    plan_lexicographic_key,
    route_operational_late_penalty,
)
from .packing_rules import resolve_can_rotate
from .spatial_cache import scoped_spatial_cache
from .stacking import effective_floor_capacity_cm2
from .route_costing import calculate_late_delivery_penalty, calculate_route_economic_metrics
Insertion = Tuple[float, int, List[ScheduledStop]]
SearchState = Tuple[int, List[List[ScheduledStop]], List[str]]
LARGE_SEED_ORDER_COUNT = 50


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
        ortools_seed_pool: Optional[Sequence[List[List[ScheduledStop]]]] = None,
        should_split_orders: bool = True,
        initial_plan_is_verified: bool = False,
    ) -> None:
        super().__init__(
            request,
            max_iterations=max_iterations,
            time_budget_seconds=time_budget_seconds,
            random_seed=random_seed,
            include_benchmarks=include_benchmarks,
            should_split_orders=should_split_orders,
        )
        self.initial_plan = initial_plan
        self._initial_plan_is_verified = initial_plan_is_verified
        self._ortools_seed_pool: List[List[List[ScheduledStop]]] = list(ortools_seed_pool or ())
        self._use_ranked_repair = True
        self._native_search_budget_available = True
        self._seed_search_deadline: Optional[float] = None
        self._construction_audit_fallback: Optional[Tuple[List[List[ScheduledStop]], List[str]]] = None
        self._verified_construction_plan: Optional[FleetOptimizationResponse] = None
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
                max_routes = getattr(self.request.policy, "max_routes_per_day", None)
                if (
                    max_routes is not None
                    and sum(
                        1
                        for idx, route in enumerate(routes)
                        if route and self.vehicles[idx].service_day_index == vehicle.service_day_index
                    )
                    >= max_routes
                ):
                    continue
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
            base_op_late = (
                route_operational_late_penalty(
                    self.request, current_stops, self.order_by_id
                )
                if self.policy.late_delivery_penalty_mode == "NONE"
                else 0
            )
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
                op_late_delta = (
                    route_operational_late_penalty(
                        self.request, candidate_stops, self.order_by_id
                    )
                    - base_op_late
                    if self.policy.late_delivery_penalty_mode == "NONE"
                    else 0
                )
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
                    + op_late_delta
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

    def _single_order_fits_vehicle_floor(
        self,
        vehicle_index: int,
        order_id: str,
        pair_stops: List[ScheduledStop],
        deadline: float,
        spatially_checked: Set[Tuple[Any, ...]],
        fit_cache: Optional[Dict[Tuple[str, Tuple[Any, ...]], bool]] = None,
        exact_cap_seconds: float = 0.05,
    ) -> bool:
        """Check whether an isolated pickup-delivery pair fits on the vehicle floor."""
        if self._validate_stops_cached(vehicle_index, pair_stops):
            return True
        vehicle = self.vehicles[vehicle_index]
        profile = (
            vehicle.length_cm,
            vehicle.width_cm,
            vehicle.height_cm,
            vehicle.payload_limit_kg,
            vehicle.door_position,
            vehicle.door_width_cm,
        )
        cache_key = (order_id, profile)
        if fit_cache is not None and cache_key in fit_cache:
            return fit_cache[cache_key]
        if profile in spatially_checked:
            return False
        spatially_checked.add(profile)
        remaining = deadline - time.perf_counter()
        if remaining <= 0.0:
            return False
        budget = min(exact_cap_seconds, remaining)
        actions = [
            stop.model_copy(update={"sequence": n})
            for n, stop in enumerate(pair_stops, 1)
        ]
        fits = self._validate_exact_route(vehicle_index, actions, budget)
        if fit_cache is not None and (fits or budget >= exact_cap_seconds * 0.5):
            fit_cache[cache_key] = fits
        return fits

    def _conservative_cycle_construction(
        self,
        order_sequence: Sequence[str],
        deadline: float,
        vehicle_indices: Sequence[int],
        fit_cache: Optional[Dict[Tuple[str, Tuple[Any, ...]], bool]] = None,
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
            exact_cap = 0.25 if len(order.items) >= 40 else 0.08
            spatially_checked: Set[Tuple[Any, ...]] = set()
            best: Optional[Tuple[int, float, int, List[ScheduledStop]]] = None
            for vehicle_index in vehicle_indices:
                if time.perf_counter() >= deadline:
                    break
                current_route = routes[vehicle_index]
                feasible, candidate_stops = self._can_insert_order(
                    vehicle_index,
                    current_route,
                    order,
                    len(current_route),
                    len(current_route) + 1,
                    check_packing=False,
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
                option = (len(current_route), score, vehicle_index, candidate_stops)
                if best is not None and option[:3] >= best[:3]:
                    continue
                if not self._single_order_fits_vehicle_floor(
                    vehicle_index,
                    order_id,
                    candidate_stops[-2:],
                    deadline,
                    spatially_checked,
                    fit_cache=fit_cache,
                    exact_cap_seconds=exact_cap,
                ):
                    continue
                best = option
            if best is None:
                unassigned.append(order_id)
            else:
                routes[best[2]] = best[3]
        return routes, unassigned

    def _audited_cycle_checkpoint(
        self,
        vehicle_indices: Sequence[int],
        deadline: float,
        max_attempts: int = 12,
    ) -> Optional[FleetOptimizationResponse]:
        natural_sequence = [order.id for order in self.orders]
        largest_first_sequence = [
            order.id
            for order in sorted(
                self.orders,
                key=lambda item: (-len(item.items), item.id),
            )
        ]
        candidate_sequences: List[List[str]] = [largest_first_sequence]
        if natural_sequence != largest_first_sequence:
            candidate_sequences.append(natural_sequence)
        rng = random.Random(0)
        shuffled = list(natural_sequence)
        while len(candidate_sequences) < max_attempts:
            rng.shuffle(shuffled)
            candidate_sequences.append(list(shuffled))
        fit_cache: Dict[Tuple[str, Tuple[Any, ...]], bool] = {}
        seen_route_signatures: Set[Tuple[Any, ...]] = set()
        audited_any = False
        for sequence in candidate_sequences[:max_attempts]:
            now = time.perf_counter()
            remaining = deadline - now
            if remaining <= 0 or (audited_any and remaining < 0.9):
                break
            # Reserve at least 55% of remaining checkpoint time for 3D response auditing
            # so dense-cargo construction cannot starve _build_final_response near the deadline.
            construction_deadline = min(deadline, now + max(0.25, remaining * 0.45))
            routes, missing = self._conservative_cycle_construction(
                sequence, construction_deadline, vehicle_indices, fit_cache=fit_cache
            )
            if not missing:
                route_signature = tuple(
                    (
                        idx,
                        tuple(
                            (stop.allocation_id or stop.order_id or "", stop.stop_type)
                            for stop in stops
                        ),
                    )
                    for idx, stops in enumerate(routes)
                    if stops
                )
                if route_signature in seen_route_signatures:
                    continue
                seen_route_signatures.add(route_signature)
                audited_any = True
                audit_slice = max(1.2, deadline - time.perf_counter())
                audit_deadline = time.perf_counter() + audit_slice
                result = self._build_final_response(
                    routes, [], include_benchmarks=False,
                    spatial_time_budget_seconds=audit_slice,
                    absolute_spatial_deadline=audit_deadline,
                )
                if result.status == "SUCCESS" and not result.unassigned_orders:
                    return result
        return None

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
        reserve_fallback = 1 if (fallback is not None and limit >= 2) else 0
        main_limit = limit - reserve_fallback
        selected: List[SearchState] = []
        overflow: List[SearchState] = []
        route_count_frequency: Dict[int, int] = {}
        for candidate in candidates:
            if candidate is fallback:
                continue
            route_count = sum(bool(route) for route in candidate[1])
            if route_count not in route_count_frequency:
                selected.append(candidate)
                route_count_frequency[route_count] = 1
                if len(selected) >= main_limit:
                    break
            else:
                overflow.append(candidate)
        if len(selected) < main_limit:
            for candidate in overflow:
                route_count = sum(bool(route) for route in candidate[1])
                if route_count_frequency.get(route_count, 0) >= max_per_route_count:
                    continue
                selected.append(candidate)
                route_count_frequency[route_count] = (
                    route_count_frequency.get(route_count, 0) + 1
                )
                if len(selected) >= main_limit:
                    break
        if (
            fallback is not None
            and len(selected) < limit
            and not any(item is fallback for item in selected)
        ):
            selected.append(fallback)
        return selected

    @staticmethod
    def _inject_objective_audit_candidate(
        selected: List[SearchState],
        candidates: Sequence[SearchState],
        *,
        limit: int,
        fallback: Optional[SearchState] = None,
    ) -> List[SearchState]:
        """Ensure the best company-objective basin is audited in multi-day runs."""
        if limit < 3 or not candidates:
            return selected

        def _objective_first_key(item: SearchState) -> Tuple[Any, ...]:
            key = item[0]
            if isinstance(key, tuple) and len(key) >= 6:
                return (key[0], key[1], key[3], key[4], key[2], *key[5:])
            return key if isinstance(key, tuple) else (0, key)

        best_objective = min(candidates, key=_objective_first_key)
        if any(item is best_objective for item in selected):
            return selected
        if len(selected) < limit:
            return [*selected, best_objective]
        replace_idx = next(
            (idx for idx in range(len(selected) - 1, -1, -1) if selected[idx] is not fallback),
            None,
        )
        if replace_idx is None:
            return selected
        updated = list(selected)
        updated[replace_idx] = best_objective
        return updated

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
                vehicle = self.vehicles[index]
                weight = 0.0
                for stop in scheduled_stops:
                    order = self.order_by_id[stop.allocation_id or stop.order_id]
                    weight += order.total_weight_kg * (1 if stop.stop_type == "PICKUP" else -1)
                    if weight > vehicle.payload_limit_kg + 0.01:
                        return invalid_key
                    stop.current_weight_kg = max(0.0, weight)
                base, surcharge, holding, ton_km, ton_hours = calculate_route_economic_metrics(
                    self.request, nodes, self.order_by_id, vehicle, scheduled_stops,
                )
                late = sum(calculate_late_delivery_penalty(
                    self.order_by_id[stop.allocation_id or stop.order_id], stop.arrival_time_sec, self.policy,
                ) for stop in scheduled_stops if stop.stop_type == "DELIVERY")
                start, scheduled_stops = self._adjust_first_stop_waiting_for_jit_start(
                    vehicle, scheduled_stops
                )
                cached_route = OptimizedRoute(
                    route_id=vehicle.id, vehicle_id=vehicle.source_vehicle_id or vehicle.id,
                    service_day_index=vehicle.service_day_index, plate_number=vehicle.plate_number,
                    vehicle_length_cm=vehicle.length_cm, vehicle_width_cm=vehicle.width_cm, vehicle_height_cm=vehicle.height_cm,
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
        self, routes: List[List[ScheduledStop]], unassigned: List[str], deadline: Optional[float] = None,
    ) -> Optional[SearchState]:
        """Retain the incumbent when an operating-cost move hurts company score."""
        reassigned = self._try_vehicle_reassignment(routes, unassigned, deadline)
        if reassigned is not None and self._rank_candidate_for_audit(
            reassigned[1], reassigned[2],
        ) < self._rank_candidate_for_audit(routes, unassigned):
            return reassigned
        return None

    def _optimize_production_vehicles(
        self, routes: List[List[ScheduledStop]], unassigned: List[str], deadline: Optional[float] = None,
    ) -> Optional[SearchState]:
        """Reassign idle vehicles and swap active vehicles when company score improves."""
        cur_routes = routes
        cur_unassigned = unassigned
        cur_rank = self._rank_candidate_for_audit(cur_routes, cur_unassigned)
        changed = False
        for _ in range(len(self.vehicles)):
            if deadline is not None and time.perf_counter() >= deadline:
                break
            step_changed = False
            reassigned = self._try_vehicle_reassignment(cur_routes, cur_unassigned, deadline)
            if reassigned is not None:
                cand_rank = self._rank_candidate_for_audit(reassigned[1], reassigned[2])
                if cand_rank < cur_rank:
                    cur_routes, cur_unassigned, cur_rank = reassigned[1], reassigned[2], cand_rank
                    changed = True
                    step_changed = True
            if not step_changed:
                active_indices = [i for i, r in enumerate(cur_routes) if r]
                empty_indices = [i for i, r in enumerate(cur_routes) if not r]
                phys_route_counts: Dict[str, int] = {}
                for idx_a in active_indices:
                    pid = self.vehicles[idx_a].source_vehicle_id or self.vehicles[idx_a].id
                    phys_route_counts[pid] = phys_route_counts.get(pid, 0) + 1
                max_active_day = max(
                    (self.vehicles[idx_a].service_day_index for idx_a in active_indices),
                    default=0,
                )
                # Fast O(1) operating cost screening avoids calling expensive full DriverMatcher
                # on hundreds of non-improving (src_i, tgt_i) slots.
                route_op_cost_cache = {
                    idx_a: (
                        self.vehicles[idx_a].fixed_operating_cost_vnd
                        + (self.vehicles[idx_a].fuel_consumption_liters_per_100_km / 100.0)
                        * self._calc_route_distance_km(idx_a, cur_routes[idx_a])
                        * self.policy.fuel_price_per_liter_vnd
                    )
                    for idx_a in active_indices
                }
                shortlisted_moves: List[Tuple[int, float, int, int]] = []
                for src_i in active_indices:
                    src_v = self.vehicles[src_i]
                    src_phys = src_v.source_vehicle_id or src_v.id
                    src_is_unique_phys = phys_route_counts.get(src_phys, 0) <= 1
                    src_op_cost = route_op_cost_cache[src_i]
                    stops = cur_routes[src_i]
                    w = 0.0
                    max_w = 0.0
                    src_orders: List[OrderPair] = []
                    for s in stops:
                        oid = s.allocation_id or s.order_id
                        ord_obj = self.order_by_id.get(oid) if oid else None
                        if ord_obj is not None:
                            if s.stop_type == "PICKUP":
                                w += ord_obj.total_weight_kg
                                src_orders.append(ord_obj)
                            else:
                                w -= ord_obj.total_weight_kg
                            if w > max_w:
                                max_w = w
                    for tgt_i in empty_indices:
                        tgt_v = self.vehicles[tgt_i]
                        tgt_phys = tgt_v.source_vehicle_id or tgt_v.id
                        if max_w > tgt_v.payload_limit_kg + 0.01:
                            continue
                        if tgt_v.service_day_index > max_active_day:
                            continue
                        max_routes = getattr(self.request.policy, "max_routes_per_day", None)
                        if (
                            max_routes is not None
                            and tgt_v.service_day_index != src_v.service_day_index
                            and sum(
                                1
                                for idx, r in enumerate(cur_routes)
                                if r and self.vehicles[idx].service_day_index == tgt_v.service_day_index
                            )
                            >= max_routes
                        ):
                            continue
                        reduces_phys = (
                            src_is_unique_phys
                            and tgt_phys != src_phys
                            and phys_route_counts.get(tgt_phys, 0) >= 1
                        )
                        tgt_op_cost = (
                            tgt_v.fixed_operating_cost_vnd
                            + (tgt_v.fuel_consumption_liters_per_100_km / 100.0)
                            * self._calc_route_distance_km(tgt_i, stops)
                            * self.policy.fuel_price_per_liter_vnd
                        )
                        if not reduces_phys and tgt_op_cost >= src_op_cost - 1_000.0:
                            continue
                        if reduces_phys and tgt_op_cost > src_op_cost + 1_000.0:
                            continue
                        if not self._vehicle_has_compatible_driver(tgt_v) or any(
                            not self._order_allows_vehicle(o, tgt_v) for o in src_orders
                        ):
                            continue
                        shortlisted_moves.append((0 if reduces_phys else 1, tgt_op_cost - src_op_cost, src_i, tgt_i))
                shortlisted_moves.sort(key=lambda item: (item[0], item[1]))
                best_direct = None
                for _, _, src_i, tgt_i in shortlisted_moves[:40]:
                    if deadline is not None and time.perf_counter() >= deadline:
                        break
                    stops = cur_routes[src_i]
                    sched_tgt = self._schedule_stops(tgt_i, stops)
                    if sched_tgt is None or not self._validate_stops_cached(tgt_i, sched_tgt[0]):
                        continue
                    cand_routes = list(cur_routes)
                    cand_routes[src_i] = []
                    cand_routes[tgt_i] = sched_tgt[0]
                    cand_rank = self._rank_candidate_for_audit(cand_routes, cur_unassigned)
                    if cand_rank < cur_rank and (best_direct is None or cand_rank < best_direct[0]):
                        best_direct = (cand_rank, cand_routes)
                        break
                if best_direct is not None:
                    cur_rank, cur_routes = best_direct
                    changed = True
                    step_changed = True
            active = [idx for idx, r in enumerate(cur_routes) if r]
            for idx_a in range(len(active)):
                for idx_b in range(idx_a + 1, len(active)):
                    if deadline is not None and time.perf_counter() >= deadline:
                        break
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
                        step_changed = True
            if not step_changed:
                break
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
            # This search state can represent only one trip per vehicle/day slot.
            # Keep the audited plan when multiple trips share that slot.
            if index is None or routes[index]:
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
        if response.unassigned_orders or not response.routes or time.perf_counter() >= deadline:
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
            max_area = effective_floor_capacity_cm2(vehicle, self.request.demo_stacking)
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

        def audit_improvement(candidate: List[List[ScheduledStop]]) -> FleetOptimizationResponse:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return best
            audited = self._build_final_response(
                candidate, [], include_benchmarks=False,
                spatial_time_budget_seconds=remaining, polish_checkpoint=(deadline, best),
            )
            if audited is best or time.perf_counter() >= deadline:
                return best
            return self._best_audited_response([best, audited])

        try_short_sequences = True
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
            short_sequences = []
            if try_short_sequences:
                try_short_sequences = False
                distances = self.request.distance_matrix_meters
                segments = []
                now = time.perf_counter()
                sequence_deadline = now + min(0.25, max(0.0, (deadline - now) * 0.65))
                for index, nodes in enumerate(node_routes):
                    if time.perf_counter() >= sequence_deadline:
                        break
                    for start in range(len(nodes) - 1):
                        if time.perf_counter() >= sequence_deadline:
                            break
                        first = nodes[start - 1] if start else index
                        previous, length = first, 0.0
                        for stop in range(start, min(start + MAX_RESEQUENCE_STOPS, len(nodes))):
                            length += distances[previous][nodes[stop]]
                            previous = nodes[stop]
                            end = stop + 1
                            if end - start < 2:
                                continue
                            last = nodes[end] if end < len(nodes) else index
                            detour = length + distances[previous][last] - distances[first][last]
                            segments.append((detour, index, start, end, first, last))
                for _, index, start, end, first, last in sorted(segments, reverse=True):
                    if time.perf_counter() >= sequence_deadline:
                        break
                    short_sequences.extend(
                        (delta, (index, start, end, *positions))
                        for delta, positions in ranked_short_route_sequences(
                            node_routes[index][start:end], actions[index][start:end], first,
                            distances, min(sequence_deadline, time.perf_counter() + 0.20),
                            end_node=last,
                        )
                        if not is_single_stop_relocation(positions)
                    )
            now = time.perf_counter()
            generation_budget = max(0.0, (deadline - now) * 0.5)
            stop_moves = ranked_stop_moves(
                node_routes,
                actions,
                list(range(len(routes))), list(range(len(routes))),
                self.request.distance_matrix_meters, now + generation_budget * 0.25,
            )
            pair_moves = ranked_order_moves(
                node_routes, actions, list(range(len(routes))), list(range(len(routes))),
                self.request.distance_matrix_meters, now + generation_budget * 0.80,
            )
            subtrip_moves = ranked_subtrip_moves(
                node_routes, actions, list(range(len(routes))), list(range(len(routes))),
                self.request.distance_matrix_meters, now + generation_budget,
            )
            # Prioritize removing trips, then short-route proposals and local moves.
            # All proposals still compete on the audited production objective.
            moves = sorted(
                [(0, -1, delta, 3, positions) for delta, positions in short_sequences]
                + [(0, 0 if delta < 0 else 2, delta, 0, (vehicle, source, target))
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
                if kind == 3:
                    vehicle_index, start, end, *sequence = positions
                    route = routes[vehicle_index]
                    candidate[vehicle_index] = (
                        route[:start] + [route[start + index] for index in sequence] + route[end:]
                    )
                    changed_indices = (vehicle_index,)
                elif kind == 0:
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
                max_routes = getattr(self.request.policy, "max_routes_per_day", None)
                if max_routes is not None:
                    day_counts: Dict[int, int] = {}
                    for idx, route in enumerate(candidate):
                        if route:
                            day_idx = self.vehicles[idx].service_day_index
                            day_counts[day_idx] = day_counts.get(day_idx, 0) + 1
                    if any(count > max_routes for count in day_counts.values()):
                        continue
                if any(not _route_capacity_and_schedule_ok(index, candidate[index])
                    for index in changed_indices if candidate[index]):
                    continue
                if kind != 3:
                    # A cheap conservative check avoids spending the ranking/audit budget
                    # on moves that cannot load/unload their cargo.
                    prev_layout_search = getattr(self, "_allow_layout_search", True)
                    self._allow_layout_search = False
                    try:
                        spatial_ok = True
                        for index in changed_indices:
                            if not candidate[index]:
                                continue
                            if time.perf_counter() >= deadline:
                                return best
                            if not self._validate_stops_cached(index, candidate[index]):
                                spatial_ok = False
                                break
                    finally:
                        self._allow_layout_search = prev_layout_search
                    if not spatial_ok:
                        continue
                if time.perf_counter() >= deadline:
                    return best
                if self._rank_candidate_for_audit(candidate, []) >= incumbent_key:
                    continue
                audited = audit_improvement(candidate)
                if audited is not best:
                    best = audited
                    improved = True
                    break
            if not improved and time.perf_counter() < deadline:
                exchanged = self._best_order_exchange(routes, [], deadline)
                if exchanged is not None and time.perf_counter() < deadline:
                    _, ex_routes, _, (first_index, second_index) = exchanged
                    reassigned = self._optimize_production_vehicles(ex_routes, [], deadline)
                    if reassigned is not None:
                        ex_routes = reassigned[1]
                    if time.perf_counter() < deadline and self._rank_candidate_for_audit(ex_routes, []) < incumbent_key:
                        audited = audit_improvement(ex_routes)
                        if audited is not best:
                            best = audited
                            improved = True
            if not improved and time.perf_counter() < deadline:
                reassigned = self._optimize_production_vehicles(routes, [], deadline)
                if (reassigned is not None and time.perf_counter() < deadline
                        and self._rank_candidate_for_audit(reassigned[1], []) < incumbent_key):
                    audited = audit_improvement(reassigned[1])
                    if audited is not best:
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
                sequence=stop.sequence if stop.sequence and stop.sequence >= 1 else seq_idx,
                stop_type=stop.stop_type,
                address=stop.location_name,
                latitude=stop.latitude,
                longitude=stop.longitude,
                items_to_load=[
                    self._spatial_cargo_item(item_id)
                    for item_id in stop.items_loaded
                    if item_id in self.cargo_by_id
                ],
                items_to_unload=list(stop.items_unloaded),
            )
            for seq_idx, stop in enumerate(stops, start=1)
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
                    # Layout step states also carry stop identifiers and labels.
                    action.stop_id,
                    action.sequence,
                    action.stop_type,
                    action.address,
                    tuple(
                        (
                            item.id,
                            item.can_rotate,
                            tuple(item.allowed_orientations)
                            if getattr(item, "allowed_orientations", None) is not None
                            else None,
                        )
                        for item in action.items_to_load
                    ),
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

    def _repair_raw_ortools_seed(
        self,
        raw_routes: Sequence[Sequence[ScheduledStop]],
        deadline: float,
    ) -> Tuple[Tuple[int, int, int, int], List[List[ScheduledStop]], List[str]]:
        repaired: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        rejected_orders: List[str] = []
        for v_idx, stops in enumerate(raw_routes):
            if v_idx >= len(repaired) or not stops or time.perf_counter() >= deadline:
                continue
            scheduled = self._schedule_stops(v_idx, list(stops))
            if scheduled is not None:
                scheduled_stops = scheduled[0]
                if self._validate_stops_cached(v_idx, scheduled_stops):
                    repaired[v_idx] = scheduled_stops
                    continue
            fixed = self._repair_spatial_routes(
                [[] if idx != v_idx else list(stops) for idx in range(len(self.vehicles))],
                max(0.08, min(0.25, deadline - time.perf_counter())),
            )
            if fixed[v_idx]:
                repaired[v_idx] = fixed[v_idx]
            else:
                rejected_orders.extend(self._assigned_order_ids([stops]))

        assigned_set = set(self._assigned_order_ids(repaired))
        missing = list(
            dict.fromkeys(
                rejected_orders
                + [order.id for order in self.orders if order.id not in assigned_set]
            )
        )
        if missing and time.perf_counter() < deadline:
            repaired, missing = self._repair_greedy_insert(
                repaired,
                missing,
                start_time=time.perf_counter(),
                deadline=deadline,
                randomize=False,
            )
        for _ in range(3):
            if time.perf_counter() >= deadline:
                break
            elim = self._try_route_elimination(
                repaired, missing, time.perf_counter(), deadline
            )
            if elim is not None:
                _, repaired, missing = elim
                continue
            reassigned = self._production_vehicle_reassignment(repaired, missing)
            if reassigned is not None:
                _, repaired, missing = reassigned
                continue
            break
        return self._candidate_key(repaired, missing), repaired, missing

    def _ordered_seed_orders(self) -> List[OrderPair]:
        """Diversify initial construction order per seed while keeping operational urgency intact."""
        variant = abs(int(getattr(self, "random_seed", 0))) % 5
        grace_sec = self.policy.delivery_grace_days * 86_400
        if variant == 0:
            return sorted(
                self.orders,
                key=lambda o: (
                    o.pickup_window_end_sec // 86_400,
                    min(o.delivery_window_end_sec, o.ordered_at_sec + grace_sec),
                    o.pickup_window_end_sec,
                    o.delivery_window_end_sec,
                    o.ordered_at_sec,
                    o.id,
                ),
            )
        ref_v = self.vehicles[0]
        ref_lat = ref_v.depot.latitude
        ref_lng = ref_v.depot.longitude

        def _urgency_bucket(order: OrderPair) -> Tuple[int, int]:
            return (
                order.pickup_window_end_sec // 86_400,
                min(order.delivery_window_end_sec, order.ordered_at_sec + grace_sec) // 86_400,
            )

        if variant == 1:
            # Ưu tiên đơn xa kho trước trong từng nhóm khẩn ân hạn để dựng khung tuyến đường dài,
            # giúp các đơn gần dọc đường ghép vào trục chính thay vì mở lẻ nhiều xe.
            return sorted(
                self.orders,
                key=lambda o: (
                    *_urgency_bucket(o),
                    -round(
                        math.hypot(
                            o.delivery_location.latitude - ref_lat,
                            o.delivery_location.longitude - ref_lng,
                        ),
                        2,
                    ),
                    o.delivery_window_end_sec,
                    o.id,
                ),
            )
        if variant == 2:
            # Ưu tiên chặng nhận->giao dài và điểm nhận xa kho để gom trục liên vùng trước.
            return sorted(
                self.orders,
                key=lambda o: (
                    *_urgency_bucket(o),
                    -round(
                        math.hypot(
                            o.delivery_location.latitude - o.pickup_location.latitude,
                            o.delivery_location.longitude - o.pickup_location.longitude,
                        )
                        + math.hypot(
                            o.pickup_location.latitude - ref_lat,
                            o.pickup_location.longitude - ref_lng,
                        ),
                        2,
                    ),
                    o.delivery_window_end_sec,
                    o.id,
                ),
            )
        if variant == 3:
            # Gom theo điểm nhận/giao chung nếu nhiều đơn dùng chung hub; nếu mọi điểm đều là UUID riêng,
            # dùng xáo ngẫu nhiên có kiểm soát theo seed để tránh sắp theo thứ tự chữ cái UUID.
            has_shared_hubs = len({o.pickup_location.id for o in self.orders}) < len(self.orders)
            if has_shared_hubs:
                return sorted(
                    self.orders,
                    key=lambda o: (
                        *_urgency_bucket(o),
                        o.pickup_location.id,
                        o.delivery_location.id,
                        o.delivery_window_end_sec,
                        o.id,
                    ),
                )
            return sorted(
                self.orders,
                key=lambda o: (
                    *_urgency_bucket(o),
                    o.delivery_window_end_sec // 3600,
                    self.rng.random(),
                    o.id,
                ),
            )
        return sorted(
            self.orders,
            key=lambda o: (
                *_urgency_bucket(o),
                o.delivery_window_end_sec // 3600,
                self.rng.random(),
                o.id,
            ),
        )

    def _append_delivery_cycles(
        self,
        routes: List[List[ScheduledStop]],
        vehicle_indices: Sequence[int],
        deadline: float,
        *,
        allow_overlap: bool = False,
        orders_override: Optional[Sequence[OrderPair]] = None,
        cross_day_economy: bool = False,
    ) -> List[str]:
        """Construct a seed; prefer active vehicles before opening unused physical trucks."""
        missing = []
        routes_by_day: Dict[int, int] = {}
        used_physical_vehicles: Set[str] = set()
        for idx, route in enumerate(routes):
            if route:
                day_idx = self.vehicles[idx].service_day_index
                routes_by_day[day_idx] = routes_by_day.get(day_idx, 0) + 1
                used_physical_vehicles.add(self.vehicles[idx].source_vehicle_id or self.vehicles[idx].id)
        route_limit = self.request.policy.max_routes_per_day
        started = time.perf_counter()
        overlap_deadline = started + max(0.0, (deadline - started) * 0.78)
        orders = list(orders_override) if orders_override is not None else self._ordered_seed_orders()
        vehicles_by_day: Dict[int, List[int]] = {}
        for idx in vehicle_indices:
            vehicles_by_day.setdefault(self.vehicles[idx].service_day_index, []).append(idx)
        sorted_days = sorted(vehicles_by_day)
        min_fleet_fuel = min(
            (self.vehicles[idx].fuel_consumption_liters_per_100_km for idx in vehicle_indices),
            default=0.0,
        )
        day_window_bounds = {
            day: (
                min(self.vehicles[idx].available_start_sec for idx in day_idxs),
                max(self.vehicles[idx].available_end_sec for idx in day_idxs),
            )
            for day, day_idxs in vehicles_by_day.items()
        }
        single_order_fit_cache: Dict[Tuple[str, Tuple[Any, ...]], bool] = {}

        for position, order in enumerate(orders):
            if time.perf_counter() >= deadline:
                missing.extend(o.id for o in orders[position:])
                break
            pickup_index, _ = self.order_node_indices[order.id]
            use_overlap = allow_overlap and time.perf_counter() < overlap_deadline

            def day_priority(index: int) -> Tuple:
                route = routes[index]
                origin = self.order_node_indices[route[-1].allocation_id][1] if route else index
                vehicle = self.vehicles[index]
                phys_id = vehicle.source_vehicle_id or vehicle.id
                min_stop_dur = self.request.duration_matrix_seconds[origin][pickup_index]
                if use_overlap and route:
                    for st in route[-4:]:
                        oid = st.allocation_id or st.order_id
                        if oid and oid in self.order_node_indices:
                            p_node, d_node = self.order_node_indices[oid]
                            node = p_node if st.stop_type == "PICKUP" else d_node
                            min_stop_dur = min(
                                min_stop_dur,
                                self.request.duration_matrix_seconds[node][pickup_index],
                            )
                empty_cost = (
                    vehicle.fixed_operating_cost_vnd
                    + round(
                        vehicle.fuel_consumption_liters_per_100_km
                        * self.policy.fuel_price_per_liter_vnd
                        * 0.25
                    )
                )
                return (
                    not route,
                    0 if (route or phys_id in used_physical_vehicles) else 1,
                    min_stop_dur if route else round(min_stop_dur / 120.0) * 120.0,
                    0 if route else empty_cost,
                    -vehicle.width_cm * vehicle.length_cm,
                )

            assigned = False
            deferred_empty_candidates: List[Tuple[int, float, int]] = []
            first_day = sorted_days[0] if sorted_days else 0
            cheap_fuel_cutoff = min_fleet_fuel * 1.25 if min_fleet_fuel > 0 else float("inf")
            for day in sorted_days:
                if time.perf_counter() >= deadline or assigned:
                    break
                min_start, max_end = day_window_bounds[day]
                if order.pickup_window_end_sec < min_start or order.delivery_window_start_sec > max_end:
                    continue
                if (
                    cross_day_economy
                    and len(sorted_days) > 1
                    and day > first_day + 1
                    and not any(routes[idx] for idx in vehicles_by_day[day])
                ):
                    # Defer escalation to Day 2+ unless Day 0..Day 1 options cannot absorb this order.
                    for idx in vehicles_by_day[day]:
                        if not routes[idx] and (route_limit is None or routes_by_day.get(day, 0) < route_limit):
                            v_d = self.vehicles[idx]
                            deferred_empty_candidates.append(
                                (day, v_d.fixed_operating_cost_vnd + v_d.fuel_consumption_liters_per_100_km * 1_000.0, idx)
                            )
                    continue

                ranked_day = sorted(vehicles_by_day[day], key=day_priority)
                if not use_overlap:
                    spatially_checked: Set[Tuple[Any, ...]] = set()
                    for idx in ranked_day:
                        if time.perf_counter() >= deadline:
                            break
                        route = routes[idx]
                        if not route and route_limit is not None and routes_by_day.get(day, 0) >= route_limit:
                            continue
                        ok, stops = self._can_insert_order(idx, route, order, len(route), len(route) + 1, check_packing=False)
                        if not ok:
                            continue
                        if self._single_order_fits_vehicle_floor(
                            idx, order.id, stops[-2:], deadline, spatially_checked, fit_cache=single_order_fit_cache,
                        ):
                            if not route:
                                routes_by_day[day] = routes_by_day.get(day, 0) + 1
                                used_physical_vehicles.add(self.vehicles[idx].source_vehicle_id or self.vehicles[idx].id)
                            routes[idx] = stops
                            assigned = True
                            break
                    continue

                active_candidates: List[Tuple[int, float, int, int, int, int]] = []
                sequential_candidates: List[Tuple[int, float, int, int]] = []
                empty_candidates: List[int] = []
                active_checked = 0
                for idx in ranked_day:
                    route = routes[idx]
                    v = self.vehicles[idx]
                    if not route:
                        if route_limit is None or routes_by_day.get(day, 0) < route_limit:
                            empty_candidates.append(idx)
                        continue
                    if not self._order_allows_vehicle(order, v) or not self._vehicle_has_compatible_driver(v):
                        continue
                    fuel_per_km = (
                        v.fuel_consumption_liters_per_100_km
                        / 100.0
                        * self.policy.fuel_price_per_liter_vnd
                    )
                    seq_delta = self._estimate_insertion_delta_km(idx, route, order, len(route), len(route) + 1)
                    seq_cost = round(seq_delta * (fuel_per_km + 1_200.0))
                    sequential_candidates.append((seq_cost, seq_delta, -len(route), idx))
                    if active_checked >= 24:
                        continue
                    active_checked += 1
                    last_pickup = max((i for i, s in enumerate(route) if s.stop_type == "PICKUP"), default=0)
                    tail_options: List[Tuple[int, int]] = []
                    max_d = len(route) + 1
                    for p_pos in (last_pickup + 1, last_pickup, len(route)):
                        if not (0 <= p_pos <= len(route)):
                            continue
                        for d_pos in (p_pos + 1, max_d - 1, max_d):
                            if (p_pos, d_pos) == (len(route), max_d):
                                continue
                            if p_pos + 1 <= d_pos <= max_d and (p_pos, d_pos) not in tail_options:
                                tail_options.append((p_pos, d_pos))
                    for p_pos, d_pos in tail_options:
                        delta_dist = self._estimate_insertion_delta_km(idx, route, order, p_pos, d_pos)
                        delta_cost = round(delta_dist * (fuel_per_km + 1_200.0))
                        active_candidates.append((delta_cost, delta_dist, -len(route), idx, p_pos, d_pos))

                active_candidates.sort(key=lambda item: (item[0], item[1], item[2]))
                spatial_checks = 0
                for _, _, _, idx, p_pos, d_pos in active_candidates[:16]:
                    if time.perf_counter() >= deadline or spatial_checks >= 4:
                        break
                    ok, stops = self._can_insert_order(idx, routes[idx], order, p_pos, d_pos, check_packing=False)
                    if not ok:
                        continue
                    segment = self._extract_active_cycle(stops, p_pos)
                    if not self._segment_fits_floor_bound(idx, segment):
                        continue
                    scheduled = self._schedule_stops(idx, stops)
                    if scheduled is None:
                        continue
                    sched_stops = scheduled[0]
                    spatial_checks += 1
                    if len(segment) <= 2:
                        if self._single_order_fits_vehicle_floor(
                            idx, order.id, segment, deadline, set(), fit_cache=single_order_fit_cache,
                        ):
                            routes[idx] = sched_stops
                            assigned = True
                            break
                    elif self._validate_stops_cached(idx, segment):
                        routes[idx] = sched_stops
                        assigned = True
                        break

                if not assigned and sequential_candidates:
                    seq_spatially_checked: Set[Tuple[Any, ...]] = set()
                    for _, _, _, idx in sorted(sequential_candidates):
                        if time.perf_counter() >= deadline:
                            break
                        route = routes[idx]
                        ok, stops = self._can_insert_order(
                            idx, route, order, len(route), len(route) + 1, check_packing=False,
                        )
                        if not ok:
                            continue
                        if self._single_order_fits_vehicle_floor(
                            idx, order.id, stops[-2:], deadline, seq_spatially_checked, fit_cache=single_order_fit_cache,
                        ):
                            routes[idx] = stops
                            assigned = True
                            break

                if not assigned:
                    spatially_checked = set()
                    for idx in empty_candidates:
                        if time.perf_counter() >= deadline:
                            break
                        v_emp = self.vehicles[idx]
                        phys_emp = v_emp.source_vehicle_id or v_emp.id
                        if (
                            cross_day_economy
                            and len(sorted_days) > 1
                            and v_emp.fuel_consumption_liters_per_100_km > cheap_fuel_cutoff
                            and phys_emp not in used_physical_vehicles
                        ):
                            deferred_empty_candidates.append(
                                (
                                    first_day + 1 if day == first_day else day,
                                    v_emp.fixed_operating_cost_vnd + v_emp.fuel_consumption_liters_per_100_km * 1_000.0,
                                    idx,
                                )
                            )
                            continue
                        ok, stops = self._can_insert_order(idx, routes[idx], order, 0, 1, check_packing=False)
                        if not ok:
                            continue
                        if self._single_order_fits_vehicle_floor(
                            idx, order.id, stops[-2:], deadline, spatially_checked, fit_cache=single_order_fit_cache,
                        ):
                            routes_by_day[day] = routes_by_day.get(day, 0) + 1
                            used_physical_vehicles.add(phys_emp)
                            routes[idx] = stops
                            assigned = True
                            break
            if not assigned and deferred_empty_candidates:
                deferred_empty_candidates.sort(key=lambda item: (item[0], item[1]))
                spatially_checked = set()
                for _, _, idx in deferred_empty_candidates:
                    if time.perf_counter() >= deadline:
                        break
                    d_idx = self.vehicles[idx].service_day_index
                    if route_limit is not None and routes_by_day.get(d_idx, 0) >= route_limit:
                        continue
                    ok, stops = self._can_insert_order(idx, routes[idx], order, 0, 1, check_packing=False)
                    if not ok:
                        continue
                    if self._single_order_fits_vehicle_floor(
                        idx, order.id, stops[-2:], deadline, spatially_checked, fit_cache=single_order_fit_cache,
                    ):
                        routes_by_day[d_idx] = routes_by_day.get(d_idx, 0) + 1
                        used_physical_vehicles.add(self.vehicles[idx].source_vehicle_id or self.vehicles[idx].id)
                        routes[idx] = stops
                        assigned = True
                        break
            if not assigned:
                missing.append(order.id)
        return missing

    def _estimate_insertion_delta_km(
        self,
        vehicle_index: int,
        route: List[ScheduledStop],
        order: OrderPair,
        p_pos: int,
        d_pos: int,
    ) -> float:
        """Compute O(1) distance delta (km) for inserting ``order`` at (p_pos, d_pos)."""
        dist_m = self.request.distance_matrix_meters
        p_node, d_node = self.order_node_indices[order.id]
        depot_node = vehicle_index

        def _node(stop: ScheduledStop) -> int:
            oid = stop.allocation_id or stop.order_id or ""
            pn, dn = self.order_node_indices[oid]
            return pn if stop.stop_type == "PICKUP" else dn

        prev_p = depot_node if p_pos == 0 else _node(route[p_pos - 1])
        next_p = depot_node if p_pos >= len(route) else _node(route[p_pos])
        if d_pos == p_pos + 1:
            delta_m = (
                dist_m[prev_p][p_node]
                + dist_m[p_node][d_node]
                + dist_m[d_node][next_p]
                - dist_m[prev_p][next_p]
            )
        else:
            d_orig_idx = d_pos - 1
            prev_d = _node(route[d_orig_idx - 1])
            next_d = depot_node if d_orig_idx >= len(route) else _node(route[d_orig_idx])
            delta_m = (
                dist_m[prev_p][p_node]
                + dist_m[p_node][next_p]
                - dist_m[prev_p][next_p]
                + dist_m[prev_d][d_node]
                + dist_m[d_node][next_d]
                - dist_m[prev_d][next_d]
            )
        return delta_m / 1000.0

    @staticmethod
    def _extract_active_cycle(stops: List[ScheduledStop], anchor_idx: int) -> List[ScheduledStop]:
        """Return the empty-to-empty cargo cycle containing ``anchor_idx``."""
        onboard: set[str] = set()
        cycle_start = 0
        for i, stop in enumerate(stops):
            oid = stop.allocation_id or stop.order_id or ""
            if stop.stop_type == "PICKUP":
                onboard.add(oid)
            else:
                onboard.discard(oid)
            if not onboard:
                if i >= anchor_idx:
                    return stops[cycle_start : i + 1]
                cycle_start = i + 1
        return stops[cycle_start:]

    def _segment_fits_floor_bound(self, vehicle_index: int, segment: List[ScheduledStop]) -> bool:
        """Fast necessary check on floor area, weight, and 3D volume across an active cargo cycle."""
        vehicle = self.vehicles[vehicle_index]
        max_area = effective_floor_capacity_cm2(vehicle, self.request.demo_stacking)
        max_volume_cm3 = vehicle.length_cm * vehicle.width_cm * vehicle.height_cm
        current_area = 0.0
        current_weight = 0.0
        current_volume = 0.0
        for stop in segment:
            oid = stop.allocation_id or stop.order_id or ""
            order = self.order_by_id.get(oid)
            if order is None:
                continue
            order_area = sum(item.length_cm * item.width_cm for item in order.items)
            order_weight = sum(item.weight_kg for item in order.items)
            order_volume = sum(item.length_cm * item.width_cm * item.height_cm for item in order.items)
            if stop.stop_type == "PICKUP":
                current_area += order_area
                current_weight += order_weight
                current_volume += order_volume
                if (
                    current_area > max_area + 1.0
                    or current_weight > vehicle.payload_limit_kg + 1e-6
                    or current_volume > max_volume_cm3 * 0.95
                ):
                    return False
            else:
                current_area = max(0.0, current_area - order_area)
                current_weight = max(0.0, current_weight - order_weight)
                current_volume = max(0.0, current_volume - order_volume)
        return True

    def _consolidate_delivery_cycles(
        self, routes: List[List[ScheduledStop]], unassigned: List[str], deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Move later pickups ahead of deliveries when the audited plan improves."""
        best = list(routes)
        best_rank = self._rank_candidate_for_audit(best, unassigned)
        pass_index = 0
        while time.perf_counter() < deadline:
            improved_any = False
            pass_index += 1
            active_indices = [idx for idx, rt in enumerate(best) if len(rt) >= 4]
            for pos_in_pass, index in enumerate(active_indices):
                route = best[index]
                remaining_total = deadline - time.perf_counter()
                if remaining_total <= 0:
                    return best
                routes_left = max(1, len(active_indices) - pos_in_pass)
                route_deadline = min(deadline, time.perf_counter() + max(0.12, remaining_total / routes_left))
                pickups_to_try = sorted(
                    [stop for stop in list(route) if stop.stop_type == "PICKUP"],
                    key=lambda st: len(self.order_by_id[st.allocation_id or st.order_id].items),
                )
                for pickup in pickups_to_try:
                    if time.perf_counter() >= route_deadline:
                        break
                    position = next(
                        (i for i, stop in enumerate(route)
                         if stop.stop_type == "PICKUP" and (stop.allocation_id or stop.order_id) == (pickup.allocation_id or pickup.order_id)),
                        0,
                    )
                    if position == 0:
                        continue
                    # Prefer collecting at a pickup already on the route. Pass 1 tries only
                    # the immediately preceding pickup across all routes so every route merges fast.
                    preceding = [i for i in range(position) if route[i].stop_type == "PICKUP"]
                    anchors = preceding[-2:] if pass_index == 1 else list(reversed(preceding))
                    for anchor in anchors:
                        previous_route = route
                        if time.perf_counter() >= route_deadline:
                            break
                        order = self.order_by_id[pickup.allocation_id or pickup.order_id]
                        reduced = [stop for stop in route if (stop.allocation_id or stop.order_id) != order.id]
                        delivery_index = next(i for i, stop in enumerate(route)
                            if stop.stop_type == "DELIVERY" and (stop.allocation_id or stop.order_id) == order.id)
                        first_delivery = next((i for i in range(anchor + 1, len(reduced))
                            if reduced[i].stop_type == "DELIVERY"), len(reduced))
                        # In _can_insert_order, p_pos+1 <= d_pos <= len(reduced)+1:
                        # first_delivery+1 places D right before D_first (LIFO), first_delivery+2 right after (FIFO).
                        max_d = len(reduced) + 1
                        options: List[Tuple[int, int]] = []
                        for p_cand in (anchor + 1, anchor):
                            if not (0 <= p_cand <= len(reduced)):
                                continue
                            for d_cand in (first_delivery + 1, first_delivery + 2, p_cand + 1, min(max_d, delivery_index + 1)):
                                if p_cand + 1 <= d_cand <= max_d and (p_cand, d_cand) not in options:
                                    options.append((p_cand, d_cand))
                        for p_pos, d_pos in options:
                            if time.perf_counter() >= route_deadline:
                                break
                            ok, candidate = self._can_insert_order(index, reduced, order, p_pos, d_pos, check_packing=False)
                            if not ok or self._calc_route_distance_km(index, candidate) >= self._calc_route_distance_km(index, route) - 0.001:
                                continue
                            scheduled = self._schedule_stops(index, candidate)
                            if scheduled is None:
                                continue
                            candidate = scheduled[0]
                            segment = self._extract_active_cycle(candidate, p_pos)
                            if not self._segment_fits_floor_bound(index, segment):
                                continue
                            valid_seg = self._validate_stops_cached(index, segment)
                            if not valid_seg and len(segment) <= 6 and route_deadline - time.perf_counter() > 0.12:
                                valid_seg = self._validate_exact_route(
                                    index, segment, min(0.08, route_deadline - time.perf_counter())
                                )
                            if valid_seg:
                                proposed = list(best)
                                proposed[index] = candidate
                                rank = self._rank_candidate_for_audit(proposed, unassigned)
                                if rank < best_rank:
                                    best, best_rank, route = proposed, rank, candidate
                                    improved_any = True
                                    break
                        if route is not previous_route:
                            break
            if not improved_any and pass_index >= 2:
                break
        return best

    def _consolidate_across_routes(
        self, routes: List[List[ScheduledStop]], unassigned: List[str], deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Move orders onto nearby corridor trucks to overlap loads and cut route count."""
        best = list(routes)
        best_rank = self._rank_candidate_for_audit(best, unassigned)
        dist_m = self.request.distance_matrix_meters

        def _stop_node(stop: ScheduledStop) -> Optional[int]:
            oid = stop.allocation_id or stop.order_id
            if not oid or oid not in self.order_node_indices:
                return None
            p_node, d_node = self.order_node_indices[oid]
            return p_node if stop.stop_type == "PICKUP" else d_node

        pass_count = 0
        while time.perf_counter() < deadline and pass_count < 4:
            pass_count += 1
            improved_any = False
            route_orders_list = [
                list(dict.fromkeys((s.allocation_id or s.order_id) for s in rt if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id)))
                for rt in best
            ]
            # Prioritize emptying smaller routes first, then heavy distance-saving swaps.
            src_indices = sorted(
                (i for i, rt in enumerate(best) if rt),
                key=lambda i: (len(route_orders_list[i]), -self._calc_route_distance_km(i, best[i])),
            )
            for src_idx in src_indices:
                if time.perf_counter() >= deadline:
                    return best
                src_route = best[src_idx]
                if not src_route:
                    continue
                src_orders = [
                    oid for oid in dict.fromkeys(
                        (s.allocation_id or s.order_id)
                        for s in src_route
                        if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id)
                    )
                ]
                for oid in src_orders:
                    if time.perf_counter() >= deadline:
                        return best
                    src_route = best[src_idx]
                    if not any((s.allocation_id or s.order_id) == oid for s in src_route):
                        continue
                    order = self.order_by_id[oid]
                    p_node, d_node = self.order_node_indices[oid]
                    reduced_src = [s for s in src_route if (s.allocation_id or s.order_id) != oid]
                    empties_src = len(reduced_src) == 0
                    if not empties_src:
                        sched_src = self._schedule_stops(src_idx, reduced_src)
                        if sched_src is None or not self._validate_stops_cached(src_idx, sched_src[0]):
                            continue
                        reduced_src_sched = sched_src[0]
                        src_save_km = (
                            self._calc_route_distance_km(src_idx, src_route)
                            - self._calc_route_distance_km(src_idx, reduced_src_sched)
                        )
                    else:
                        reduced_src_sched = []
                        src_save_km = self._calc_route_distance_km(src_idx, src_route)

                    src_day = self.vehicles[src_idx].service_day_index
                    tgt_scores: List[Tuple[int, float, int]] = []
                    for tgt_idx, tgt_rt in enumerate(best):
                        if not tgt_rt or tgt_idx == src_idx:
                            continue
                        tgt_v = self.vehicles[tgt_idx]
                        if not empties_src and tgt_v.service_day_index > src_day:
                            continue
                        if not self._order_allows_vehicle(order, tgt_v) or not self._vehicle_has_compatible_driver(tgt_v):
                            continue
                        min_p = float("inf")
                        min_d = float("inf")
                        for s in tgt_rt:
                            nd = _stop_node(s)
                            if nd is not None:
                                mp = float(dist_m[nd][p_node])
                                md = float(dist_m[nd][d_node])
                                if mp < min_p:
                                    min_p = mp
                                if md < min_d:
                                    min_d = md
                        tgt_scores.append((max(0, tgt_v.service_day_index - src_day), min_p + min_d, tgt_idx))
                    tgt_scores.sort(key=lambda item: (item[0], item[1]))

                    moved = False
                    for _, _, tgt_idx in tgt_scores[:8]:
                        if time.perf_counter() >= deadline:
                            return best
                        tgt_rt = best[tgt_idx]
                        node_pairs_p = []
                        node_pairs_d = []
                        for pos, s in enumerate(tgt_rt):
                            nd = _stop_node(s)
                            if nd is not None:
                                node_pairs_p.append((float(dist_m[nd][p_node]), pos))
                                node_pairs_d.append((float(dist_m[nd][d_node]), pos))
                        node_pairs_p.sort()
                        node_pairs_d.sort()
                        p_cands: List[int] = []
                        for _, pos in node_pairs_p[:3]:
                            for off in (pos, pos + 1):
                                if 0 <= off <= len(tgt_rt) and off not in p_cands:
                                    p_cands.append(off)
                        if len(tgt_rt) not in p_cands:
                            p_cands.append(len(tgt_rt))
                        d_anchors = [pos for _, pos in node_pairs_d[:3]]

                        raw_trials: List[Tuple[float, int, int]] = []
                        max_d = len(tgt_rt) + 1
                        max_allowed_added_km = src_save_km + (8.0 if empties_src else -0.01)
                        for p_pos in p_cands[:6]:
                            next_deliv = next((i for i in range(p_pos, len(tgt_rt)) if tgt_rt[i].stop_type == "DELIVERY"), len(tgt_rt))
                            d_cands: List[int] = []
                            raw_ds = [p_pos + 1, next_deliv + 1, next_deliv + 2, max_d] + [a + 1 for a in d_anchors] + [a + 2 for a in d_anchors]
                            for d_pos in raw_ds:
                                if p_pos + 1 <= d_pos <= max_d and d_pos not in d_cands:
                                    d_cands.append(d_pos)
                            for d_pos in d_cands[:6]:
                                added_km = self._estimate_insertion_delta_km(tgt_idx, tgt_rt, order, p_pos, d_pos)
                                if added_km >= max_allowed_added_km:
                                    continue
                                raw_trials.append((added_km, p_pos, d_pos))
                        raw_trials.sort(key=lambda item: item[0])
                        for _, p_pos, d_pos in raw_trials[:4]:
                            if time.perf_counter() >= deadline:
                                return best
                            ok, cand_tgt = self._can_insert_order(tgt_idx, tgt_rt, order, p_pos, d_pos, check_packing=False)
                            if not ok:
                                continue
                            sched_tgt = self._schedule_stops(tgt_idx, cand_tgt)
                            if sched_tgt is None:
                                continue
                            cand_sched = sched_tgt[0]
                            segment = self._extract_active_cycle(cand_sched, p_pos)
                            if not self._segment_fits_floor_bound(tgt_idx, segment) or not self._validate_stops_cached(tgt_idx, segment):
                                continue
                            proposed = list(best)
                            proposed[src_idx] = reduced_src_sched
                            proposed[tgt_idx] = cand_sched
                            rank = self._rank_candidate_for_audit(proposed, unassigned)
                            if rank < best_rank:
                                best = proposed
                                best_rank = rank
                                improved_any = True
                                moved = True
                                break
                        if moved:
                            break
            if not improved_any:
                break
        return best

    def _compress_service_days(
        self, routes: List[List[ScheduledStop]], unassigned: List[str], deadline: float,
    ) -> List[List[ScheduledStop]]:
        """Dồn các chuyến từ ngày muộn nhất về các ngày sớm hơn bằng chính năng lực xe thực."""
        best = [list(rt) for rt in routes]
        route_limit = self.request.policy.max_routes_per_day
        while time.perf_counter() < deadline:
            active_days = sorted({
                self.vehicles[idx].service_day_index
                for idx, rt in enumerate(best)
                if rt
            })
            if len(active_days) <= 1:
                break
            latest_day = active_days[-1]
            min_day = active_days[0]
            if latest_day <= min_day:
                break

            trial = [list(rt) for rt in best]
            routes_by_day: Dict[int, int] = {}
            for idx, rt in enumerate(trial):
                if rt:
                    d = self.vehicles[idx].service_day_index
                    routes_by_day[d] = routes_by_day.get(d, 0) + 1

            late_indices = sorted(
                (i for i, rt in enumerate(trial) if rt and self.vehicles[i].service_day_index == latest_day),
                key=lambda i: len({s.order_id for s in trial[i] if s.order_id}),
            )

            # 1) Thử dời nguyên cả chuyến sang xe trống ở ngày sớm hơn trước.
            for src_idx in late_indices:
                if time.perf_counter() >= deadline:
                    break
                src_rt = trial[src_idx]
                src_v = self.vehicles[src_idx]
                src_orders = [
                    self.order_by_id[oid]
                    for oid in dict.fromkeys(
                        (s.allocation_id or s.order_id)
                        for s in src_rt
                        if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id) in self.order_by_id
                    )
                ]
                for tgt_idx, tgt_rt in enumerate(trial):
                    if tgt_rt:
                        continue
                    tgt_v = self.vehicles[tgt_idx]
                    if tgt_v.service_day_index >= latest_day:
                        continue
                    if route_limit is not None and routes_by_day.get(tgt_v.service_day_index, 0) >= route_limit:
                        continue
                    if (
                        tgt_v.payload_limit_kg + 1e-6 < src_v.payload_limit_kg
                        or tgt_v.length_cm < src_v.length_cm
                        or tgt_v.width_cm < src_v.width_cm
                        or tgt_v.height_cm < src_v.height_cm
                    ):
                        # Nếu khác kích thước/tải thì vẫn cho phép nếu đơn vừa xe mới; kiểm tra compatibility bên dưới.
                        pass
                    if not self._vehicle_has_compatible_driver(tgt_v):
                        continue
                    if any(not self._order_allows_vehicle(o, tgt_v) for o in src_orders):
                        continue
                    sched_whole = self._schedule_stops(tgt_idx, src_rt)
                    if sched_whole is None:
                        continue
                    if self._segment_fits_floor_bound(tgt_idx, sched_whole[0]) and self._validate_stops_cached(tgt_idx, sched_whole[0]):
                        trial[tgt_idx] = sched_whole[0]
                        trial[src_idx] = []
                        routes_by_day[tgt_v.service_day_index] = routes_by_day.get(tgt_v.service_day_index, 0) + 1
                        routes_by_day[latest_day] = max(0, routes_by_day.get(latest_day, 1) - 1)
                        break

            # 2) Với các chuyến còn lại ở ngày muộn nhất, dời từng đơn vào xe đang chạy hoặc xe trống ở ngày sớm hơn.
            remaining_late = [
                i for i in late_indices if trial[i]
            ]
            for src_idx in remaining_late:
                if time.perf_counter() >= deadline or not trial[src_idx]:
                    break
                src_orders = list(dict.fromkeys(
                    (s.allocation_id or s.order_id)
                    for s in trial[src_idx]
                    if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id) in self.order_by_id
                ))
                for oid in src_orders:
                    if time.perf_counter() >= deadline:
                        break
                    order = self.order_by_id[oid]
                    p_node, d_node = self.order_node_indices[oid]
                    dist_m = self.request.distance_matrix_meters
                    moved = False

                    active_early = sorted(
                        (
                            i for i, rt in enumerate(trial)
                            if rt and self.vehicles[i].service_day_index < latest_day
                            and self._order_allows_vehicle(order, self.vehicles[i])
                            and self._vehicle_has_compatible_driver(self.vehicles[i])
                        ),
                        key=lambda i: (
                            self.vehicles[i].service_day_index,
                            min(
                                (
                                    float(dist_m[self.order_node_indices[s.allocation_id or s.order_id][0 if s.stop_type == "PICKUP" else 1]][p_node])
                                    for s in trial[i]
                                    if (s.allocation_id or s.order_id) in self.order_node_indices
                                ),
                                default=float("inf"),
                            ),
                        ),
                    )
                    for tgt_idx in active_early[:12]:
                        if time.perf_counter() >= deadline:
                            break
                        tgt_rt = trial[tgt_idx]
                        last_p = max((i for i, s in enumerate(tgt_rt) if s.stop_type == "PICKUP"), default=0)
                        cands: List[Tuple[float, int, int]] = []
                        max_d = len(tgt_rt) + 1
                        for p_pos in dict.fromkeys([last_p, last_p + 1, len(tgt_rt), 0]):
                            if not (0 <= p_pos <= len(tgt_rt)):
                                continue
                            next_d = next((i for i in range(p_pos, len(tgt_rt)) if tgt_rt[i].stop_type == "DELIVERY"), len(tgt_rt))
                            for d_pos in dict.fromkeys([p_pos + 1, next_d + 1, next_d + 2, max_d]):
                                if p_pos + 1 <= d_pos <= max_d:
                                    cands.append((self._estimate_insertion_delta_km(tgt_idx, tgt_rt, order, p_pos, d_pos), p_pos, d_pos))
                        cands.sort()
                        for _, p_pos, d_pos in cands[:4]:
                            ok, cand = self._can_insert_order(tgt_idx, tgt_rt, order, p_pos, d_pos, check_packing=False)
                            if not ok:
                                continue
                            sched = self._schedule_stops(tgt_idx, cand)
                            if sched is None:
                                continue
                            seg = self._extract_active_cycle(sched[0], p_pos)
                            if self._segment_fits_floor_bound(tgt_idx, seg) and self._validate_stops_cached(tgt_idx, seg):
                                trial[tgt_idx] = sched[0]
                                trial[src_idx] = [s for s in trial[src_idx] if (s.allocation_id or s.order_id) != oid]
                                moved = True
                                break
                        if moved:
                            break

                    if not moved:
                        empty_early = sorted(
                            (
                                i for i, rt in enumerate(trial)
                                if not rt and self.vehicles[i].service_day_index < latest_day
                                and self._order_allows_vehicle(order, self.vehicles[i])
                                and self._vehicle_has_compatible_driver(self.vehicles[i])
                                and (route_limit is None or routes_by_day.get(self.vehicles[i].service_day_index, 0) < route_limit)
                            ),
                            key=lambda i: (self.vehicles[i].service_day_index, -self.vehicles[i].payload_limit_kg),
                        )
                        for tgt_idx in empty_early[:6]:
                            ok, cand = self._can_insert_order(tgt_idx, [], order, 0, 1, check_packing=False)
                            if not ok:
                                continue
                            sched = self._schedule_stops(tgt_idx, cand)
                            if sched is None:
                                continue
                            if self._single_order_fits_vehicle_floor(tgt_idx, oid, sched[0], deadline, set()):
                                d = self.vehicles[tgt_idx].service_day_index
                                trial[tgt_idx] = sched[0]
                                trial[src_idx] = [s for s in trial[src_idx] if (s.allocation_id or s.order_id) != oid]
                                routes_by_day[d] = routes_by_day.get(d, 0) + 1
                                moved = True
                                break

            still_uses_latest = any(
                trial[i] and self.vehicles[i].service_day_index == latest_day
                for i in range(len(trial))
            )
            if still_uses_latest:
                break
            best = trial
        return best

    def refine_direct_span(
        self,
        checkpoint: FleetOptimizationResponse,
        audited_direct_trips: Dict[str, List[OptimizedRoute]],
        deadline: float,
    ) -> FleetOptimizationResponse:
        """Overlap loads and consolidate across routes within the target day span."""
        routes = self._routes_from_audited_response(checkpoint)
        remaining = deadline - time.perf_counter()
        if routes is None or remaining <= 0.05:
            return checkpoint

        verification_reserve = (
            min(remaining * 0.45, max(1.8, len(routes) * 0.14))
            if remaining > 1.8
            else remaining * 0.35
        )
        work_deadline = deadline - verification_reserve
        now = time.perf_counter()
        merged = self._consolidate_delivery_cycles(
            routes, [], now + max(0.0, (work_deadline - now) * 0.42),
        )
        now2 = time.perf_counter()
        if now2 < work_deadline:
            merged = self._consolidate_across_routes(
                merged, [], now2 + max(0.0, (work_deadline - now2) * 0.80),
            )
            now3 = time.perf_counter()
            if now3 + 0.1 < work_deadline:
                merged = self._consolidate_delivery_cycles(merged, [], work_deadline)

        changed = [idx for idx, route in enumerate(merged) if route != routes[idx]]
        if not changed:
            return checkpoint

        # Group changed routes into connected components sharing any order_id so rolling back
        # a failed multi-route move never loses or duplicates orders while keeping other wins.
        def _route_order_set(stops: List[ScheduledStop]) -> Set[str]:
            return {
                (s.allocation_id or s.order_id or "")
                for s in stops
                if s.stop_type == "PICKUP" and (s.allocation_id or s.order_id)
            }

        changed_orders = {
            idx: (_route_order_set(routes[idx]) | _route_order_set(merged[idx]))
            for idx in changed
        }
        visited_changed: Set[int] = set()
        components: List[List[int]] = []
        for start in changed:
            if start in visited_changed:
                continue
            comp = []
            stack = [start]
            visited_changed.add(start)
            while stack:
                cur = stack.pop()
                comp.append(cur)
                for other in changed:
                    if other not in visited_changed and (changed_orders[cur] & changed_orders[other]):
                        visited_changed.add(other)
                        stack.append(other)
            components.append(comp)

        verified_routes = list(routes)
        now_v = time.perf_counter()
        nonempty_changed = [idx for idx in changed if merged[idx]]
        verification_deadline = max(now_v, now_v + max(0.0, (deadline - now_v) * 0.72))
        failed_indices: Set[int] = set()
        for offset, index in enumerate(nonempty_changed):
            rem_v = verification_deadline - time.perf_counter()
            if rem_v <= 0:
                failed_indices.update(nonempty_changed[offset:])
                break
            route_budget = min(1.5, max(0.05, rem_v / max(1, len(nonempty_changed) - offset)))
            if not self._validate_exact_route(index, merged[index], route_budget):
                failed_indices.add(index)

        for comp in components:
            if not (set(comp) & failed_indices):
                for idx in comp:
                    verified_routes[idx] = merged[idx]

        if verified_routes == routes:
            return checkpoint

        trial = self._build_final_response(
            verified_routes, [], include_benchmarks=False,
            audited_direct_trips=audited_direct_trips,
            spatial_time_budget_seconds=max(0.5, deadline - time.perf_counter()),
            polish_checkpoint=(max(deadline, time.perf_counter() + 1.0), checkpoint),
        )
        if trial.status != "SUCCESS" or trial.unassigned_orders:
            return checkpoint
        best = self._best_audited_response([checkpoint, trial])
        if best is trial or trial.total_distance_km < checkpoint.total_distance_km - 0.01:
            return trial if best is trial else checkpoint
        return checkpoint

    def _build_hybrid_initial_solution(
        self,
        vehicles: Sequence[HybridVehicle],
        drivers: Sequence[HybridDriver],
        original_vehicle_indices: Sequence[int],
        pickup_key_by_order: Dict[str, str],
        delivery_key_by_order: Dict[str, str],
        search_deadline: Optional[float] = None,
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
            hard_search_deadline = (
                search_deadline
                if search_deadline is not None
                else t_start + max(1.0, self.time_limit_sec)
            )
            old_layout_search = getattr(self, "_allow_layout_search", False)
            old_ranked_repair = self._use_ranked_repair
            old_seed_deadline = self._seed_search_deadline
            self._allow_layout_search = False
            self._use_ranked_repair = False

            # 1. Nghiệm khởi tạo ban đầu: repair_greedy_insert (bị chặn bởi hard_search_deadline)
            routes_a: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
            pending = [order.id for order in self.orders]
            if len(self.orders) >= LARGE_SEED_ORDER_COUNT:
                ortools_reserve = (
                    min(1.2, max(0.3, (hard_search_deadline - t_start) * 0.22))
                    if self._ortools_seed_pool
                    else 0.0
                )
                effective_build_deadline = max(t_start + 0.2, hard_search_deadline - ortools_reserve)
                build_total = max(0.2, effective_build_deadline - t_start)
                savings_budget = min(12.0, build_total * 0.42) if build_total >= 4.0 else 0.0
                savings_routes = None
                savings_missing: List[str] = []
                if savings_budget >= 1.0:
                    savings_routes, savings_missing = build_savings_routes(
                        self,
                        original_vehicle_indices,
                        min(effective_build_deadline, t_start + savings_budget),
                    )
                    if savings_routes is not None and any(savings_routes) and not savings_missing:
                        sav_cons_dl = min(effective_build_deadline, time.perf_counter() + min(2.0, build_total * 0.08))
                        savings_routes = self._consolidate_delivery_cycles(savings_routes, savings_missing, sav_cons_dl)
                        if time.perf_counter() + 0.15 < effective_build_deadline:
                            sav_acr_dl = min(effective_build_deadline, time.perf_counter() + min(1.8, build_total * 0.07))
                            savings_routes = self._consolidate_across_routes(savings_routes, savings_missing, sav_acr_dl)
                sav_span = (
                    len({self.vehicles[i].service_day_index for i, r in enumerate(savings_routes) if r})
                    if savings_routes is not None
                    else 0
                )
                need_append_baseline = (
                    savings_routes is None
                    or not any(savings_routes)
                    or bool(savings_missing)
                    or (sav_span > 1 and len(self.orders) <= 80)
                )
                if need_append_baseline:
                    append_now = time.perf_counter()
                    append_deadline = min(
                        effective_build_deadline,
                        append_now + max(0.2, (effective_build_deadline - append_now) * 0.45),
                    )
                    use_append_economy = bool(
                        savings_routes is not None
                        and any(savings_routes)
                        and not savings_missing
                        and self.random_seed % 2 == 0
                    )
                    pending = self._append_delivery_cycles(
                        routes_a,
                        original_vehicle_indices,
                        append_deadline,
                        allow_overlap=True,
                        cross_day_economy=use_append_economy,
                    )
                    unassigned_a = pending
                if savings_routes is not None and any(savings_routes):
                    if not need_append_baseline:
                        routes_a = savings_routes
                        unassigned_a = savings_missing
                        pending = savings_missing
                    else:
                        savings_key = self._candidate_key(savings_routes, savings_missing)
                        append_key = self._candidate_key(routes_a, unassigned_a)
                        if savings_key < append_key:
                            loser_entry = (append_key, copy.deepcopy(routes_a), list(unassigned_a)) if any(routes_a) else None
                            routes_a = savings_routes
                            unassigned_a = savings_missing
                            pending = savings_missing
                            if loser_entry is not None:
                                self._ils_elite_routes_pool.append(loser_entry)
                        else:
                            self._ils_elite_routes_pool.append(
                                (savings_key, copy.deepcopy(savings_routes), list(savings_missing))
                            )
                consolidate_deadline = min(
                    effective_build_deadline,
                    time.perf_counter() + min(5.5, max(0.6, (effective_build_deadline - time.perf_counter()) * 0.30)),
                )
                routes_a = self._consolidate_delivery_cycles(routes_a, unassigned_a, consolidate_deadline)
                across_deadline = min(
                    effective_build_deadline,
                    time.perf_counter() + min(5.5, max(0.5, (effective_build_deadline - time.perf_counter()) * 0.35)),
                )
                routes_a = self._consolidate_across_routes(routes_a, unassigned_a, across_deadline)
                compress_deadline = min(
                    effective_build_deadline,
                    time.perf_counter() + min(5.5, max(0.5, (effective_build_deadline - time.perf_counter()) * 0.40)),
                )
                before_days = len({self.vehicles[i].service_day_index for i, r in enumerate(routes_a) if r})
                routes_a = self._compress_service_days(routes_a, unassigned_a, compress_deadline)
                after_days = len({self.vehicles[i].service_day_index for i, r in enumerate(routes_a) if r})
                if after_days < before_days and time.perf_counter() + 0.3 < effective_build_deadline:
                    polish_across_deadline = min(
                        effective_build_deadline,
                        time.perf_counter() + min(3.5, max(0.3, (effective_build_deadline - time.perf_counter()) * 0.35)),
                    )
                    routes_a = self._consolidate_across_routes(routes_a, unassigned_a, polish_across_deadline)
                if time.perf_counter() + 0.25 < effective_build_deadline:
                    phys_deadline = min(
                        effective_build_deadline,
                        time.perf_counter() + min(1.5, max(0.25, (effective_build_deadline - time.perf_counter()) * 0.30)),
                    )
                    reassigned_init = self._optimize_production_vehicles(routes_a, unassigned_a, phys_deadline)
                    if reassigned_init is not None:
                        routes_a, unassigned_a = reassigned_init[1], reassigned_init[2]
                        pending = unassigned_a
                now = time.perf_counter()
                remaining = effective_build_deadline - now
                if self.request.demo_stacking is not None and not pending and remaining >= 1.5:
                    audit_budget = min(2.0, remaining * 0.25)
                    verified = self._build_final_response(
                        routes_a, [], include_benchmarks=False,
                        spatial_time_budget_seconds=audit_budget,
                        absolute_spatial_deadline=now + audit_budget,
                    )
                    if verified.status == "SUCCESS" and verified.routes and not verified.unassigned_orders:
                        self._verified_construction_plan = verified
            else:
                self._use_ranked_repair = (
                    self.request.demo_stacking is not None
                    and any(len(order.items) > 1 for order in self.orders)
                )
                routes_a, unassigned_a = self._repair_greedy_insert(
                    routes_a, pending, start_time=t_start, deadline=hard_search_deadline, randomize=False,
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
            if search_deadline is None:
                budget_p1 = max(1.5, (self.time_limit_sec or 2.0) * 0.65)
                if cur_unassigned:
                    # Construction-limited instances spend the native allocation
                    # on completing/rebuilding the seed instead. Keep the same
                    # combined search budget and the post-audit reserve.
                    budget_p1 += self.time_limit_sec - self._post_audit_budget_sec
                    self._native_search_budget_available = False
                search_started_at = time.perf_counter()
                deadline_p1 = search_started_at + budget_p1
            else:
                search_started_at = time.perf_counter()
                remaining_search = max(0.0, hard_search_deadline - search_started_at)
                ils_share = (
                    0.28
                    if not cur_unassigned and (self._ortools_seed_pool or (self.time_limit_sec or 0.0) >= 10.0)
                    else 0.45
                )
                budget_p1 = min(
                    remaining_search * ils_share,
                    max(0.05, (self.time_limit_sec or 2.0) * ils_share),
                )
                if not cur_unassigned:
                    budget_p1 = min(budget_p1, 16.0)
                if cur_unassigned:
                    # Construction-limited instances spend the remaining search budget
                    # on completing/rebuilding the seed instead.
                    budget_p1 = remaining_search
                    self._native_search_budget_available = False
                deadline_p1 = min(hard_search_deadline, search_started_at + budget_p1)
            self._seed_search_deadline = deadline_p1

            # Construction may stop with missing orders. Spend the fresh phase
            # budget on coverage before moving already served orders for cost.
            if cur_unassigned:
                # A partial greedy basin can remain fragmented even after
                # filling its missing orders. Rebuild within this same phase
                # using ranked probes, retaining the original as a fallback.
                self._use_ranked_repair = not self._use_ranked_repair
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

                reassigned = self._try_vehicle_reassignment(cur_routes, cur_unassigned, deadline_p1)
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

            reassigned = None
            if search_deadline is None or time.perf_counter() < search_deadline:
                reassigned = self._production_vehicle_reassignment(best_routes, best_unassigned, search_deadline)
            if reassigned is not None:
                best_cost, best_routes, best_unassigned = reassigned
                best_key = self._candidate_key(best_routes, best_unassigned)
                self._ils_elite_routes_pool.append((best_key, copy.deepcopy(best_routes), list(best_unassigned)))

            if self._ortools_seed_pool:
                seed_deadline = min(
                    hard_search_deadline,
                    time.perf_counter() + min(0.95, max(0.25, (self.time_limit_sec or 2.0) * 0.22)),
                )
                for raw_routes in self._ortools_seed_pool:
                    if time.perf_counter() >= seed_deadline:
                        break
                    cand_key, cand_routes, cand_unassigned = self._repair_raw_ortools_seed(
                        raw_routes,
                        seed_deadline,
                    )
                    if any(cand_routes):
                        self._ils_elite_routes_pool.append(
                            (cand_key, copy.deepcopy(cand_routes), list(cand_unassigned))
                        )
                        if cand_key < best_key:
                            best_key = cand_key
                            best_routes = copy.deepcopy(cand_routes)
                            best_unassigned = list(cand_unassigned)
                            self._construction_audit_fallback = (
                                copy.deepcopy(best_routes),
                                list(best_unassigned),
                            )
                            if not best_unassigned:
                                self._native_search_budget_available = True

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

    def _convert_hybrid_stops_to_prod(self, stops: Sequence[HybridScheduledStop]) -> List[ScheduledStop]:
        converted_stops: List[ScheduledStop] = []
        for sequence, stop in enumerate(stops, start=1):
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
        return converted_stops

    def _build_alns_pool_route_dicts(
        self,
        solution: Optional[HybridOptimizationSolution],
        original_index_by_vehicle_id: Dict[str, int],
        all_candidate_plans: Sequence[Tuple[List[List[ScheduledStop]], List[str]]],
        audited_responses: Sequence[FleetOptimizationResponse],
        *,
        max_stubs: int = 180,
    ) -> List[Dict[str, Any]]:
        if max_stubs <= 0:
            return []
        already_audited_keys: Set[Tuple[str, Tuple[Tuple[str, str], ...]]] = set()
        for resp in audited_responses:
            for route in resp.routes:
                slot_id = route.route_id or route.vehicle_id
                sig = tuple(
                    (stop.stop_type, stop.allocation_id or stop.order_id or "")
                    for stop in route.stops
                )
                already_audited_keys.add((slot_id, sig))

        seen_keys: Set[Tuple[str, Tuple[Tuple[str, str], ...]]] = set(already_audited_keys)
        candidates: List[Tuple[int, List[ScheduledStop]]] = []

        for cand_routes_stops, _unassigned in all_candidate_plans:
            for v_idx, prod_stops in enumerate(cand_routes_stops):
                if not prod_stops:
                    continue
                slot_id = self.vehicles[v_idx].id
                sig = tuple(
                    (stop.stop_type, stop.allocation_id or stop.order_id or "")
                    for stop in prod_stops
                )
                if (slot_id, sig) in seen_keys:
                    continue
                seen_keys.add((slot_id, sig))
                candidates.append((v_idx, prod_stops))

        if solution is not None:
            for vehicle_slot_id, hybrid_stops in getattr(solution, "_alns_route_pool", []):
                v_idx = original_index_by_vehicle_id.get(vehicle_slot_id)
                if v_idx is None or not hybrid_stops:
                    continue
                prod_stops = self._convert_hybrid_stops_to_prod(hybrid_stops)
                if not prod_stops:
                    continue
                sig = tuple(
                    (stop.stop_type, stop.allocation_id or stop.order_id or "")
                    for stop in prod_stops
                )
                if (vehicle_slot_id, sig) in seen_keys:
                    continue
                seen_keys.add((vehicle_slot_id, sig))
                candidates.append((v_idx, prod_stops))

        stub_dicts: List[Dict[str, Any]] = []
        for v_idx, prod_stops in candidates:
            if len(stub_dicts) >= max_stubs:
                break
            stub_route = self.build_pool_route_stub(v_idx, prod_stops)
            if stub_route is None or stub_route.cost is None:
                continue
            dumped = stub_route.model_dump()
            dumped["_pool_stub"] = True
            stub_dicts.append(dumped)
        return stub_dicts

    def solve(self, hard_deadline: Optional[float] = None) -> FleetOptimizationResponse:
        with scoped_spatial_cache():
            return self._solve_with_cache(hard_deadline=hard_deadline)

    def _solve_with_cache(
        self, hard_deadline: Optional[float] = None
    ) -> FleetOptimizationResponse:
        self._verified_construction_plan = None
        solve_started_at = time.perf_counter()
        solve_deadline = solve_started_at + max(0.5, float(self.time_limit_sec or 2.0))
        if hard_deadline is not None:
            solve_deadline = min(solve_deadline, hard_deadline)
        total_budget = max(0.5, solve_deadline - solve_started_at)
        audit_reserve_sec = (
            min(4.0, max(1.0, total_budget * 0.28))
            if total_budget >= 2.0
            else total_budget * 0.25
        )
        if len(self.orders) >= LARGE_SEED_ORDER_COUNT:
            max_audit_reserve = 12.0 if len(self.orders) >= 80 else 8.0
            audit_reserve_sec = min(max_audit_reserve, max(3.0, total_budget * 0.22))
            pipeline_deadline = solve_started_at + self.request.max_time_seconds
            if hard_deadline is not None:
                pipeline_deadline = min(pipeline_deadline, hard_deadline)
            solve_deadline = min(pipeline_deadline, solve_deadline + audit_reserve_sec)
        search_deadline = max(solve_started_at + 0.25, solve_deadline - audit_reserve_sec)

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
        cycle_checkpoint = None
        # Packing many pieces per order or dense interleaved stops can exhaust the
        # search budget before ALNS yields a valid audited plan. Reserve a quick
        # sequential cycle fallback proportional to cargo density.
        total_item_count = sum(len(order.items) for order in self.orders)
        is_dense_cargo = total_item_count >= 10 * len(self.orders)
        if len(resource_pairs) >= 2 and len(self.orders) < LARGE_SEED_ORDER_COUNT and (
            is_dense_cargo or (len(self.orders) >= 4 and total_budget >= 1.5)
        ):
            if is_dense_cargo:
                checkpoint_cap = 4.5 if (len(self.orders) >= 12 or total_item_count >= 80) else 2.5
                checkpoint_budget = min(checkpoint_cap, total_budget * 0.45)
                checkpoint_attempts = 12
            else:
                checkpoint_budget = min(0.60, total_budget * 0.12)
                checkpoint_attempts = 2
            cycle_checkpoint = self._audited_cycle_checkpoint(
                [index for index, _ in resource_pairs],
                min(search_deadline, solve_started_at + checkpoint_budget),
                max_attempts=checkpoint_attempts,
            )
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
                            # Preserve explicit allowed_orientations locks in all modes,
                            # while keeping legacy D11 rotation when allowed_orientations is omitted.
                            can_rotate=resolve_can_rotate(
                                item,
                                d11_default=True,
                            ),
                            allowed_orientations=item.allowed_orientations,
                            description=item.description or "",
                            customer_id=item.customer_id,
                            cargo_kind=item.cargo_kind,
                            allow_upper_tier=item.allow_upper_tier,
                            no_top_load_requested=item.no_top_load_requested,
                            max_top_load_g=item.max_top_load_g,
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
                    ordered_at_sec=int(order.ordered_at_sec),
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
            delivery_grace_days=self.policy.delivery_grace_days,
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
            demo_stacking=self.request.demo_stacking,
        )
        self._hybrid_model_context = (orders, policy, node_id_to_index)
        construction_deadline = search_deadline
        available_search = max(0.0, search_deadline - time.perf_counter())
        construction_share = 0.50 if available_search >= 45.0 else 0.60
        if self.request.early_stop_patience and self.request.search_time_seconds:
            capped_adaptive = min(search_deadline, solve_started_at + self.request.search_time_seconds)
            if len(self.orders) >= 12 and available_search >= 8.0:
                capped_adaptive = min(capped_adaptive, time.perf_counter() + available_search * construction_share)
            construction_deadline = capped_adaptive
        elif len(self.orders) >= 12 and available_search >= 8.0:
            # Reserve at least 50% of >=45s search budgets (40% for shorter runs) for ALNS & cross-exchange.
            construction_deadline = time.perf_counter() + available_search * construction_share
        initial_solution = self._build_hybrid_initial_solution(
            vehicles,
            drivers,
            original_vehicle_indices,
            pickup_key_by_order,
            delivery_key_by_order,
            search_deadline=construction_deadline,
        )
        checkpoints = [
            plan for plan in (
                self.initial_plan if self._initial_plan_is_verified else None,
                cycle_checkpoint,
                self._verified_construction_plan,
            )
            if plan is not None
        ]
        checkpoint = self._best_audited_response(checkpoints) if checkpoints else None

        operator_weights: Dict[str, Dict[str, float]] = {}
        solution = initial_solution
        native_budget = max(0.0, search_deadline - time.perf_counter())
        if (
            initial_solution is None
            and checkpoint is None
            and (solve_deadline - solve_started_at) >= 1.5
        ):
            ceiling_deadline = (
                min(solve_deadline, hard_deadline)
                if hard_deadline is not None
                else solve_deadline
            )
            audit_floor_sec = 0.35
            available_for_native = max(
                0.0, ceiling_deadline - time.perf_counter() - audit_floor_sec
            )
            if available_for_native >= 0.15:
                self._native_search_budget_available = True
                native_budget = max(
                    native_budget,
                    min(2.5, (solve_deadline - solve_started_at) * 0.5, available_for_native),
                )
        skip_native_for_cycle_checkpoint = (
            checkpoint is not None
            and (search_deadline - time.perf_counter()) < 0.25
        )
        skip_native_for_large_complete_seed = (
            initial_solution is not None
            and not initial_solution.unassigned_orders
            and len(self.orders) >= 80
            and native_budget < 1.5
            and not self.request.early_stop_patience
        )
        if (
            (self._native_search_budget_available or self.request.early_stop_patience)
            and native_budget >= 0.05
            and not skip_native_for_cycle_checkpoint
            and not skip_native_for_large_complete_seed
        ):
            effective_max_iterations = (
                self.max_iterations
                if self.max_iterations < 800
                else max(800, int(native_budget * 600))
            )
            solution = solve_hybrid_alns(
                vehicles, drivers, orders, policy,
                self.request.distance_matrix_meters,
                self.request.duration_matrix_seconds, node_id_to_index,
                time_limit_sec=native_budget,
                post_audit_reserve_sec=min(self._post_audit_budget_sec, max(0.02, native_budget * 0.14)),
                max_iterations=effective_max_iterations, random_seed=self.random_seed,
                initial_solution=initial_solution, operator_weights_out=operator_weights,
                search_profile="historical_portfolio",
                final_spatial_time_limit_sec=min(
                    1.5 if (len(self.orders) >= LARGE_SEED_ORDER_COUNT and native_budget < 12.0) else 3.0,
                    max(0.05, native_budget * 0.22),
                ),
                final_repair_time_limit_sec=min(
                    1.5 if (len(self.orders) >= LARGE_SEED_ORDER_COUNT and native_budget < 12.0) else 3.0,
                    max(0.05, native_budget * 0.22),
                ),
                early_stop_patience=self.request.early_stop_patience,
                has_verified_plan=checkpoint is not None,
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
                c_routes_stops[vehicle_index] = self._convert_hybrid_stops_to_prod(route.stops)

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
        max_items_per_order = max((len(order.items) for order in self.orders), default=0)
        reassign_now = time.perf_counter()
        reassign_deadline = reassign_now + min(
            2.4,
            max(0.3, (solve_deadline - reassign_now) * 0.22),
        )
        for c_routes, c_unassigned in all_candidate_plans:
            route_signature = self._state_signature(c_routes)
            sig = (route_signature, tuple(sorted(c_unassigned)))
            if sig not in seen_signatures:
                seen_signatures.add(sig)
                now = time.perf_counter()
                if now < reassign_deadline and (
                    (not unique_plans and now < solve_deadline - 0.15)
                    or now < solve_deadline - 0.5
                ):
                    candidate_reassign_deadline = min(
                        reassign_deadline,
                        solve_deadline - (0.4 if unique_plans else 0.15),
                    )
                    reassigned = self._optimize_production_vehicles(
                        c_routes,
                        c_unassigned,
                        candidate_reassign_deadline,
                    )
                else:
                    reassigned = None
                if reassigned is not None:
                    r_routes, r_unassigned = reassigned[1], reassigned[2]
                else:
                    r_routes, r_unassigned = c_routes, c_unassigned
                candidate = (self._rank_candidate_for_audit(r_routes, r_unassigned), r_routes, r_unassigned)
                unique_plans.append(candidate)
                if sig == construction_signature:
                    construction_fallback = candidate

        unique_plans.sort(key=lambda x: x[0])

        audit_limit = 3 if max_items_per_order >= 40 else 6
        audit_candidates = self._select_audit_candidates(unique_plans, limit=audit_limit, fallback=construction_fallback)
        if len({vehicle.service_day_index for vehicle in self.vehicles}) > 1:
            audit_candidates = self._inject_objective_audit_candidate(
                audit_candidates,
                unique_plans,
                limit=audit_limit,
                fallback=construction_fallback,
            )
        valid_responses = [checkpoint] if checkpoint is not None else []
        incumbent = checkpoint
        failed_route_signatures: Set[Tuple[Any, ...]] = set()
        for idx, (_, c_routes_stops, unassigned_ids) in enumerate(audit_candidates):
            remaining = solve_deadline - time.perf_counter()
            has_full_served = any(not r.unassigned_orders for r in valid_responses)
            has_routed_response = any(r.routes for r in valid_responses)
            if has_full_served and remaining <= 0.35:
                break
            if has_routed_response and remaining <= 0.15:
                break
            cand_route_sigs = {
                (self.vehicles[v_idx].id, tuple((s.order_id, s.stop_type) for s in r_stops))
                for v_idx, r_stops in enumerate(c_routes_stops)
                if r_stops
            }
            if (
                remaining < 4.0
                and cand_route_sigs
                and cand_route_sigs <= failed_route_signatures
            ):
                continue
            allow_best_candidate_grace = (
                not has_routed_response
                and idx <= 1
                and (solve_deadline - solve_started_at) >= 1.5
                and (hard_deadline is None or hard_deadline - time.perf_counter() > 0.25)
            )
            if not has_routed_response and remaining <= 0.0 and not allow_best_candidate_grace:
                break
            desired_spatial_budget = max(8.0, sum(bool(r) for r in c_routes_stops) * 3.0)
            grace_cap = (
                max(4.0, sum(bool(r) for r in c_routes_stops) * 2.0)
                if idx == 0
                else max(2.0, sum(bool(r) for r in c_routes_stops) * 1.5)
            )
            per_candidate_cap = (
                min(desired_spatial_budget, grace_cap)
                if remaining <= 0.0 and allow_best_candidate_grace
                else max(
                    0.25,
                    remaining / max(1, min(2, len(audit_candidates) - idx)),
                )
            )
            if len(self.orders) >= LARGE_SEED_ORDER_COUNT:
                # Give a complete seed one audit before spending time on alternatives.
                per_candidate_cap = max(
                    audit_reserve_sec,
                    remaining if remaining > 0 else audit_reserve_sec,
                )
            elif (
                not has_full_served
                and not unassigned_ids
                and max_items_per_order >= 10
                and idx == 0
                and remaining > 0
            ):
                # Multi-item complete routes need most of the remaining audit slice
                # before secondary alternatives can share the leftover budget.
                per_candidate_cap = max(per_candidate_cap, remaining * 0.72)
            if hard_deadline is not None:
                hard_rem = hard_deadline - time.perf_counter()
                if hard_rem <= 0.05:
                    break
                per_candidate_cap = min(per_candidate_cap, max(0.15, hard_rem - 0.05))
            audit_budget = min(desired_spatial_budget, per_candidate_cap)
            guarded_incumbent = incumbent if len(self.orders) >= LARGE_SEED_ORDER_COUNT else None
            # Small-snapshot cycle checkpoints can still use salvage to merge
            # their one-order fallback routes. Large audited plans can abort a
            # failed trial instead of spending their remaining time on salvage.
            checkpoint_guard = (
                (min(solve_deadline, time.perf_counter() + audit_budget), guarded_incumbent)
                if guarded_incumbent is not None else None
            )
            cand_resp = self._build_final_response(
                c_routes_stops,
                unassigned_ids,
                include_benchmarks=False,
                spatial_time_budget_seconds=audit_budget,
                polish_checkpoint=checkpoint_guard,
            )
            if cand_resp is incumbent:
                continue
            if cand_resp.status == "SUCCESS" and cand_resp.routes and not cand_resp.unassigned_orders:
                incumbent = self._best_audited_response([incumbent, cand_resp]) if incumbent else cand_resp
            if not cand_resp.unassigned_orders or cand_resp.routes:
                # Never let an earlier 0-route TIMEOUT response mask a valid routed plan.
                valid_responses = [r for r in valid_responses if r.routes]
                valid_responses.append(cand_resp)
            elif not valid_responses:
                valid_responses.append(cand_resp)

            if cand_resp.unassigned_orders and per_candidate_cap >= 1.0:
                if not cand_resp.routes and len(cand_route_sigs) == 1:
                    failed_route_signatures.update(cand_route_sigs)
                elif cand_resp.routes:
                    passed_sigs = {
                        (
                            getattr(route, "route_id", None) or getattr(route, "vehicle_id", None),
                            tuple((stop.order_id, stop.stop_type) for stop in getattr(route, "stops", [])),
                        )
                        for route in cand_resp.routes
                    }
                    failed_route_signatures.update(cand_route_sigs - passed_sigs)

        if not valid_responses:
            return FleetOptimizationResponse(
                job_id=self.request.job_id,
                status="TIMEOUT",
                total_distance_km=0.0,
                total_duration_minutes=0.0,
                total_cost_vnd=0,
                routes=[],
                unassigned_orders=[
                    UnassignedOrder(
                        order_id=order.id,
                        order_number=order.order_number or order.id,
                        reason_code="TIMEOUT",
                        reason_message="Hết ngân sách thời gian trước khi kiểm chứng xong phương án.",
                    )
                    for order in self.orders
                ],
                diagnostics=[
                    f"Hết ngân sách thời gian ({total_budget:g}s) trước khi kiểm chứng xong phương án."
                ],
            )

        polish_deadline = min(
            max(time.perf_counter(), solve_deadline - 0.05),
            time.perf_counter() + self._post_audit_budget_sec,
        )
        full_valid = [r for r in valid_responses if not r.unassigned_orders]
        if full_valid:
            for r in full_valid:
                apply_planning_objective(self.objective_request, r)
            full_valid.sort(key=plan_lexicographic_key)
            best_so_far: Optional[FleetOptimizationResponse] = None
            polished_candidates: List[FleetOptimizationResponse] = []
            for idx, resp in enumerate(full_valid[:2]):
                rem = polish_deadline - time.perf_counter()
                if rem <= 0.05:
                    polished = resp
                else:
                    slice_deadline = (
                        time.perf_counter() + max(0.05, rem * 0.65)
                        if idx == 0 and len(full_valid) > 1
                        else polish_deadline
                    )
                    polished = self._polish_audited_response(resp, slice_deadline)
                polished_candidates.append(polished)
                best_so_far = (
                    polished
                    if best_so_far is None
                    else self._best_audited_response([best_so_far, polished])
                )
            if len(full_valid) > 2:
                best_so_far = self._best_audited_response([best_so_far, *full_valid[2:]])
            result = best_so_far
            seen_alt_ids = {id(result)}
            alternatives: List[FleetOptimizationResponse] = []
            for resp in (*polished_candidates, *full_valid):
                if id(resp) not in seen_alt_ids and not resp.unassigned_orders and resp.routes:
                    seen_alt_ids.add(id(resp))
                    alternatives.append(resp)
            setattr(result, "_audited_alternatives", alternatives)
            setattr(
                result,
                "_alns_pool_route_dicts",
                self._build_alns_pool_route_dicts(
                    solution,
                    original_index_by_vehicle_id,
                    all_candidate_plans,
                    [result, *alternatives],
                ),
            )
        else:
            result = self._best_audited_response(valid_responses)
            if time.perf_counter() + 0.05 < polish_deadline:
                result = self._polish_audited_response(result, polish_deadline)

        if (
            self.include_benchmarks
            and getattr(result, "benchmarks", None) is None
            and time.perf_counter() + 0.15 < solve_deadline
        ):
            try:
                from .baseline_calculator import BaselineCostCalculator
                nodes = []
                for v in getattr(self, "vehicles", []):
                    nodes.append({"id": v.depot.id, "latitude": v.depot.latitude, "longitude": v.depot.longitude})
                for o in getattr(self, "orders", []):
                    nodes.append({"id": o.pickup_location.id, "latitude": o.pickup_location.latitude, "longitude": o.pickup_location.longitude, "order": o})
                    nodes.append({"id": o.delivery_location.id, "latitude": o.delivery_location.latitude, "longitude": o.delivery_location.longitude, "order": o})
                calc = BaselineCostCalculator(self.request, nodes, deadline=solve_deadline)
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
        if getattr(solution, "_stopped_for_patience", False):
            result.diagnostics.append(
                f"Seed {self.random_seed} dừng sớm sau {self.request.early_stop_patience} "
                "phương án hợp lệ liên tiếp không cải thiện."
            )
        apply_planning_objective(self.objective_request, result)
        return result
