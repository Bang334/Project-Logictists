"""Greedy Cheapest Insertion solver ported from algo_lab."""

import time
from typing import Dict, List, Optional

from .cost_evaluator import calculate_route_cost
from .models import (
    CostPolicy,
    DriverOption,
    FleetVehicle,
    OptimizationSolution,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
)
from .packing_checker import FastPackingChecker
from .route_evaluator import schedule_and_evaluate_route


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
    vehicle_routes: List[List[ScheduledStop]] = [[] for _ in vehicles]

    for order in sorted_orders:
        best_vehicle_idx: Optional[int] = None
        best_p_pos: Optional[int] = None
        best_d_pos: Optional[int] = None
        best_incremental_cost = float("inf")
        checked_empty_types = set()
        has_empty_vehicles = any(len(r) == 0 for r in vehicle_routes)

        for v_idx, vehicle in enumerate(vehicles):
            current_stops = vehicle_routes[v_idx]
            if len(current_stops) > 0 and has_empty_vehicles:
                cur_orders = len({s.order_id for s in current_stops if s.order_id})
                cur_items = sum(
                    len(order_by_id[s.order_id].items)
                    for s in current_stops
                    if s.order_id and s.stop_type == "PICKUP" and s.order_id in order_by_id
                )
                order_items = len(order.items)
                max_safe_items = 25 if vehicle.payload_limit_kg < 3000 else 38
                max_safe_orders = 12 if vehicle.payload_limit_kg > 5000 else 8
                if (cur_items + order_items > max_safe_items) or (cur_orders >= max_safe_orders):
                    continue
            if len(current_stops) == 0:
                v_type = (
                    vehicle.service_day_index,
                    vehicle.available_start_sec,
                    vehicle.available_end_sec,
                    vehicle.payload_limit_kg,
                    vehicle.length_cm,
                    vehicle.width_cm,
                    vehicle.height_cm,
                    vehicle.depot.id,
                )
                if v_type in checked_empty_types:
                    continue
                checked_empty_types.add(v_type)
                base_route_cost = 0
                shares_source_order = False
            else:
                base_eval = schedule_and_evaluate_route(
                    vehicle,
                    drivers[v_idx],
                    current_stops,
                    order_by_id,
                    cargo_by_id,
                    policy,
                    distance_matrix,
                    duration_matrix,
                    node_id_to_index,
                    use_fast_packing=False,
                )
                base_route_cost = (
                    base_eval.cost.total_cost_vnd
                    if base_eval.feasible and base_eval.cost is not None
                    else 0
                )
                target_source = order.source_order_id or order.id
                shares_source_order = (
                    any(
                        (order_by_id[s.order_id].source_order_id or s.order_id) == target_source
                        for s in current_stops
                        if s.order_id and s.order_id in order_by_id
                    )
                )

            # Keep a cheap conservative seed; layout search remains available
            # in the improvement neighborhoods without replacing this fallback.
            checker = FastPackingChecker(vehicle, allow_layout_search=False)

            depot_idx = node_id_to_index.get(vehicle.depot.id, 0)

            # Try inserting Pickup at pos i, Delivery at pos j (j > i)
            n = len(current_stops)
            if n <= 12:
                positions = [(i, j) for i in range(n + 1) for j in range(i + 1, n + 2)]
            else:
                anchor_indices = sorted({0, n // 4, n // 2, (3 * n) // 4, max(0, n - 2), n})
                pos_set = set()
                for i in anchor_indices:
                    for j in [i + 1, (i + 1 + n) // 2, n + 1]:
                        if j > i and j <= n + 1:
                            pos_set.add((i, j))
                pos_set.add((n, n + 1))
                pos_set.add((0, n + 1))
                positions = sorted(pos_set)
            temporal_candidates = []
            for pos_idx, (i, j) in enumerate(positions):
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

                cand_cost = (
                    (eval_res.cost.total_cost_vnd - base_route_cost)
                    if eval_res.cost
                    else float("inf")
                )
                if len(current_stops) == 0:
                    cand_cost += 1_000_000 + vehicle.service_day_index * 50_000
                elif shares_source_order:
                    cand_cost -= 2_000_000

                if cand_cost < best_incremental_cost:
                    temporal_candidates.append(
                        (cand_cost, pos_idx, i, j, candidate_stops)
                    )

            temporal_candidates.sort(key=lambda item: (item[0], item[1]))
            for cand_cost, _, i, j, candidate_stops in temporal_candidates:
                if cand_cost >= best_incremental_cost:
                    break
                valid_packing, _ = checker.validate_route_stops(
                    candidate_stops, cargo_by_id
                )
                if valid_packing:
                    best_incremental_cost = cand_cost
                    best_vehicle_idx = v_idx
                    best_p_pos = i
                    best_d_pos = j
                    break

        if best_vehicle_idx is not None:
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
