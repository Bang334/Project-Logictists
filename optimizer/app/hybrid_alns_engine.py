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
from .models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    OrderPair,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    can_driver_drive_vehicle,
)
from .planning_objective import apply_planning_objective
Insertion = Tuple[float, int, List[ScheduledStop]]
SearchState = Tuple[int, List[List[ScheduledStop]], List[str]]


class PackingAwareHybridALNSOptimizer(ALNSFleetOptimizer):
    """Adaptive destroy/repair search with route consolidation and elite audit."""

    def __init__(
        self,
        request: FleetOptimizationRequest,
        max_iterations: int = 500,
        time_budget_seconds: Optional[float] = None,
        random_seed: int = 0,
        initial_plan: Optional[FleetOptimizationResponse] = None,
    ) -> None:
        super().__init__(
            request,
            max_iterations=max_iterations,
            time_budget_seconds=time_budget_seconds,
            random_seed=random_seed,
        )
        self.initial_plan = initial_plan
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
        deadline: float,
        sample_limit: int = 8,
    ) -> Optional[SearchState]:
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
    ) -> List[SearchState]:
        selected: List[SearchState] = []
        overflow: List[SearchState] = []
        route_count_frequency: Dict[int, int] = {}
        for candidate in candidates:
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
                    self.drivers[driver_index].id,
                ),
            )

        driver_to_vehicle: Dict[int, int] = {}

        def assign(vehicle_index: int, seen_drivers: Set[int]) -> bool:
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
        if warm_state is None:
            return None

        _, production_routes, _ = warm_state
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
            solver_name="OR-Tools production warm start",
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
            solution_audited=True,
            random_seed=self.random_seed,
        )

    def solve(self) -> FleetOptimizationResponse:
        resource_pairs = self._matched_vehicle_driver_indices()
        if not resource_pairs:
            result = self._build_final_response(
                [[] for _ in self.vehicles],
                [order.id for order in self.orders],
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
                            # D11: every rectangular package may rotate on the
                            # vehicle floor.  The orthogonal packers represent
                            # 0/180 and 90/270 degrees by the two footprints.
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
        solution = solve_hybrid_alns(
            vehicles,
            drivers,
            orders,
            policy,
            self.request.distance_matrix_meters,
            self.request.duration_matrix_seconds,
            node_id_to_index,
            time_limit_sec=self.time_limit_sec,
            max_iterations=self.max_iterations,
            random_seed=self.random_seed,
            initial_solution=initial_solution,
            operator_weights_out=operator_weights,
            search_profile="historical_portfolio",
            final_spatial_time_limit_sec=min(
                2.0, max(0.1, self.time_limit_sec * 0.2)
            ),
            final_repair_time_limit_sec=min(
                3.0, max(0.1, self.time_limit_sec * 0.3)
            ),
        )
        if "destroy" in operator_weights:
            self.destroy_weights = operator_weights["destroy"]
        if "repair" in operator_weights:
            self.repair_weights = operator_weights["repair"]

        routes_stops: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        original_index_by_vehicle_id = {
            self.vehicles[index].id: index
            for index in original_vehicle_indices
        }
        for route in solution.routes:
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
            routes_stops[vehicle_index] = converted_stops

        order_id_by_number = {
            order.order_number: order.id for order in self.orders
        }
        unassigned_ids = [
            order_id_by_number.get(value, value)
            for value in solution.unassigned_orders
        ]
        result = self._build_final_response(
            routes_stops,
            unassigned_ids,
            include_benchmarks=True,
            # The Hybrid core has already audited its chosen solution. Keep the
            # adapter's mandatory production re-audit bounded so an HTTP call
            # cannot spend an unbounded amount of time per returned route.
            spatial_time_budget_seconds=min(
                8.0,
                max(0.5, self.time_limit_sec),
            ),
        )
        result.diagnostics = [
            diagnostic
            for diagnostic in result.diagnostics
            if not diagnostic.startswith("ALNS hoàn tất")
        ] + [
            (
                f"Hybrid ALNS hoàn tất với seed {self.random_seed}; "
                "đã audit lại bằng SpatialValidator production."
            ),
            f"Solver nội bộ: {solution.solver_name}.",
            (
                "Kết quả là best-found trong ngân sách thời gian, "
                "không chứng minh tối ưu toàn cục."
            ),
        ]
        apply_planning_objective(self.request, result)
        return result
