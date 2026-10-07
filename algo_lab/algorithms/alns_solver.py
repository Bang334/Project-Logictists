"""Adaptive Large Neighborhood Search (ALNS) for TMS.

State-of-the-art metaheuristic for VRP with integrated 2D Packing & LIFO Door Clearance.
Iteratively destroys (removes orders) and repairs (re-inserts orders) while strictly maintaining
feasibility of door clearance and vehicle capacity.
"""

import copy
import math
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
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from algo_lab.common.packing_checker import FastPackingChecker
from algo_lab.common.route_evaluator import schedule_and_evaluate_route
from algo_lab.common.solution_validator import audit_solution
from algo_lab.algorithms.greedy_insertion import solve_greedy


class ALNSSolver:
    def __init__(
        self,
        vehicles: List[FleetVehicle],
        drivers: List[DriverOption],
        orders: List[OrderPair],
        policy: CostPolicy,
        distance_matrix: List[List[float]],
        duration_matrix: List[List[float]],
        node_id_to_index: Dict[str, int],
        max_iterations: int = 150,
        time_limit_sec: float = 10.0,
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
        self.max_iterations = max_iterations
        self.time_limit_sec = time_limit_sec
        self.checkers = [FastPackingChecker(v) for v in vehicles]
        self._packing_cache: Dict[Tuple[str, Tuple[Tuple[str, str], ...]], bool] = {}

    def _validate_stops_cached(self, v_idx: int, cand_stops: List[ScheduledStop]) -> bool:
        v = self.vehicles[v_idx]
        cache_key = (
            v.id,
            tuple((st.order_id, st.stop_type) for st in cand_stops if st.order_id),
        )
        if cache_key in self._packing_cache:
            return self._packing_cache[cache_key]
        valid, _ = self.checkers[v_idx].validate_route_stops(cand_stops, self.cargo_by_id)
        self._packing_cache[cache_key] = valid
        return valid

    def _evaluate_plan_cost(
        self, routes_stops: List[List[ScheduledStop]], unassigned_ids: List[str]
    ) -> Tuple[int, int, float]:
        """Calculates (penalized_cost, real_economic_cost, total_km)."""
        economic_cost = 0
        total_km = 0.0

        for v_idx, stops in enumerate(routes_stops):
            if not stops:
                continue
            v = self.vehicles[v_idx]
            d = self.drivers[v_idx]
            eval_res = schedule_and_evaluate_route(
                v,
                d,
                stops,
                self.order_by_id,
                self.cargo_by_id,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
                use_fast_packing=False,
            )
            if not eval_res.feasible or not eval_res.cost:
                return 999_999_999, 999_999_999, 0.0
            economic_cost += eval_res.cost.total_cost_vnd
            total_km += eval_res.distance_km

        penalized_cost = economic_cost + len(unassigned_ids) * self.policy.unassigned_order_penalty_vnd
        return penalized_cost, economic_cost, total_km

    def _can_insert_order(
        self,
        v_idx: int,
        current_stops: List[ScheduledStop],
        order: OrderPair,
        p_pos: int,
        d_pos: int,
    ) -> Tuple[bool, List[ScheduledStop]]:
        """Checks weight capacity & 2D door clearance feasibility."""
        v = self.vehicles[v_idx]
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

        cand_stops = (
            current_stops[:p_pos]
            + [p_stop]
            + current_stops[p_pos : d_pos - 1]
            + [d_stop]
            + current_stops[d_pos - 1 :]
        )

        # 1. Temporal & Capacity validation
        eval_res = schedule_and_evaluate_route(
            v,
            self.drivers[v_idx],
            cand_stops,
            self.order_by_id,
            self.cargo_by_id,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
            use_fast_packing=False,
        )
        if not eval_res.feasible:
            return False, []

        # 2. Packing & LIFO door clearance check
        if not self._validate_stops_cached(v_idx, cand_stops):
            return False, []

        return True, cand_stops

    def _repair_greedy_insert(
        self,
        routes_stops: List[List[ScheduledStop]],
        unassigned_ids: List[str],
        start_time: Optional[float] = None,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Inserts unassigned orders into best feasible positions."""
        still_unassigned = []
        orders_to_insert = [self.order_by_id[oid] for oid in unassigned_ids]
        random.shuffle(orders_to_insert)

        for order in orders_to_insert:
            if start_time is not None and time.perf_counter() - start_time >= self.time_limit_sec:
                still_unassigned.append(order.id)
                continue

            best_cost = float("inf")
            best_v_idx: Optional[int] = None
            best_cand_stops: Optional[List[ScheduledStop]] = None
            checked_empty_types = set()

            for v_idx in range(len(self.vehicles)):
                curr_stops = routes_stops[v_idx]
                if len(curr_stops) == 0:
                    v = self.vehicles[v_idx]
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
                depot_idx = self.node_id_to_index.get(self.vehicles[v_idx].depot.id, 0)
                if len(curr_stops) > 0:
                    prev_n = depot_idx
                    for st in curr_stops:
                        cur_n = self.node_id_to_index.get(st.location_id, 0)
                        base_dist += self.distance_matrix[prev_n][cur_n]
                        prev_n = cur_n
                    base_dist += self.distance_matrix[prev_n][depot_idx]

                n = len(curr_stops)
                # Nếu tuyến quá dài, ưu tiên chèn vào đuôi hoặc các vị trí gần cuối để giảm số phép thử
                if n <= 4:
                    positions = [(i, j) for i in range(n + 1) for j in range(i + 1, n + 2)]
                else:
                    positions = [(n, n + 1), (0, n + 1), (max(0, n - 2), n + 1)]

                for i, j in positions:
                    feasible, cand_stops = self._can_insert_order(
                        v_idx, curr_stops, order, i, j
                    )
                    if feasible:
                        v = self.vehicles[v_idx]
                        cand_dist = 0.0
                        prev = depot_idx
                        for st in cand_stops:
                            cur = self.node_id_to_index.get(st.location_id, 0)
                            cand_dist += self.distance_matrix[prev][cur]
                            prev = cur
                        cand_dist += self.distance_matrix[prev][depot_idx]

                        inc_dist_m = max(0.0, cand_dist - base_dist)
                        inc_dist_km = inc_dist_m / 1000.0
                        inc_fuel = (
                            (v.fuel_consumption_liters_per_100_km / 100.0)
                            * inc_dist_km
                            * self.policy.fuel_price_per_liter_vnd
                        )
                        inc_fixed = (
                            v.fixed_operating_cost_vnd if len(curr_stops) == 0 else 0
                        )
                        inc_driver = (
                            150_000 if len(curr_stops) == 0 else 0
                        ) + round(1_200 * inc_dist_km)
                        inc_cost = inc_fuel + inc_fixed + inc_driver

                        if inc_cost < best_cost:
                            best_cost = inc_cost
                            best_v_idx = v_idx
                            best_cand_stops = cand_stops

            if best_v_idx is not None and best_cand_stops is not None:
                routes_stops[best_v_idx] = best_cand_stops
            else:
                still_unassigned.append(order.id)

        return routes_stops, still_unassigned

    def _destroy_random(
        self,
        routes_stops: List[List[ScheduledStop]],
        num_remove: int,
    ) -> Tuple[List[List[ScheduledStop]], List[str]]:
        """Removes random orders from routes."""
        all_assigned = []
        for v_idx, stops in enumerate(routes_stops):
            for st in stops:
                if st.stop_type == "PICKUP" and st.order_id:
                    all_assigned.append((st.order_id, v_idx))

        if not all_assigned:
            return routes_stops, []

        remove_orders = {
            item[0]
            for item in random.sample(
                all_assigned, min(num_remove, len(all_assigned))
            )
        }

        new_routes = []
        for stops in routes_stops:
            filtered = [s for s in stops if s.order_id not in remove_orders]
            new_routes.append(filtered)

        return new_routes, list(remove_orders)

    def solve(self) -> OptimizationSolution:
        # 1. Initial solution: construct feasible base plan using greedy seed
        sol_gr = solve_greedy(
            self.vehicles,
            self.drivers,
            self.orders,
            self.policy,
            self.distance_matrix,
            self.duration_matrix,
            self.node_id_to_index,
        )
        current_routes = [[] for _ in self.vehicles]
        veh_id_to_idx = {v.id: idx for idx, v in enumerate(self.vehicles)}
        for r in sol_gr.routes:
            v_idx = veh_id_to_idx.get(r.vehicle.id, 0)
            current_routes[v_idx] = copy.deepcopy(r.stops)

        assigned = set(
            st.order_id
            for r in current_routes
            for st in r
            if st.stop_type == "PICKUP" and st.order_id
        )
        current_unassigned = [o.id for o in self.orders if o.id not in assigned]

        start_time = time.perf_counter()

        best_routes = copy.deepcopy(current_routes)
        best_unassigned = list(current_unassigned)
        best_penalized_cost, best_econ_cost, best_km = self._evaluate_plan_cost(
            best_routes, best_unassigned
        )
        curr_penalized_cost = best_penalized_cost

        # Simulated Annealing parameters
        temperature = 500_000.0
        cooling_rate = 0.96

        iteration = 0
        while iteration < self.max_iterations:
            if time.perf_counter() - start_time >= self.time_limit_sec:
                break
            iteration += 1

            # Destroy 1 to 3 orders
            num_to_remove = random.randint(1, max(1, min(3, len(self.orders) // 3)))
            destroyed_routes, removed_ids = self._destroy_random(
                copy.deepcopy(current_routes), num_to_remove
            )
            pool = list(set(current_unassigned + removed_ids))

            # Repair
            repaired_routes, new_unassigned = self._repair_greedy_insert(
                destroyed_routes, pool, start_time=start_time
            )
            new_cost, _, _ = self._evaluate_plan_cost(repaired_routes, new_unassigned)

            # Accept criterion
            delta = new_cost - curr_penalized_cost
            if delta < 0 or random.random() < math.exp(-delta / max(1.0, temperature)):
                current_routes = repaired_routes
                current_unassigned = new_unassigned
                curr_penalized_cost = new_cost

                if curr_penalized_cost < best_penalized_cost:
                    best_routes = copy.deepcopy(current_routes)
                    best_unassigned = list(current_unassigned)
                    best_penalized_cost = curr_penalized_cost

            temperature *= cooling_rate

        # Finalize solution
        final_penalized_cost, final_econ_cost, final_km = self._evaluate_plan_cost(
            best_routes, best_unassigned
        )
        optimized_routes: List[OptimizedRoute] = []

        for v_idx, stops in enumerate(best_routes):
            if not stops:
                continue
            v = self.vehicles[v_idx]
            d = self.drivers[v_idx]

            eval_res = schedule_and_evaluate_route(
                v,
                d,
                stops,
                self.order_by_id,
                self.cargo_by_id,
                self.policy,
                self.distance_matrix,
                self.duration_matrix,
                self.node_id_to_index,
                use_fast_packing=True,
            )
            if not eval_res.feasible or not eval_res.cost:
                continue

            optimized_routes.append(
                OptimizedRoute(
                    vehicle=v,
                    driver=d,
                    stops=eval_res.stops,
                    total_distance_km=eval_res.distance_km,
                    total_duration_minutes=eval_res.duration_minutes,
                    cost_breakdown=eval_res.cost,
                )
            )

        elapsed = round(time.perf_counter() - start_time, 3)
        unassigned_numbers = [self.order_by_id[oid].order_number for oid in best_unassigned]
        fulfillment = round(
            (len(self.orders) - len(best_unassigned)) / max(1, len(self.orders)) * 100, 1
        )

        solution = OptimizationSolution(
            solver_name=f"ALNS (Adaptive Large Neighborhood Search, {iteration} iters)",
            execution_time_sec=elapsed,
            routes=optimized_routes,
            unassigned_orders=unassigned_numbers,
            real_economic_cost_vnd=final_econ_cost,
            penalized_objective_vnd=final_penalized_cost,
            total_distance_km=round(final_km, 2),
            fulfillment_rate=fulfillment,
            is_spatial_valid=True,
            spatial_notes="100% hợp lệ: LIFO & Door Clearance được kiểm tra tại từng bước Repair",
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
            spatial_time_limit_sec=1.5,
        )
        solution.execution_time_sec = round(time.perf_counter() - start_time, 3)
        return solution


def solve_alns(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    time_limit_sec: float = 2.0,
) -> OptimizationSolution:
    solver = ALNSSolver(
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
    sol = solve_alns(v, d, o, pol, dist, dur, n_map, time_limit_sec=2.0)
    print(f"=== {sol.solver_name} ===")
    print(f"Thời gian: {sol.execution_time_sec}s")
    print(f"Số xe sử dụng: {len(sol.routes)}")
    print(f"Tổng quãng đường: {sol.total_distance_km} km")
    print(f"Chi phí vận hành thực tế: {sol.real_economic_cost_vnd:,} VNĐ")
    print(f"Tỷ lệ hoàn thành đơn: {sol.fulfillment_rate}% ({len(o) - len(sol.unassigned_orders)}/{len(o)})")
    print(f"Đơn bị bỏ rơi: {sol.unassigned_orders}")
    print(f"Hợp lệ không gian 2D & cửa: {sol.is_spatial_valid} ({sol.spatial_notes})")
    print(f"Tổng hàm mục tiêu có phạt: {sol.penalized_objective_vnd:,} VNĐ")
