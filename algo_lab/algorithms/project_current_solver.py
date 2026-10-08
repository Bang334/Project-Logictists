"""Adapter to run the Project's Current Optimizer (FleetRoutingSolver) within the Algo Lab benchmark suite."""

import copy
import json
import os
import sys
import time
from typing import Dict, List, Optional, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
optimizer_root = os.path.join(project_root, "optimizer")
if optimizer_root not in sys.path:
    sys.path.insert(0, optimizer_root)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from app.models import FleetOptimizationRequest
from app.routing_solver import FleetRoutingSolver

from algo_lab.common.models import (
    OptimizationSolution,
    OptimizedRoute,
    ScheduledStop,
    RouteCostBreakdown,
    FleetVehicle,
    DriverOption,
    OrderPair,
    CostPolicy,
)
from algo_lab.common.packing_checker import FastPackingChecker


def solve_current_project(
    raw_payload_dict: dict,
    vehicles: List[FleetVehicle],
    drivers: List[DriverOption],
    orders: List[OrderPair],
) -> OptimizationSolution:
    """Runs the current project's FleetRoutingSolver and converts to lab OptimizationSolution format."""
    start_time = time.perf_counter()
    
    # Deep copy payload to prevent side effects
    payload = copy.deepcopy(raw_payload_dict)
    
    # 1. Instantiate current project solver request
    req = FleetOptimizationRequest(**payload)
    solver = FleetRoutingSolver(req)
    
    # 2. Run solve
    res = solver.solve()
    runtime = time.perf_counter() - start_time
    
    # 3. Extract metrics
    unassigned_order_numbers = [u.order_number for u in res.unassigned_orders]
    
    # Convert routes
    optimized_routes: List[OptimizedRoute] = []
    cargo_by_id = {it.id: it for o in orders for it in o.items}
    vehicle_by_id = {v.id: v for v in vehicles}
    driver_by_id = {d.id: d for d in drivers}
    order_by_id = {o.id: o for o in orders}
    
    all_routes_valid_packing = True
    
    for route_index, r in enumerate(res.routes):
        # Check spatial validity from current project response
        is_route_valid = r.spatial_validation.is_valid if hasattr(r, "spatial_validation") and r.spatial_validation else True
        if not is_route_valid:
            all_routes_valid_packing = False
            
        stops = [
            ScheduledStop(
                sequence=s.sequence,
                stop_type=s.stop_type,
                location_id=s.location_id,
                location_name=s.location_name,
                order_id=s.order_id,
                order_number=(
                    order_by_id[s.order_id].order_number
                    if s.order_id in order_by_id
                    else s.order_id
                ),
                items_loaded=s.items_loaded,
                items_unloaded=s.items_unloaded,
                current_weight_kg=s.current_weight_kg,
            )
            for s in r.stops
        ]
        
        # Double check with FastPackingChecker if needed
        v_obj = vehicle_by_id.get(r.vehicle_id, vehicles[0] if vehicles else None)
        driver_obj = driver_by_id.get(r.driver_id or "")
        if driver_obj is None and route_index < len(drivers):
            driver_obj = drivers[route_index]
        if driver_obj is None:
            raise ValueError(f"Không tìm thấy tài xế cho tuyến xe {r.vehicle_id}")
        if v_obj:
            checker = FastPackingChecker(v_obj)
            pack_ok, _ = checker.validate_route_stops(stops, cargo_by_id)
            if not pack_ok:
                all_routes_valid_packing = False
                
        c_cost = r.cost.total_cost_vnd if r.cost else 0
        optimized_routes.append(
            OptimizedRoute(
                vehicle=v_obj,
                driver=driver_obj,
                stops=stops,
                cost_breakdown=RouteCostBreakdown(
                    base_fuel_cost_vnd=r.cost.base_fuel_cost_vnd if r.cost else 0,
                    load_fuel_surcharge_vnd=r.cost.load_fuel_surcharge_vnd if r.cost else 0,
                    fuel_cost_vnd=r.cost.fuel_cost_vnd if r.cost else 0,
                    fixed_vehicle_cost_vnd=r.cost.vehicle_fixed_cost_vnd if r.cost else 0,
                    driver_salary_allocation_vnd=r.cost.driver_fixed_salary_allocation_vnd if r.cost else 0,
                    driver_trip_pay_vnd=r.cost.driver_trip_pay_vnd if r.cost else 0,
                    cargo_holding_cost_vnd=r.cost.cargo_holding_cost_vnd if r.cost else 0,
                    late_delivery_penalty_vnd=r.cost.late_delivery_penalty_vnd if r.cost else 0,
                    total_cost_vnd=c_cost,
                ),
                total_distance_km=r.total_distance_km,
                total_duration_minutes=r.total_duration_minutes,
            )
        )
        
    total_orders_count = len(orders)
    served_count = total_orders_count - len(unassigned_order_numbers)
    fulfill_rate = (
        (served_count / total_orders_count) * 100.0
        if total_orders_count > 0
        else 100.0
    )

    return OptimizationSolution(
        solver_name="Thuật toán Hiện tại của Project",
        execution_time_sec=runtime,
        routes=optimized_routes,
        unassigned_orders=unassigned_order_numbers,
        real_economic_cost_vnd=res.total_cost_vnd,
        penalized_objective_vnd=res.total_cost_vnd,
        total_distance_km=res.total_distance_km,
        fulfillment_rate=fulfill_rate,
        is_spatial_valid=all_routes_valid_packing,
        spatial_notes="PASS" if all_routes_valid_packing else "FAIL",
    )
