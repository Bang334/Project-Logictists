"""Dataset loader for TMS Algorithm Lab."""

import json
from typing import Dict, List, Tuple

from .models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    LocationPoint,
    OrderPair,
)


def load_dataset(file_path: str) -> Tuple[
    List[FleetVehicle],
    List[DriverOption],
    List[OrderPair],
    CostPolicy,
    List[List[float]],
    List[List[float]],
    Dict[str, int],
]:
    """Loads a JSON dataset and returns structured domain objects.
    
    Returns:
        vehicles, drivers, orders, policy, distance_matrix, duration_matrix, node_id_to_index
    """
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    vehicles = [
        FleetVehicle(
            id=v["id"],
            plate_number=v.get("plate_number", f"VEH-{idx}"),
            length_cm=float(v["length_cm"]),
            width_cm=float(v["width_cm"]),
            height_cm=float(v["height_cm"]),
            payload_limit_kg=float(v["payload_limit_kg"]),
            depot=LocationPoint(
                id=v["depot"]["id"],
                name=v["depot"].get("name", "Depot"),
                latitude=v["depot"].get("latitude", 0.0),
                longitude=v["depot"].get("longitude", 0.0),
            ),
            fuel_consumption_liters_per_100_km=float(
                v.get("fuel_consumption_liters_per_100_km", 14.0)
            ),
            load_fuel_surcharge_percent_at_full_payload=float(
                v.get("load_fuel_surcharge_percent_at_full_payload", 20.0)
            ),
            fixed_operating_cost_vnd=int(v.get("fixed_operating_cost_vnd", 100000)),
        )
        for idx, v in enumerate(data["vehicles"])
    ]

    drivers = [
        DriverOption(
            id=d["id"],
            full_name=d.get("full_name", f"Driver {idx}"),
            license_class=d.get("license_class", "C"),
            fixed_salary_monthly_vnd=int(d.get("fixed_salary_monthly_vnd", 12000000)),
            trip_base_pay_vnd=int(d.get("trip_base_pay_vnd", 150000)),
            per_km_pay_vnd=int(d.get("per_km_pay_vnd", 1200)),
        )
        for idx, d in enumerate(data.get("drivers", []))
    ]
    # Ensure every vehicle has a driver
    while len(drivers) < len(vehicles):
        idx = len(drivers)
        drivers.append(
            DriverOption(
                id=f"default-driver-{idx}",
                full_name=f"Tài xế mặc định {idx + 1}",
                license_class="C",
                fixed_salary_monthly_vnd=12000000,
                trip_base_pay_vnd=150000,
                per_km_pay_vnd=1200,
            )
        )

    orders = []
    for o in data["orders"]:
        items = [
            CargoItem(
                id=it["id"],
                order_id=o["id"],
                length_cm=float(it["length_cm"]),
                width_cm=float(it["width_cm"]),
                height_cm=float(it["height_cm"]),
                weight_kg=float(it["weight_kg"]),
                can_rotate=True,  # Người dùng đã chốt: Tất cả kiện hàng đều được phép xoay 90 độ
                description=it.get("description", ""),
            )
            for it in o.get("items", [])
        ]
        orders.append(
            OrderPair(
                id=o["id"],
                order_number=o.get("order_number", o["id"][:8]),
                pickup_location=LocationPoint(
                    id=o["pickup_location"]["id"],
                    name=o["pickup_location"].get("name", "Pickup"),
                    latitude=o["pickup_location"].get("latitude", 0.0),
                    longitude=o["pickup_location"].get("longitude", 0.0),
                ),
                delivery_location=LocationPoint(
                    id=o["delivery_location"]["id"],
                    name=o["delivery_location"].get("name", "Delivery"),
                    latitude=o["delivery_location"].get("latitude", 0.0),
                    longitude=o["delivery_location"].get("longitude", 0.0),
                ),
                items=items,
                service_time_sec=int(o.get("service_time_sec", 1200)),
                pickup_window_start_sec=int(o.get("pickup_window_start_sec", 0)),
                pickup_window_end_sec=int(o.get("pickup_window_end_sec", 86400)),
                delivery_window_start_sec=int(o.get("delivery_window_start_sec", 0)),
                delivery_window_end_sec=int(o.get("delivery_window_end_sec", 86400)),
                order_value_vnd=int(o.get("order_value_vnd", 10_000_000)),
            )
        )

    raw_policy = data.get("policy", {})
    policy = CostPolicy(
        fuel_price_per_liter_vnd=int(raw_policy.get("fuel_price_per_liter_vnd", 23800)),
        monthly_working_minutes=int(raw_policy.get("monthly_working_minutes", 10560)),
        cargo_holding_cost_vnd_per_ton_hour=int(
            raw_policy.get("cargo_holding_cost_vnd_per_ton_hour", 15000)
        ),
        unassigned_order_penalty_vnd=int(
            raw_policy.get("unassigned_order_penalty_vnd", 10_000_000)
        ),
    )

    distance_matrix = data["distance_matrix_meters"]
    duration_matrix = data["duration_matrix_seconds"]

    # Map node id to matrix index
    node_id_to_index: Dict[str, int] = {}
    curr_idx = 0
    for v in vehicles:
        node_id_to_index[v.depot.id] = curr_idx
        curr_idx += 1
    for o in orders:
        node_id_to_index[o.pickup_location.id] = curr_idx
        curr_idx += 1
        node_id_to_index[o.delivery_location.id] = curr_idx
        curr_idx += 1

    return (
        vehicles,
        drivers,
        orders,
        policy,
        distance_matrix,
        duration_matrix,
        node_id_to_index,
    )
