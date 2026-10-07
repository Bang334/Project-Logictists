"""Genetic Algorithm (GA) for TMS Vehicle Routing & Packing.

Uses permutation-based chromosome encoding with Order Crossover (OX) and Swap/Inversion mutation,
evaluating fitness based on total logistics cost and fulfillment rate with LIFO Door Clearance.
"""

import copy
import os
import random
import sys
import time
from typing import Dict, List, Optional, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.common.cost_evaluator import calculate_route_cost
from algo_lab.common.models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from algo_lab.common.packing_checker import FastPackingChecker


class GeneticRoutingSolver:
    def __init__(
        self,
        vehicles: List[FleetVehicle],
        drivers: List[DriverOption],
        orders: List[OrderPair],
        policy: CostPolicy,
        distance_matrix: List[List[float]],
        duration_matrix: List[List[float]],
        node_id_to_index: Dict[str, int],
        population_size: int = 20,
        generations: int = 30,
        time_limit_sec: float = 3.0,
    ):
        self.vehicles = vehicles
        self.drivers = drivers
        self.orders = orders
        self.order_by_id = {o.id: o for o in orders}
        self.cargo_by_id = {it.id: it for o in orders for it in o.items}
        self.policy = policy
        self.distance_matrix = distance_matrix
        self.duration_matrix = duration_matrix
        self.node_id_to_index = node_id_to_index
        self.population_size = population_size
        self.generations = generations
        self.time_limit_sec = time_limit_sec
        self.checkers = [FastPackingChecker(v) for v in vehicles]
        self._packing_cache: Dict[Tuple[str, Tuple[str, ...]], bool] = {}

    def _validate_stops_cached(self, v_idx: int, cand: List[ScheduledStop]) -> bool:
        v = self.vehicles[v_idx]
        cache_key = (v.id, tuple(st.order_id for st in cand if st.order_id))
        if cache_key in self._packing_cache:
            return self._packing_cache[cache_key]
        valid, _ = self.checkers[v_idx].validate_route_stops(cand, self.cargo_by_id)
        self._packing_cache[cache_key] = valid
        return valid

    def _decode_chromosome(
        self, chromosome: List[str]
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Greedily decodes order sequence into vehicle routes."""
        routes_stops: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        unassigned: List[str] = []

        for order_id in chromosome:
            order = self.order_by_id[order_id]
            best_v: Optional[int] = None
            best_stops: Optional[List[ScheduledStop]] = None
            best_cost = float("inf")
            checked_empty_types = set()

            for v_idx, v in enumerate(self.vehicles):
                curr = routes_stops[v_idx]
                if len(curr) == 0:
                    v_type = (
                        v.payload_limit_kg,
                        v.length_cm,
                        v.width_cm,
                        v.height_cm,
                        v.depot.id,
                    )
                    if v_type in checked_empty_types:
                        continue
                    checked_empty_types.add(v_type)

                base_dist = 0.0
                depot = self.node_id_to_index.get(v.depot.id, 0)
                if len(curr) > 0:
                    prev_n = depot
                    for st in curr:
                        cur_n = self.node_id_to_index.get(st.location_id, 0)
                        base_dist += self.distance_matrix[prev_n][cur_n]
                        prev_n = cur_n
                    base_dist += self.distance_matrix[prev_n][depot]

                n = len(curr)
                p_stop = ScheduledStop(
                    sequence=0,
                    stop_type="PICKUP",
                    location_id=order.pickup_location.id,
                    location_name=order.pickup_location.name,
                    order_id=order.id,
                    order_number=order.order_number,
                    items_loaded=[it.id for it in order.items],
                )
                d_stop = ScheduledStop(
                    sequence=0,
                    stop_type="DELIVERY",
                    location_id=order.delivery_location.id,
                    location_name=order.delivery_location.name,
                    order_id=order.id,
                    order_number=order.order_number,
                    items_unloaded=[it.id for it in order.items],
                )

                # Append insertion
                cand = curr + [p_stop, d_stop]

                # Weight check
                w = 0.0
                cap_ok = True
                for st in cand:
                    if st.stop_type == "PICKUP":
                        w += self.order_by_id[st.order_id].total_weight_kg
                    else:
                        w -= self.order_by_id[st.order_id].total_weight_kg
                    st.current_weight_kg = w
                    if w > v.payload_limit_kg + 0.01:
                        cap_ok = False
                        break
                if not cap_ok:
                    continue

                # 2D packing check (Cached)
                if not self._validate_stops_cached(v_idx, cand):
                    continue

                # Distance & incremental cost
                cand_dist = 0.0
                prev = depot
                for st in cand:
                    cur = self.node_id_to_index.get(st.location_id, 0)
                    cand_dist += self.distance_matrix[prev][cur]
                    prev = cur
                cand_dist += self.distance_matrix[prev][depot]

                inc_dist_m = max(0.0, cand_dist - base_dist)
                inc_dist_km = inc_dist_m / 1000.0
                inc_fuel = (
                    (v.fuel_consumption_liters_per_100_km / 100.0)
                    * inc_dist_km
                    * self.policy.fuel_price_per_liter_vnd
                )
                inc_fixed = v.fixed_operating_cost_vnd if len(curr) == 0 else 0
                inc_driver = (
                    150_000 if len(curr) == 0 else 0
                ) + round(1_200 * inc_dist_km)
                inc_cost = inc_fuel + inc_fixed + inc_driver

                if inc_cost < best_cost:
                    best_cost = inc_cost
                    best_v = v_idx
                    best_stops = cand

            if best_v is not None and best_stops is not None:
                routes_stops[best_v] = best_stops
            else:
                unassigned.append(order_id)

        return routes_stops, unassigned

    def _fitness(self, chromosome: List[str]) -> Tuple[float, List[List[ScheduledStop]], List[str]]:
        routes_stops, unassigned = self._decode_chromosome(chromosome)
        econ_cost = 0
        for v_idx, stops in enumerate(routes_stops):
            if not stops:
                continue
            v = self.vehicles[v_idx]
            d = self.drivers[v_idx]
            breakdown, _, _ = calculate_route_cost(
                v,
                d,
                stops,
                self.order_by_id,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
            )
            econ_cost += breakdown.total_cost_vnd

        penalized_cost = econ_cost + len(unassigned) * self.policy.unassigned_order_penalty_vnd
        return penalized_cost, routes_stops, unassigned

    def _ox_crossover(self, parent1: List[str], parent2: List[str]) -> List[str]:
        """Order Crossover (OX)."""
        size = len(parent1)
        a, b = sorted(random.sample(range(size), 2))
        child = [None] * size
        child[a : b + 1] = parent1[a : b + 1]
        p2_remaining = [item for item in parent2 if item not in child[a : b + 1]]

        idx = 0
        for i in range(size):
            if child[i] is None:
                child[i] = p2_remaining[idx]
                idx += 1
        return child

    def _mutate(self, chromosome: List[str]) -> List[str]:
        """Swap mutation."""
        c = list(chromosome)
        if len(c) >= 2:
            i, j = random.sample(range(len(c)), 2)
            c[i], c[j] = c[j], c[i]
        return c

    def solve(self) -> OptimizationSolution:
        start_time = time.perf_counter()
        order_ids = [o.id for o in self.orders]

        # Initialize population
        population: List[List[str]] = []
        for _ in range(self.population_size):
            ind = list(order_ids)
            random.shuffle(ind)
            population.append(ind)

        # Include sorted by weight/volume as elite seed
        elite_seed = [
            o.id
            for o in sorted(
                self.orders,
                key=lambda x: (x.total_weight_kg, x.total_volume_m3),
                reverse=True,
            )
        ]
        population[0] = elite_seed

        best_cost = float("inf")
        best_routes: List[List[ScheduledStop]] = []
        best_unassigned: List[str] = []

        for gen in range(self.generations):
            if time.perf_counter() - start_time >= self.time_limit_sec:
                break

            scored_pop = []
            for ind in population:
                if time.perf_counter() - start_time >= self.time_limit_sec and scored_pop:
                    break
                cost, r, u = self._fitness(ind)
                scored_pop.append((cost, ind, r, u))
                if cost < best_cost:
                    best_cost = cost
                    best_routes = r
                    best_unassigned = u

            scored_pop.sort(key=lambda x: x[0])
            if len(scored_pop) == 0:
                break
            if len(scored_pop) == 1:
                new_population = [scored_pop[0][1]] * self.population_size
                population = new_population
                continue

            # Elitism: keep top 2
            new_population = [scored_pop[0][1], scored_pop[min(1, len(scored_pop) - 1)][1]]
            tour_k = min(3, len(scored_pop))

            while len(new_population) < self.population_size:
                # Tournament selection
                p1 = min(random.sample(scored_pop, tour_k), key=lambda x: x[0])[1]
                p2 = min(random.sample(scored_pop, tour_k), key=lambda x: x[0])[1]

                child = self._ox_crossover(p1, p2)
                if random.random() < 0.25:
                    child = self._mutate(child)
                new_population.append(child)

            population = new_population

        # Finalize best solution
        optimized_routes: List[OptimizedRoute] = []
        total_econ = 0
        total_km = 0.0

        for v_idx, stops in enumerate(best_routes):
            if not stops:
                continue
            v = self.vehicles[v_idx]
            d = self.drivers[v_idx]

            depot = self.node_id_to_index.get(v.depot.id, 0)
            curr_time = 0
            prev_node = depot
            w = 0.0
            for seq, st in enumerate(stops, start=1):
                st.sequence = seq
                cur_node = self.node_id_to_index.get(st.location_id, 0)
                transit = self.duration_matrix[prev_node][cur_node]
                st.arrival_time_sec = int(curr_time + transit)
                order = self.order_by_id[st.order_id]
                st.departure_time_sec = st.arrival_time_sec + order.service_time_sec
                curr_time = st.departure_time_sec
                prev_node = cur_node
                if st.stop_type == "PICKUP":
                    w += order.total_weight_kg
                else:
                    w -= order.total_weight_kg
                st.current_weight_kg = w

            breakdown, dist_km, dur_min = calculate_route_cost(
                v,
                d,
                stops,
                self.order_by_id,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
            )
            optimized_routes.append(
                OptimizedRoute(
                    vehicle=v,
                    driver=d,
                    stops=stops,
                    total_distance_km=dist_km,
                    total_duration_minutes=dur_min,
                    cost_breakdown=breakdown,
                )
            )
            total_econ += breakdown.total_cost_vnd
            total_km += dist_km

        elapsed = round(time.perf_counter() - start_time, 3)
        unassigned_numbers = [self.order_by_id[oid].order_number for oid in best_unassigned]
        fulfillment = round(
            (len(self.orders) - len(best_unassigned)) / max(1, len(self.orders)) * 100, 1
        )

        return OptimizationSolution(
            solver_name="Genetic Algorithm (OX Crossover + LIFO Packing)",
            execution_time_sec=elapsed,
            routes=optimized_routes,
            unassigned_orders=unassigned_numbers,
            real_economic_cost_vnd=total_econ,
            penalized_objective_vnd=int(best_cost),
            total_distance_km=round(total_km, 2),
            fulfillment_rate=fulfillment,
            is_spatial_valid=True,
            spatial_notes="Hợp lệ không gian & cửa xe",
        )


def solve_genetic(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    time_limit_sec: float = 3.0,
) -> OptimizationSolution:
    solver = GeneticRoutingSolver(
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
        time_limit_sec=time_limit_sec,
    )
    return solver.solve()


if __name__ == "__main__":
    from algo_lab.common.data_loader import load_dataset

    sys.stdout.reconfigure(encoding="utf-8")
    dataset_path = os.path.join(
        os.path.dirname(__file__), "..", "datasets", "hanoi_11_orders.json"
    )
    v, d, o, pol, dist, dur, n_map = load_dataset(dataset_path)
    sol = solve_genetic(v, d, o, pol, dist, dur, n_map, time_limit_sec=3.0)
    print(f"=== {sol.solver_name} ===")
    print(f"Thời gian: {sol.execution_time_sec}s")
    print(f"Số xe sử dụng: {len(sol.routes)}")
    print(f"Tổng quãng đường: {sol.total_distance_km} km")
    print(f"Chi phí vận hành thực tế: {sol.real_economic_cost_vnd:,} VNĐ")
    print(f"Tỷ lệ hoàn thành đơn: {sol.fulfillment_rate}% ({len(o) - len(sol.unassigned_orders)}/{len(o)})")
    print(f"Đơn bị bỏ rơi: {sol.unassigned_orders}")
    print(f"Hợp lệ không gian 2D & cửa: {sol.is_spatial_valid} ({sol.spatial_notes})")
    print(f"Tổng hàm mục tiêu có phạt: {sol.penalized_objective_vnd:,} VNĐ")
