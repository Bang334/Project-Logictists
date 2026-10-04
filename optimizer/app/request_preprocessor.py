"""Lossless reductions applied before constructing the routing search."""

from typing import List, Tuple

from .models import FleetOptimizationRequest, FleetVehicle, OrderPair


def _can_serve_order_with_zero_travel_lower_bound(
    request: FleetOptimizationRequest,
    vehicle_index: int,
    order_index: int,
) -> bool:
    """Return whether the slot could serve the order even with zero travel.

    Using a zero-travel lower bound keeps the reduction safe even when a
    provider matrix is asymmetric or does not satisfy the triangle inequality.
    """
    vehicle: FleetVehicle = request.vehicles[vehicle_index]
    order: OrderPair = request.orders[order_index]
    pickup_arrival = max(
        float(vehicle.available_start_sec),
        float(order.pickup_window_start_sec),
    )
    if pickup_arrival > order.pickup_window_end_sec:
        return False

    delivery_arrival = max(
        pickup_arrival + order.service_time_sec,
        float(order.delivery_window_start_sec),
    )
    if delivery_arrival > order.delivery_window_end_sec:
        return False

    route_end = delivery_arrival + order.service_time_sec
    return route_end <= vehicle.available_end_sec


def prune_unserviceable_virtual_resources(
    request: FleetOptimizationRequest,
) -> Tuple[FleetOptimizationRequest, int]:
    """Remove vehicle/day copies that cannot serve any order.

    Matrix rows and columns are sliced together so node indexes remain aligned.
    If every slot is rejected, the original request is retained; the solver can
    then return its existing evidence-based infeasibility/timeout diagnostics.
    """
    retained_vehicle_indices = [
        vehicle_index
        for vehicle_index in range(len(request.vehicles))
        if any(
            _can_serve_order_with_zero_travel_lower_bound(
                request, vehicle_index, order_index
            )
            for order_index in range(len(request.orders))
        )
    ]
    removed_count = len(request.vehicles) - len(retained_vehicle_indices)
    if removed_count == 0 or not retained_vehicle_indices:
        return request, 0

    retained_days = {
        request.vehicles[index].service_day_index
        for index in retained_vehicle_indices
    }
    retained_drivers = [
        driver
        for driver in request.drivers
        if driver.service_day_index in retained_days
    ]
    if len(retained_drivers) < len(retained_vehicle_indices):
        # Driver matching is checked precisely by FleetRoutingSolver.  Avoid a
        # preprocessed request that would violate the public request contract.
        return request, 0

    old_vehicle_count = len(request.vehicles)
    retained_node_indices: List[int] = retained_vehicle_indices + list(
        range(old_vehicle_count, old_vehicle_count + 2 * len(request.orders))
    )

    def slice_matrix(matrix: List[List[float]]) -> List[List[float]]:
        return [
            [matrix[row_index][column_index] for column_index in retained_node_indices]
            for row_index in retained_node_indices
        ]

    payload = request.model_dump()
    payload.update(
        vehicles=[
            request.vehicles[index].model_dump()
            for index in retained_vehicle_indices
        ],
        drivers=[driver.model_dump() for driver in retained_drivers],
        distance_matrix_meters=slice_matrix(request.distance_matrix_meters),
        duration_matrix_seconds=slice_matrix(request.duration_matrix_seconds),
    )
    return FleetOptimizationRequest(**payload), removed_count
