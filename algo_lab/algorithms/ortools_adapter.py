"""OR-Tools Adapter for TMS Algorithm Lab.

Solves the Multi-Vehicle Pickup and Delivery Problem using Google OR-Tools Routing Library
with Guided Local Search / Tabu Search, followed by post-validation for 2D Packing & Door Clearance.
"""

import os
import sys
import time
from typing import Dict, List, Optional, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

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


def solve_ortools(
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
    policy: CostPolicy,
    distance_matrix: List[List[float]],
    duration_matrix: List[List[float]],
    node_id_to_index: Dict[str, int],
    max_time_seconds: int = 5,
    local_search_metaheuristic: str = "GUIDED_LOCAL_SEARCH",
) -> OptimizationSolution:
    start_time = time.perf_counter()

    order_by_id = {o.id: o for o in orders}
    cargo_by_id = {it.id: it for o in orders for it in o.items}

    num_vehicles = len(vehicles)
    num_orders = len(orders)
    # Nodes:
    # 0 .. num_vehicles - 1: vehicle start depots
    # num_vehicles .. num_vehicles + 2*num_orders - 1: pickups & deliveries
    # num_vehicles + 2*num_orders .. num_vehicles + 2*num_orders + num_vehicles - 1: vehicle end depots
    starts = list(range(num_vehicles))
    ends = list(range(num_vehicles + 2 * num_orders, num_vehicles + 2 * num_orders + num_vehicles))
    total_nodes = len(ends) + num_vehicles

    # Map node index in OR-Tools model to matrix index
    model_to_matrix: List[int] = []
    # vehicle start depots
    for v in vehicles:
        model_to_matrix.append(node_id_to_index.get(v.depot.id, 0))
    # pickups & deliveries
    for o in orders:
        model_to_matrix.append(node_id_to_index.get(o.pickup_location.id, 0))
        model_to_matrix.append(node_id_to_index.get(o.delivery_location.id, 0))
    # vehicle end depots
    for v in vehicles:
        end_depot_id = v.end_depot.id if v.end_depot else v.depot.id
        model_to_matrix.append(node_id_to_index.get(end_depot_id, 0))

    manager = pywrapcp.RoutingIndexManager(len(model_to_matrix), num_vehicles, starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    # Distance callback
    def distance_callback(from_index: int, to_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        m_from = model_to_matrix[from_node]
        m_to = model_to_matrix[to_node]
        return int(distance_matrix[m_from][m_to])

    transit_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

    # Capacity (weight) dimension
    def demand_callback(from_index: int) -> int:
        from_node = manager.IndexToNode(from_index)
        if from_node < num_vehicles or from_node >= num_vehicles + 2 * num_orders:
            return 0
        order_idx = (from_node - num_vehicles) // 2
        is_pickup = (from_node - num_vehicles) % 2 == 0
        order = orders[order_idx]
        w = int(round(order.total_weight_kg))
        return w if is_pickup else -w

    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,  # null capacity slack
        [int(round(v.payload_limit_kg)) for v in vehicles],  # vehicle maximum capacities
        True,  # start cumul to zero
        "Capacity",
    )

    # Pickup and Delivery constraints
    distance_dimension = routing.GetDimensionOrDie("Capacity")
    for o_idx, o in enumerate(orders):
        pickup_node = num_vehicles + o_idx * 2
        delivery_node = pickup_node + 1
        p_index = manager.NodeToIndex(pickup_node)
        d_index = manager.NodeToIndex(delivery_node)
        routing.AddPickupAndDelivery(p_index, d_index)
        routing.solver().Add(
            routing.VehicleVar(p_index) == routing.VehicleVar(d_index)
        )
        # Pickup before delivery constraint:
        # Distance/Time dimension or routing NextVar constraint
        routing.solver().Add(
            distance_dimension.CumulVar(p_index) <= distance_dimension.CumulVar(d_index)
        )

    # Allow dropping orders with penalty
    drop_penalty = 50_000_000  # large penalty to strongly incentivize serving orders
    for o_idx in range(num_orders):
        p_index = manager.NodeToIndex(num_vehicles + o_idx * 2)
        d_index = manager.NodeToIndex(num_vehicles + o_idx * 2 + 1)
        routing.AddDisjunction([p_index, d_index], drop_penalty, 2)

    # Search parameters
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    )
    if local_search_metaheuristic == "GUIDED_LOCAL_SEARCH":
        search_parameters.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        )
    elif local_search_metaheuristic == "TABU_SEARCH":
        search_parameters.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.TABU_SEARCH
        )
    elif local_search_metaheuristic == "SIMULATED_ANNEALING":
        search_parameters.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.SIMULATED_ANNEALING
        )

    search_parameters.time_limit.seconds = max_time_seconds

    solution = routing.SolveWithParameters(search_parameters)

    unassigned_orders: List[str] = []
    optimized_routes: List[OptimizedRoute] = []
    total_economic_cost = 0
    total_km = 0.0
    all_spatial_valid = True
    spatial_notes_list = []

    if solution:
        served_order_ids = set()
        for v_idx in range(num_vehicles):
            vehicle = vehicles[v_idx]
            driver = drivers[v_idx]
            index = routing.Start(v_idx)
            stops: List[ScheduledStop] = []
            curr_weight = 0.0
            seq = 1

            while not routing.IsEnd(index):
                node = manager.IndexToNode(index)
                if node >= num_vehicles and node < num_vehicles + 2 * num_orders:
                    o_idx = (node - num_vehicles) // 2
                    is_pickup = (node - num_vehicles) % 2 == 0
                    order = orders[o_idx]
                    served_order_ids.add(order.id)

                    if is_pickup:
                        curr_weight += order.total_weight_kg
                        stops.append(
                            ScheduledStop(
                                sequence=seq,
                                stop_type="PICKUP",
                                location_id=order.pickup_location.id,
                                location_name=order.pickup_location.name,
                                order_id=order.id,
                                order_number=order.order_number,
                                current_weight_kg=curr_weight,
                                items_loaded=[it.id for it in order.items],
                            )
                        )
                    else:
                        curr_weight -= order.total_weight_kg
                        stops.append(
                            ScheduledStop(
                                sequence=seq,
                                stop_type="DELIVERY",
                                location_id=order.delivery_location.id,
                                location_name=order.delivery_location.name,
                                order_id=order.id,
                                order_number=order.order_number,
                                current_weight_kg=curr_weight,
                                items_unloaded=[it.id for it in order.items],
                            )
                        )
                    seq += 1
                index = solution.Value(routing.NextVar(index))

            if stops:
                # Validate spatial LIFO door clearance
                checker = FastPackingChecker(vehicle)
                valid, reason = checker.validate_route_stops(stops, cargo_by_id)
                if not valid:
                    all_spatial_valid = False
                    spatial_notes_list.append(f"Xe {vehicle.plate_number}: {reason}")

                # Calculate times
                depot_idx = node_id_to_index.get(vehicle.depot.id, 0)
                curr_time = 0
                prev_node = depot_idx
                for st in stops:
                    curr_node = node_id_to_index.get(st.location_id, 0)
                    transit_sec = duration_matrix[prev_node][curr_node]
                    st.arrival_time_sec = int(curr_time + transit_sec)
                    order = order_by_id[st.order_id]
                    st.departure_time_sec = st.arrival_time_sec + order.service_time_sec
                    curr_time = st.departure_time_sec
                    prev_node = curr_node

                breakdown, dist_km, dur_min = calculate_route_cost(
                    vehicle,
                    driver,
                    stops,
                    order_by_id,
                    policy,
                    distance_matrix,
                    duration_matrix,
                    node_id_to_index,
                )
                optimized_routes.append(
                    OptimizedRoute(
                        vehicle=vehicle,
                        driver=driver,
                        stops=stops,
                        total_distance_km=dist_km,
                        total_duration_minutes=dur_min,
                        cost_breakdown=breakdown,
                    )
                )
                total_economic_cost += breakdown.total_cost_vnd
                total_km += dist_km

        for o in orders:
            if o.id not in served_order_ids:
                unassigned_orders.append(o.order_number)
    else:
        unassigned_orders = [o.order_number for o in orders]

    elapsed = round(time.perf_counter() - start_time, 3)
    unassigned_penalty = len(unassigned_orders) * policy.unassigned_order_penalty_vnd
    penalized_cost = total_economic_cost + unassigned_penalty
    fulfillment = round(
        (len(orders) - len(unassigned_orders)) / max(1, len(orders)) * 100, 1
    )

    notes = "Thỏa mãn xếp dỡ" if all_spatial_valid else "; ".join(spatial_notes_list)

    return OptimizationSolution(
        solver_name=f"Google OR-Tools ({local_search_metaheuristic})",
        execution_time_sec=elapsed,
        routes=optimized_routes,
        unassigned_orders=unassigned_orders,
        real_economic_cost_vnd=total_economic_cost,
        penalized_objective_vnd=penalized_cost,
        total_distance_km=round(total_km, 2),
        fulfillment_rate=fulfillment,
        is_spatial_valid=all_spatial_valid,
        spatial_notes=notes,
    )


