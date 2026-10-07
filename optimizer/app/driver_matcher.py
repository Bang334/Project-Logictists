"""Optimal Driver-to-Vehicle Matching Module using Hungarian Algorithm (Scipy linear_sum_assignment).

Replaces slow O(N!) itertools.permutations with exact O(V^3) bipartite matching in <1ms,
guaranteeing lowest total driver wage cost while strictly adhering to Vietnamese driver license classes:
- B2: Payload <= 3,500 kg
- C: Payload > 3,500 kg (up to 16,000 kg) & B2
- FC: Tractor-trailer / Container & C, B2
"""

from typing import Dict, List, Optional, Tuple
import numpy as np
from scipy.optimize import linear_sum_assignment

from .models import (
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    OptimizedRoute,
    can_driver_drive_vehicle,
)
from .route_costing import calculate_driver_cost

INF_PENALTY = 10**15


class DriverMatcher:
    def __init__(self, request: FleetOptimizationRequest):
        self.request = request
        self.vehicle_by_id: Dict[str, FleetVehicle] = {v.id: v for v in request.vehicles}
        self.driver_by_id: Dict[str, DriverOption] = {d.id: d for d in request.drivers}

    def assign_drivers_to_routes(self, routes: List[OptimizedRoute]) -> List[OptimizedRoute]:
        """Assigns the lowest-wage legal drivers to all optimized routes using Min-Cost Bipartite Matching."""
        if not routes or not self.request.drivers:
            return routes

        # Group routes and drivers by service_day_index
        day_indices = sorted({r.service_day_index for r in routes})

        for day in day_indices:
            day_routes = [r for r in routes if r.service_day_index == day]
            day_drivers = [d for d in self.request.drivers if d.service_day_index == day]

            if not day_routes:
                continue

            num_routes = len(day_routes)
            num_drivers = len(day_drivers)

            if num_drivers < num_routes:
                raise ValueError(
                    f"Không đủ tài xế ngày {day}: cần {num_routes}, có {num_drivers}."
                )

            # Build cost matrix: rows = routes, cols = drivers
            cost_matrix = np.full((num_routes, num_drivers), INF_PENALTY, dtype=np.int64)

            for r_idx, route in enumerate(day_routes):
                veh = self.vehicle_by_id.get(route.route_id or route.vehicle_id)
                veh_type = (veh.vehicle_type or veh.model or "") if veh else ""
                payload = veh.payload_limit_kg if veh else 0.0

                for d_idx, driver in enumerate(day_drivers):
                    # Check legal license
                    if not can_driver_drive_vehicle(driver.license_class, payload, veh_type):
                        continue

                    # Calculate total wage for this route
                    total_wage, _, _ = calculate_driver_cost(
                        self.request,
                        driver,
                        route.total_duration_minutes,
                        route.total_distance_km,
                    )
                    cost_matrix[r_idx, d_idx] = total_wage

            # Solve optimal matching in O(V^3) (< 1ms)
            row_ind, col_ind = linear_sum_assignment(cost_matrix)
            if len(row_ind) != num_routes or any(
                cost_matrix[row_index, column_index] >= INF_PENALTY
                for row_index, column_index in zip(row_ind, col_ind)
            ):
                raise ValueError(
                    f"Không có ghép tài xế–xe hợp lệ theo hạng bằng cho ngày {day}."
                )

            for r_i, d_j in zip(row_ind, col_ind):
                assigned_driver = day_drivers[d_j]
                route = day_routes[r_i]

                route.driver_id = assigned_driver.id
                route.driver_name = assigned_driver.full_name
                route.driver_license_class = assigned_driver.license_class

                # Update route cost breakdown with assigned driver's specific wage
                if route.cost:
                    total_pay, fixed_alloc, trip_pay = calculate_driver_cost(
                        self.request,
                        assigned_driver,
                        route.total_duration_minutes,
                        route.total_distance_km,
                    )
                    old_driver_total = route.cost.driver_fixed_salary_allocation_vnd + route.cost.driver_trip_pay_vnd
                    route.cost.driver_fixed_salary_allocation_vnd = fixed_alloc
                    route.cost.driver_trip_pay_vnd = trip_pay
                    route.cost.total_cost_vnd += (total_pay - old_driver_total)

        return routes
