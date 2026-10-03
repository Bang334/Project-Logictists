"""Deterministic solver benchmark; generated matrices are synthetic, not road data."""

import argparse
import json
import math
import multiprocessing
import time

from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
)
from app.routing_solver import FleetRoutingSolver


def build_request(order_count: int, max_time_seconds: int) -> FleetOptimizationRequest:
    vehicle_count = max(1, math.ceil(order_count / 25))
    depot = LocationPoint(id="depot", name="Synthetic depot", latitude=10.77, longitude=106.7)
    vehicles = [
        FleetVehicle(
            id=f"vehicle-{index}",
            plate_number=f"BENCH-{index:03d}",
            length_cm=1200,
            width_cm=240,
            height_cm=240,
            payload_limit_kg=5000,
            depot=depot,
            fuel_consumption_liters_per_100_km=12,
            fixed_operating_cost_vnd=100_000,
        )
        for index in range(vehicle_count)
    ]
    drivers = [
        DriverOption(
            id=f"driver-{index}",
            full_name=f"Benchmark driver {index}",
            license_class="C",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for index in range(vehicle_count)
    ]
    orders = [
        OrderPair(
            id=f"order-{index}",
            order_number=f"BENCH-{index:05d}",
            pickup_location=LocationPoint(
                id=f"pickup-{index}",
                name=f"Pickup {index}",
                latitude=10.7 + (index % 20) * 0.001,
                longitude=106.6 + (index % 25) * 0.001,
            ),
            delivery_location=LocationPoint(
                id=f"delivery-{index}",
                name=f"Delivery {index}",
                latitude=10.8 + (index % 25) * 0.001,
                longitude=106.7 + (index % 20) * 0.001,
            ),
            items=[
                CargoItem(
                    id=f"item-{index}",
                    order_id=f"order-{index}",
                    description="Synthetic benchmark cargo",
                    length_cm=40,
                    width_cm=40,
                    height_cm=40,
                    weight_kg=100,
                )
            ],
            service_time_sec=60,
        )
        for index in range(order_count)
    ]
    node_count = vehicle_count + order_count * 2
    distances = [
        [0 if row == column else 1000 + abs(row - column) * 25 for column in range(node_count)]
        for row in range(node_count)
    ]
    durations = [
        [0 if row == column else 60 + abs(row - column) * 2 for column in range(node_count)]
        for row in range(node_count)
    ]
    return FleetOptimizationRequest(
        job_id=f"benchmark-{order_count}",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        policy=CostPolicy(fuel_price_per_liter_vnd=23_000, monthly_working_minutes=10_560),
        max_time_seconds=max_time_seconds,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )


def run_one(order_count: int, max_time_seconds: int, queue) -> None:
    started = time.perf_counter()
    request = build_request(order_count, max_time_seconds)
    response = FleetRoutingSolver(request).solve()
    queue.put(
        {
            "orders": order_count,
            "vehicles": len(request.vehicles),
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "solver_status": response.status,
            "served_orders": len(
                {
                    stop.order_id
                    for route in response.routes
                    for stop in route.stops
                    if stop.order_id is not None
                }
            ),
            "unassigned_orders": len(response.unassigned_orders),
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sizes", nargs="+", type=int, default=[50, 200, 500])
    parser.add_argument("--time-limit", type=int, default=5)
    parser.add_argument("--wall-timeout", type=int, default=30)
    args = parser.parse_args()
    results = []
    for size in args.sizes:
        queue = multiprocessing.Queue()
        process = multiprocessing.Process(target=run_one, args=(size, args.time_limit, queue))
        process.start()
        process.join(args.wall_timeout)
        if process.is_alive():
            process.terminate()
            process.join()
            results.append(
                {
                    "orders": size,
                    "elapsed_seconds": args.wall_timeout,
                    "solver_status": "PROCESS_TIMEOUT",
                    "note": "Worker exceeded the benchmark wall-clock resource limit.",
                }
            )
        elif process.exitcode != 0 or queue.empty():
            results.append(
                {
                    "orders": size,
                    "solver_status": "PROCESS_ERROR",
                    "exit_code": process.exitcode,
                }
            )
        else:
            results.append(queue.get())
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