if __name__ == "__main__":
    from algo_lab.common.data_loader import load_dataset

    sys.stdout.reconfigure(encoding="utf-8")
    dataset_path = os.path.join(
        os.path.dirname(__file__), "..", "datasets", "hanoi_11_orders.json"
    )
    v, d, o, pol, dist, dur, n_map = load_dataset(dataset_path)
    sol = solve_ortools(v, d, o, pol, dist, dur, n_map, max_time_seconds=3)
    print(f"=== {sol.solver_name} ===")
    print(f"Thời gian: {sol.execution_time_sec}s")
    print(f"Số xe sử dụng: {len(sol.routes)}")
    print(f"Tổng quãng đường: {sol.total_distance_km} km")
    print(f"Chi phí vận hành thực tế: {sol.real_economic_cost_vnd:,} VNĐ")
    print(f"Tỷ lệ hoàn thành đơn: {sol.fulfillment_rate}% ({len(o) - len(sol.unassigned_orders)}/{len(o)})")
    print(f"Đơn bị bỏ rơi: {sol.unassigned_orders}")
    print(f"Hợp lệ không gian 2D & cửa: {sol.is_spatial_valid} ({sol.spatial_notes})")
    print(f"Tổng hàm mục tiêu có phạt: {sol.penalized_objective_vnd:,} VNĐ")
