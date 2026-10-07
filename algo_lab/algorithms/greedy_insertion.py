import os
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


def solve_greedy(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
) -> OptimizationSolution:
    start_time = time.perf_counter()

    order_by_id = {o.id: o for o in orders}
    cargo_by_id = {it.id: it for o in orders for it in o.items}

    # Sort orders: largest weight / volume first to pack harder items early
    sorted_orders = sorted(
        orders, key=lambda o: (o.total_weight_kg, o.total_volume_m3), reverse=True
    )

    unassigned_orders: List[str] = []
    # vehicle_routes: list of ScheduledStop for each vehicle
    vehicle_routes: List[List[ScheduledStop]] = [[] for _ in vehicles]

    for order in sorted_orders:
        best_vehicle_idx: Optional[int] = None
        best_p_pos: Optional[int] = None
        best_d_pos: Optional[int] = None
        best_incremental_cost = float("inf")
        checked_empty_types = set()

        for v_idx, vehicle in enumerate(vehicles):
            current_stops = vehicle_routes[v_idx]
            if len(current_stops) == 0:
                v_type = (
                    vehicle.payload_limit_kg,
                    vehicle.length_cm,
                    vehicle.width_cm,
                    vehicle.height_cm,
                    vehicle.depot.id,
                )
                if v_type in checked_empty_types:
                    continue
                checked_empty_types.add(v_type)

            checker = FastPackingChecker(vehicle)

            depot_idx = node_id_to_index.get(vehicle.depot.id, 0)
            base_dist = 0.0
            if len(current_stops) > 0:
                prev_n = depot_idx
                for st in current_stops:
                    cur_n = node_id_to_index.get(st.location_id, 0)
                    base_dist += distance_matrix[prev_n][cur_n]
                    prev_n = cur_n
                base_dist += distance_matrix[prev_n][depot_idx]

            # Try inserting Pickup at pos i, Delivery at pos j (j > i)
            n = len(current_stops)
            if n <= 6:
                positions = [(i, j) for i in range(n + 1) for j in range(i + 1, n + 2)]
            else:
                positions = [
                    (n, n + 1),
                    (0, n + 1),
                    (max(0, n - 2), n + 1),
                    (n // 2, n + 1),
                ]
            for i, j in positions:
                    # Construct candidate stops
                    candidate_stops: List[ScheduledStop] = []
                    pickup_stop = ScheduledStop(
                        sequence=0,
                        stop_type="PICKUP",
                        location_id=order.pickup_location.id,
                        location_name=order.pickup_location.name,
                        order_id=order.id,
                        order_number=order.order_number,
                        items_loaded=[it.id for it in order.items],
                        items_unloaded=[],
                    )
                    delivery_stop = ScheduledStop(
                        sequence=0,
                        stop_type="DELIVERY",
                        location_id=order.delivery_location.id,
                        location_name=order.delivery_location.name,
                        order_id=order.id,
                        order_number=order.order_number,
                        items_loaded=[],
                        items_unloaded=[it.id for it in order.items],
                    )

                    candidate_stops = (
                        current_stops[:i]
                        + [pickup_stop]
                        + current_stops[i : j - 1]
                        + [delivery_stop]
                        + current_stops[j - 1 :]
                    )

                    # 1. Temporal & Capacity validation
                    eval_res = schedule_and_evaluate_route(
                        vehicle,
                        drivers[v_idx],
                        candidate_stops,
                        order_by_id,
                        cargo_by_id,
                        policy,
                        distance_matrix,
                        duration_matrix,
                        node_id_to_index,
                        use_fast_packing=False,
                    )
                    if not eval_res.feasible:
                        continue

                    # 2. Packing & Door clearance check
                    valid_packing, _ = checker.validate_route_stops(
                        candidate_stops, cargo_by_id
                    )
                    if not valid_packing:
                        continue

                    # 3. Calculate incremental economic cost
                    inc_cost = eval_res.cost.total_cost_vnd if eval_res.cost else float("inf")

                    if inc_cost < best_incremental_cost:
                        best_incremental_cost = inc_cost
                        best_vehicle_idx = v_idx
                        best_p_pos = i
                        best_d_pos = j

        if best_vehicle_idx is not None:
            # Apply best insertion
            current_stops = vehicle_routes[best_vehicle_idx]
            p_stop = ScheduledStop(
                sequence=0,
                stop_type="PICKUP",
                location_id=order.pickup_location.id,
                location_name=order.pickup_location.name,
                order_id=order.id,
                order_number=order.order_number,
                items_loaded=[it.id for it in order.items],
                items_unloaded=[],
            )
            d_stop = ScheduledStop(
                sequence=0,
                stop_type="DELIVERY",
                location_id=order.delivery_location.id,
                location_name=order.delivery_location.name,
                order_id=order.id,
                order_number=order.order_number,
                items_loaded=[],
                items_unloaded=[it.id for it in order.items],
            )
            new_stops = (
                current_stops[:best_p_pos]
                + [p_stop]
                + current_stops[best_p_pos : best_d_pos - 1]
                + [d_stop]
                + current_stops[best_d_pos - 1 :]
            )
            vehicle_routes[best_vehicle_idx] = new_stops
        else:
            unassigned_orders.append(order.order_number)

    # Finalize schedule & costs
    optimized_routes: List[OptimizedRoute] = []
    total_economic_cost = 0
    total_km = 0.0

    for v_idx, stops in enumerate(vehicle_routes):
        if not stops:
            continue
        vehicle = vehicles[v_idx]
        driver = drivers[v_idx]

        eval_res = schedule_and_evaluate_route(
            vehicle,
            driver,
            stops,
            order_by_id,
            cargo_by_id,
            policy,
            distance_matrix,
            duration_matrix,
            node_id_to_index,
            use_fast_packing=True,
        )
        if eval_res.feasible and eval_res.cost:
            optimized_routes.append(
                OptimizedRoute(
                    vehicle=vehicle,
                    driver=driver,
                    stops=eval_res.stops,
                    total_distance_km=eval_res.distance_km,
                    total_duration_minutes=eval_res.duration_minutes,
                    cost_breakdown=eval_res.cost,
                )
            )
            total_economic_cost += eval_res.cost.total_cost_vnd
            total_km += eval_res.distance_km

    elapsed = round(time.perf_counter() - start_time, 3)
    unassigned_penalty = len(unassigned_orders) * policy.unassigned_order_penalty_vnd
    penalized_cost = total_economic_cost + unassigned_penalty
    fulfillment = round(
        (len(orders) - len(unassigned_orders)) / max(1, len(orders)) * 100, 1
    )

    return OptimizationSolution(
        solver_name="Greedy Cheapest Insertion (Integrated LIFO)",
        execution_time_sec=elapsed,
        routes=optimized_routes,
        unassigned_orders=unassigned_orders,
        real_economic_cost_vnd=total_economic_cost,
        penalized_objective_vnd=penalized_cost,
        total_distance_km=round(total_km, 2),
        fulfillment_rate=fulfillment,
        is_spatial_valid=True,
        spatial_notes="Đã kiểm tra và đảm bảo không gian 2D + thông lối cửa ở mọi bước chèn",
    )


if __name__ == "__main__":
    import os
    import sys
    from algo_lab.common.data_loader import load_dataset

    sys.stdout.reconfigure(encoding="utf-8")
    dataset_path = os.path.join(
        os.path.dirname(__file__), "..", "datasets", "hanoi_11_orders.json"
    )
    v, d, o, pol, dist, dur, n_map = load_dataset(dataset_path)
    sol = solve_greedy(v, d, o, pol, dist, dur, n_map)
    print(f"=== {sol.solver_name} ===")
    print(f"Thời gian: {sol.execution_time_sec}s")
    print(f"Số xe sử dụng: {len(sol.routes)}")
    print(f"Tổng quãng đường: {sol.total_distance_km} km")
    print(f"Chi phí vận hành thực tế: {sol.real_economic_cost_vnd:,} VNĐ")
    print(f"Tỷ lệ hoàn thành đơn: {sol.fulfillment_rate}% ({len(o) - len(sol.unassigned_orders)}/{len(o)})")
    print(f"Đơn bị bỏ rơi: {sol.unassigned_orders}")
    print(f"Tổng hàm mục tiêu có phạt: {sol.penalized_objective_vnd:,} VNĐ")
