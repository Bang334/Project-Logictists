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
from algo_lab.common.route_evaluator import schedule_and_evaluate_route
from algo_lab.common.solution_validator import audit_solution


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
        random_seed: int = 0,
        final_spatial_time_limit_sec: float = 1.5,
    ):
        if time_limit_sec <= 0:
            raise ValueError("time_limit_sec must be greater than zero")
        if final_spatial_time_limit_sec <= 0:
            raise ValueError("final_spatial_time_limit_sec must be greater than zero")
        if population_size < 2:
            raise ValueError("population_size must be at least two")
        if generations <= 0:
            raise ValueError("generations must be greater than zero")
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
        self.random_seed = random_seed
        self.final_spatial_time_limit_sec = final_spatial_time_limit_sec
        self.rng = random.Random(random_seed)

    @staticmethod
    def _candidate_positions(route_length: int) -> List[Tuple[int, int]]:
        if route_length <= 10:
            return [
                (pickup, delivery)
                for pickup in range(route_length + 1)
                for delivery in range(pickup + 1, route_length + 2)
            ]
        anchors = sorted(
            {
                0,
                route_length,
                route_length // 4,
                route_length // 2,
                (3 * route_length) // 4,
            }
        )
        positions = {
            (pickup, min(delivery, route_length + 1))
            for pickup in anchors
            for delivery in anchors + [route_length + 1]
            if delivery > pickup
        }
        positions.update(
            (pickup, min(route_length + 1, pickup + 1)) for pickup in anchors
        )
        return sorted(positions)

    def _decode_chromosome(
        self, chromosome: List[str], deadline: float
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Greedily decodes order sequence into vehicle routes."""
        routes_stops: List[List[ScheduledStop]] = [[] for _ in self.vehicles]
        unassigned: List[str] = []

        for order_index, order_id in enumerate(chromosome):
            if time.perf_counter() >= deadline:
                unassigned.extend(chromosome[order_index:])
                break
            order = self.order_by_id[order_id]
            best_v: Optional[int] = None
            best_stops: Optional[List[ScheduledStop]] = None
            best_cost = float("inf")
            checked_empty_types = set()

            for v_idx, v in enumerate(self.vehicles):
                if time.perf_counter() >= deadline:
                    break
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

                if curr:
                    base_evaluation = schedule_and_evaluate_route(
                        v,
                        self.drivers[v_idx],
                        curr,
                        self.order_by_id,
                        self.cargo_by_id,
                        self.policy,
                        self.distance_matrix,
                        self.duration_matrix,
                        self.node_id_to_index,
                    )
                    if not base_evaluation.feasible or base_evaluation.cost is None:
                        continue
                    base_cost = base_evaluation.cost.total_cost_vnd
                else:
                    base_cost = 0

                for pickup_pos, delivery_pos in self._candidate_positions(len(curr)):
                    if time.perf_counter() >= deadline:
                        break
                    cand = (
                        curr[:pickup_pos]
                        + [copy.deepcopy(p_stop)]
                        + curr[pickup_pos : delivery_pos - 1]
                        + [copy.deepcopy(d_stop)]
                        + curr[delivery_pos - 1 :]
                    )
                    evaluation = schedule_and_evaluate_route(
                        v,
                        self.drivers[v_idx],
                        cand,
                        self.order_by_id,
                        self.cargo_by_id,
                        self.policy,
                        self.distance_matrix,
                        self.duration_matrix,
                        self.node_id_to_index,
                    )
                    if not evaluation.feasible or evaluation.cost is None:
                        continue
                    incremental_cost = evaluation.cost.total_cost_vnd - base_cost
                    if incremental_cost < best_cost:
                        best_cost = incremental_cost
                        best_v = v_idx
                        best_stops = evaluation.stops

            if best_v is not None and best_stops is not None:
                routes_stops[best_v] = best_stops
            else:
                unassigned.append(order_id)

        return routes_stops, unassigned

    def _fitness(
        self, chromosome: List[str], deadline: float
    ) -> Tuple[float, List[List[ScheduledStop]], List[str]]:
        routes_stops, unassigned = self._decode_chromosome(chromosome, deadline)
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
        if size < 2:
            return list(parent1)
        a, b = sorted(self.rng.sample(range(size), 2))
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
            i, j = self.rng.sample(range(len(c)), 2)
            c[i], c[j] = c[j], c[i]
        return c

    def solve(self) -> OptimizationSolution:
        start_time = time.perf_counter()
        deadline = start_time + self.time_limit_sec
        order_ids = [o.id for o in self.orders]

        # Initialize population
        population: List[List[str]] = []
        for _ in range(self.population_size):
            ind = list(order_ids)
            self.rng.shuffle(ind)
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

        best_cost, best_routes, best_unassigned = self._fitness(
            elite_seed, deadline
        )

        for gen in range(self.generations):
            if time.perf_counter() - start_time >= self.time_limit_sec:
                break

            scored_pop = []
            for ind in population:
                if time.perf_counter() - start_time >= self.time_limit_sec and scored_pop:
                    break
                cost, r, u = self._fitness(ind, deadline)
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
                p1 = min(self.rng.sample(scored_pop, tour_k), key=lambda x: x[0])[1]
                p2 = min(self.rng.sample(scored_pop, tour_k), key=lambda x: x[0])[1]

                child = self._ox_crossover(p1, p2)
                if self.rng.random() < 0.25:
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

            evaluation = schedule_and_evaluate_route(
                v,
                d,
                stops,
                self.order_by_id,
                self.cargo_by_id,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
            )
            if not evaluation.feasible or evaluation.cost is None:
                best_unassigned.extend(
                    stop.order_id
                    for stop in stops
                    if stop.stop_type == "PICKUP" and stop.order_id
                )
                continue
            optimized_routes.append(
                OptimizedRoute(
                    vehicle=v,
                    driver=d,
                    stops=evaluation.stops,
                    total_distance_km=evaluation.distance_km,
                    total_duration_minutes=evaluation.duration_minutes,
                    cost_breakdown=evaluation.cost,
                )
            )
            total_econ += evaluation.cost.total_cost_vnd
            total_km += evaluation.distance_km

        elapsed = round(time.perf_counter() - start_time, 3)
        best_unassigned = list(dict.fromkeys(best_unassigned))
        unassigned_numbers = [self.order_by_id[oid].order_number for oid in best_unassigned]
        fulfillment = round(
            (len(self.orders) - len(best_unassigned)) / max(1, len(self.orders)) * 100, 1
        )

        solution = OptimizationSolution(
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
            random_seed=self.random_seed,
        )
        audit_solution(
            solution,
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
            spatial_time_limit_sec=self.final_spatial_time_limit_sec,
        )
        solution.execution_time_sec = round(time.perf_counter() - start_time, 3)
        return solution


def solve_genetic(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    time_limit_sec: float = 3.0,
    random_seed: int = 0,
    final_spatial_time_limit_sec: float = 1.5,
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
        random_seed=random_seed,
        final_spatial_time_limit_sec=final_spatial_time_limit_sec,
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
