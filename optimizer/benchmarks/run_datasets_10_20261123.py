"""Generate and benchmark 10 diverse multi-package FleetOptimizationRequest datasets.

Coverage across the 10 datasets:
- Orders: 5 -> 200
- Physical vehicles & drivers: 3 -> 15 (replicated over 1..7 service days)
- Diverse order profiles (micro parcel, small mixed, medium retail, heavy industrial, long/bulky)
- Multiple packages per order with varied LxWxH dimensions, weights, stacking kinds,
  max_top_load_g, no_top_load_requested, and floor-rotation locks.
- Default dynamic 3D stacking (max_tiers=3, lift_clearance_cm=5.0, ANY_CUSTOMER & SAME_CUSTOMER).
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
from itertools import combinations
import json
import math
from pathlib import Path
import random
import sys
import time
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app.main import app
from app.models import (
    CargoItem,
    CostPolicy,
    DemoStackingPolicy,
    DriverOption,
    FleetOptimizationBatchResponse,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    StopAction,
    VehicleFloor,
    can_driver_drive_vehicle,
)
from app.stacking import DemoStacks
from app.spatial_validator import SpatialValidator


OUTPUT_DIR = Path(__file__).resolve().parent / "datasets_10_20261123"
EPS = 0.01


@dataclass(frozen=True)
class VehicleSpec:
    code: str
    length_cm: float
    width_cm: float
    height_cm: float
    payload_limit_kg: float
    fuel_l_per_100km: float
    surcharge_pct: float
    fixed_cost_vnd: int


VEHICLE_SPECS: Dict[str, VehicleSpec] = {
    "VAN_1_5T": VehicleSpec("VAN_1_5T", 310.0, 165.0, 170.0, 1500.0, 9.2, 16.0, 70_000),
    "TRUCK_3_5T": VehicleSpec("TRUCK_3_5T", 430.0, 185.0, 195.0, 3500.0, 12.5, 20.0, 105_000),
    "TRUCK_5T": VehicleSpec("TRUCK_5T", 620.0, 220.0, 230.0, 5000.0, 16.0, 24.0, 145_000),
    "TRUCK_8T": VehicleSpec("TRUCK_8T", 760.0, 235.0, 245.0, 8000.0, 19.5, 28.0, 190_000),
    "TRUCK_12T": VehicleSpec("TRUCK_12T", 940.0, 240.0, 260.0, 12000.0, 24.0, 30.0, 250_000),
}


@dataclass(frozen=True)
class DatasetSpec:
    file_name: str
    job_id: str
    seed: int
    order_count: int
    vehicle_count: int
    service_days: int
    fleet_mix: Tuple[str, ...]
    b2_driver_count: int
    region_name: str
    depots: Tuple[Tuple[str, float, float], ...]
    spread_deg: float
    owner_mode: str
    search_time_seconds: int
    max_time_seconds: int


DATASET_SPECS: Tuple[DatasetSpec, ...] = (
    DatasetSpec(
        file_name="dataset_01_005_orders_03_fleet.json",
        job_id="ds01-5-orders-3-fleet",
        seed=20261101,
        order_count=5,
        vehicle_count=3,
        service_days=1,
        fleet_mix=("VAN_1_5T", "TRUCK_3_5T", "TRUCK_5T"),
        b2_driver_count=1,
        region_name="Hà Nội nội đô",
        depots=(("Kho Tổng Long Biên", 21.0340, 105.9080),),
        spread_deg=0.075,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=8,
        max_time_seconds=20,
    ),
    DatasetSpec(
        file_name="dataset_02_012_orders_04_fleet.json",
        job_id="ds02-12-orders-4-fleet",
        seed=20261102,
        order_count=12,
        vehicle_count=4,
        service_days=1,
        fleet_mix=("VAN_1_5T", "TRUCK_3_5T", "TRUCK_5T", "TRUCK_8T"),
        b2_driver_count=2,
        region_name="Hà Nội - Bắc Ninh",
        depots=(("Hub Gia Lâm", 21.0210, 105.9360),),
        spread_deg=0.11,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=12,
        max_time_seconds=30,
    ),
    DatasetSpec(
        file_name="dataset_03_020_orders_05_fleet.json",
        job_id="ds03-20-orders-5-fleet",
        seed=20261103,
        order_count=20,
        vehicle_count=5,
        service_days=2,
        fleet_mix=("VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T", "TRUCK_5T", "TRUCK_8T"),
        b2_driver_count=2,
        region_name="Đà Nẵng - Quảng Nam",
        depots=(("Kho Hòa Cầm", 16.0125, 108.1874),),
        spread_deg=0.10,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=15,
        max_time_seconds=35,
    ),
    DatasetSpec(
        file_name="dataset_04_035_orders_06_fleet.json",
        job_id="ds04-35-orders-6-fleet",
        seed=20261104,
        order_count=35,
        vehicle_count=6,
        service_days=3,
        fleet_mix=("VAN_1_5T", "TRUCK_3_5T", "TRUCK_5T", "TRUCK_5T", "TRUCK_8T", "TRUCK_12T"),
        b2_driver_count=2,
        region_name="Hải Phòng - Quảng Ninh",
        depots=(("Depot Đình Vũ", 20.8440, 106.7520),),
        spread_deg=0.12,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=20,
        max_time_seconds=45,
    ),
    DatasetSpec(
        file_name="dataset_05_050_orders_08_fleet.json",
        job_id="ds05-50-orders-8-fleet",
        seed=20261105,
        order_count=50,
        vehicle_count=8,
        service_days=3,
        fleet_mix=(
            "VAN_1_5T", "VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T",
            "TRUCK_5T", "TRUCK_5T", "TRUCK_8T", "TRUCK_12T",
        ),
        b2_driver_count=3,
        region_name="Đà Nẵng 2 Hub",
        depots=(
            ("Hub Hòa Khánh", 16.0680, 108.1510),
            ("Hub Hòa Cầm", 16.0125, 108.1874),
        ),
        spread_deg=0.11,
        owner_mode="SAME_CUSTOMER",
        search_time_seconds=25,
        max_time_seconds=55,
    ),
    DatasetSpec(
        file_name="dataset_06_075_orders_09_fleet.json",
        job_id="ds06-75-orders-9-fleet",
        seed=20261106,
        order_count=75,
        vehicle_count=9,
        service_days=4,
        fleet_mix=(
            "VAN_1_5T", "VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T",
            "TRUCK_5T", "TRUCK_5T", "TRUCK_8T", "TRUCK_8T", "TRUCK_12T",
        ),
        b2_driver_count=3,
        region_name="TP.HCM - Bình Dương",
        depots=(("Kho Sóng Thần", 10.9030, 106.7430),),
        spread_deg=0.13,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=30,
        max_time_seconds=65,
    ),
    DatasetSpec(
        file_name="dataset_07_100_orders_10_fleet.json",
        job_id="ds07-100-orders-10-fleet",
        seed=20261107,
        order_count=100,
        vehicle_count=10,
        service_days=5,
        fleet_mix=(
            "VAN_1_5T", "VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T", "TRUCK_5T",
            "TRUCK_5T", "TRUCK_5T", "TRUCK_8T", "TRUCK_8T", "TRUCK_12T",
        ),
        b2_driver_count=4,
        region_name="TP.HCM - Đồng Nai",
        depots=(
            ("Kho Cát Lái", 10.7710, 106.7830),
            ("Kho Tân Bình", 10.8080, 106.6430),
        ),
        spread_deg=0.14,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=35,
        max_time_seconds=75,
    ),
    DatasetSpec(
        file_name="dataset_08_130_orders_12_fleet.json",
        job_id="ds08-130-orders-12-fleet",
        seed=20261108,
        order_count=130,
        vehicle_count=12,
        service_days=5,
        fleet_mix=(
            "VAN_1_5T", "VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T", "TRUCK_3_5T",
            "TRUCK_5T", "TRUCK_5T", "TRUCK_5T", "TRUCK_8T", "TRUCK_8T",
            "TRUCK_12T", "TRUCK_12T",
        ),
        b2_driver_count=4,
        region_name="Đồng bằng Sông Hồng",
        depots=(
            ("Kho Thanh Trì", 20.9460, 105.8470),
            ("Kho Từ Sơn", 21.1180, 105.9610),
        ),
        spread_deg=0.15,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=45,
        max_time_seconds=90,
    ),
    DatasetSpec(
        file_name="dataset_09_165_orders_14_fleet.json",
        job_id="ds09-165-orders-14-fleet",
        seed=20261109,
        order_count=165,
        vehicle_count=14,
        service_days=7,
        fleet_mix=(
            "VAN_1_5T", "VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T", "TRUCK_3_5T",
            "TRUCK_5T", "TRUCK_5T", "TRUCK_5T", "TRUCK_8T", "TRUCK_8T",
            "TRUCK_8T", "TRUCK_12T", "TRUCK_12T", "TRUCK_12T",
        ),
        b2_driver_count=4,
        region_name="TP.HCM - Long An - Bình Dương",
        depots=(
            ("Hub Hiệp Phước", 10.6540, 106.7520),
            ("Hub Sóng Thần", 10.9030, 106.7430),
        ),
        spread_deg=0.16,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=50,
        max_time_seconds=105,
    ),
    DatasetSpec(
        file_name="dataset_10_200_orders_15_fleet.json",
        job_id="ds10-200-orders-15-fleet",
        seed=20261110,
        order_count=200,
        vehicle_count=15,
        service_days=7,
        fleet_mix=(
            "VAN_1_5T", "VAN_1_5T", "VAN_1_5T", "TRUCK_3_5T", "TRUCK_3_5T",
            "TRUCK_3_5T", "TRUCK_5T", "TRUCK_5T", "TRUCK_5T", "TRUCK_8T",
            "TRUCK_8T", "TRUCK_8T", "TRUCK_12T", "TRUCK_12T", "TRUCK_12T",
        ),
        b2_driver_count=5,
        region_name="Vùng Kinh tế Trọng điểm Phía Nam",
        depots=(
            ("Hub Cát Lái", 10.7710, 106.7830),
            ("Hub Sóng Thần", 10.9030, 106.7430),
            ("Hub Bình Chánh", 10.7320, 106.5980),
        ),
        spread_deg=0.16,
        owner_mode="ANY_CUSTOMER",
        search_time_seconds=60,
        max_time_seconds=120,
    ),
)


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    if abs(lat1 - lat2) < 1e-9 and abs(lon1 - lon2) < 1e-9:
        return 0.0
    r = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2.0) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def _build_order_items(
    rng: random.Random,
    order_id: str,
    customer_id: str,
    profile: str,
) -> List[CargoItem]:
    items: List[CargoItem] = []

    def add_item(
        idx: int,
        desc: str,
        l_cm: float,
        w_cm: float,
        h_cm: float,
        weight_kg: float,
        cargo_kind: str = "STANDARD",
        no_top_load: bool = False,
        max_top_load_g: Optional[int] = None,
        allowed_orientations: Optional[List[str]] = None,
    ) -> None:
        allow_upper = cargo_kind == "STANDARD" and not no_top_load
        items.append(
            CargoItem(
                id=f"{order_id}-pkg-{idx}",
                order_id=order_id,
                customer_id=customer_id,
                order_item_id=f"{order_id}-line-{idx}",
                description=desc,
                length_cm=l_cm,
                width_cm=w_cm,
                height_cm=h_cm,
                weight_kg=weight_kg,
                can_rotate=(allowed_orientations is None or "WLH" in allowed_orientations),
                allowed_orientations=allowed_orientations,
                cargo_kind=cargo_kind,
                allow_upper_tier=allow_upper,
                no_top_load_requested=no_top_load,
                max_top_load_g=max_top_load_g,
            )
        )

    if profile == "MICRO_PARCEL":
        count = rng.randint(2, 4)
        for idx in range(1, count + 1):
            l_cm = float(rng.choice([28, 32, 36, 40, 45]))
            w_cm = float(rng.choice([22, 26, 30, 35]))
            h_cm = float(rng.choice([18, 22, 26, 30]))
            weight_kg = float(rng.choice([5, 8, 12, 16, 20]))
            kind = "FRAGILE" if idx == count and rng.random() < 0.35 else "STANDARD"
            add_item(idx, f"Kiện thương mại nhỏ #{idx}", l_cm, w_cm, h_cm, weight_kg, cargo_kind=kind)

    elif profile == "SMALL_MIXED":
        count = rng.randint(3, 6)
        # Base boxes + smaller upper cartons
        for idx in range(1, count + 1):
            if idx <= 2:
                l_cm = float(rng.choice([55, 60, 70]))
                w_cm = float(rng.choice([45, 50, 55]))
                h_cm = float(rng.choice([35, 40, 45]))
                weight_kg = float(rng.choice([35, 45, 60]))
                add_item(idx, f"Thùng nền vừa #{idx}", l_cm, w_cm, h_cm, weight_kg, max_top_load_g=int(weight_kg * 300))
            else:
                l_cm = float(rng.choice([30, 35, 40]))
                w_cm = float(rng.choice([25, 30, 35]))
                h_cm = float(rng.choice([22, 28, 32]))
                weight_kg = float(rng.choice([6, 10, 14]))
                kind = "FRAGILE" if idx == count and rng.random() < 0.4 else "STANDARD"
                add_item(idx, f"Kiện phụ kiện nhỏ #{idx}", l_cm, w_cm, h_cm, weight_kg, cargo_kind=kind)

    elif profile == "MEDIUM_RETAIL":
        count = rng.randint(4, 7)
        for idx in range(1, count + 1):
            if idx <= 2:
                l_cm = float(rng.choice([80, 90, 100]))
                w_cm = float(rng.choice([60, 70, 80]))
                h_cm = float(rng.choice([45, 55, 60]))
                weight_kg = float(rng.choice([90, 120, 150]))
                add_item(idx, f"Kiện bán lẻ chuẩn #{idx}", l_cm, w_cm, h_cm, weight_kg, max_top_load_g=45_000)
            elif idx <= 4:
                l_cm = float(rng.choice([45, 50, 58]))
                w_cm = float(rng.choice([38, 42, 48]))
                h_cm = float(rng.choice([32, 38, 42]))
                weight_kg = float(rng.choice([18, 24, 30]))
                no_top = idx == 4 and rng.random() < 0.5
                add_item(idx, f"Thùng hàng tiêu dùng #{idx}", l_cm, w_cm, h_cm, weight_kg, no_top_load=no_top)
            else:
                l_cm = float(rng.choice([32, 36, 40]))
                w_cm = float(rng.choice([24, 28, 34]))
                h_cm = float(rng.choice([20, 26, 30]))
                weight_kg = float(rng.choice([6, 9, 12]))
                kind = "FRAGILE" if rng.random() < 0.35 else "STANDARD"
                add_item(idx, f"Kiện nhẹ ghép tầng #{idx}", l_cm, w_cm, h_cm, weight_kg, cargo_kind=kind)

    elif profile == "HEAVY_INDUSTRIAL":
        count = rng.randint(4, 7)
        for idx in range(1, count + 1):
            if idx <= 2:
                l_cm = float(rng.choice([105, 115, 120]))
                w_cm = float(rng.choice([85, 95, 100]))
                h_cm = float(rng.choice([60, 70, 75]))
                weight_kg = float(rng.choice([240, 300, 380]))
                add_item(idx, f"Pallet máy công nghiệp #{idx}", l_cm, w_cm, h_cm, weight_kg, max_top_load_g=int(weight_kg * 300))
            elif idx <= 4:
                l_cm = float(rng.choice([65, 75, 80]))
                w_cm = float(rng.choice([50, 60, 65]))
                h_cm = float(rng.choice([40, 48, 55]))
                weight_kg = float(rng.choice([45, 60, 75]))
                add_item(idx, f"Kiện linh kiện nặng #{idx}", l_cm, w_cm, h_cm, weight_kg, max_top_load_g=20_000)
            else:
                l_cm = float(rng.choice([38, 45, 50]))
                w_cm = float(rng.choice([30, 35, 40]))
                h_cm = float(rng.choice([25, 30, 35]))
                weight_kg = float(rng.choice([10, 14, 18]))
                no_top = idx == count and rng.random() < 0.4
                add_item(idx, f"Hộp vật tư bổ sung #{idx}", l_cm, w_cm, h_cm, weight_kg, no_top_load=no_top)

    else:  # LONG_BULKY
        count = rng.randint(3, 5)
        for idx in range(1, count + 1):
            if idx == 1:
                l_cm = float(rng.choice([170, 185, 200]))
                w_cm = float(rng.choice([65, 75, 85]))
                h_cm = float(rng.choice([55, 65, 75]))
                weight_kg = float(rng.choice([160, 210, 260]))
                add_item(
                    idx,
                    f"Kiện dài khóa xoay #{idx}",
                    l_cm,
                    w_cm,
                    h_cm,
                    weight_kg,
                    max_top_load_g=60_000,
                    allowed_orientations=["LWH"],
                )
            elif idx == 2:
                l_cm = float(rng.choice([120, 135, 150]))
                w_cm = float(rng.choice([55, 65, 75]))
                h_cm = float(rng.choice([45, 55, 65]))
                weight_kg = float(rng.choice([85, 110, 140]))
                add_item(idx, f"Thùng dài trung bình #{idx}", l_cm, w_cm, h_cm, weight_kg, max_top_load_g=35_000)
            else:
                l_cm = float(rng.choice([35, 42, 50]))
                w_cm = float(rng.choice([28, 34, 40]))
                h_cm = float(rng.choice([24, 30, 34]))
                weight_kg = float(rng.choice([8, 12, 16]))
                kind = "FRAGILE" if idx == count and rng.random() < 0.45 else "STANDARD"
                add_item(idx, f"Phụ kiện đi kèm #{idx}", l_cm, w_cm, h_cm, weight_kg, cargo_kind=kind)

    return items


def _verify_single_order_fits_fleet(
    order: OrderPair,
    physical_vehicles: List[FleetVehicle],
    policy: DemoStackingPolicy,
) -> bool:
    for v in physical_vehicles:
        if order.total_weight_kg > v.payload_limit_kg + EPS:
            continue
        floor = VehicleFloor(
            id=v.id,
            plate_number=v.plate_number,
            length_cm=v.length_cm,
            width_cm=v.width_cm,
            height_cm=v.height_cm,
            payload_limit_kg=v.payload_limit_kg,
        )
        actions = [
            StopAction(
                stop_id=order.pickup_location.id,
                sequence=1,
                stop_type="PICKUP",
                items_to_load=order.items,
            ),
            StopAction(
                stop_id=order.delivery_location.id,
                sequence=2,
                stop_type="DELIVERY",
                items_to_unload=[it.id for it in order.items],
            ),
        ]
        res = DemoStacks(policy, [floor]).validate_stops(
            SpatialValidator(floor, max_search_nodes=5000, max_time_seconds=1.5),
            actions,
        )
        if res.is_valid:
            return True
    return False


def generate_dataset(spec: DatasetSpec) -> FleetOptimizationRequest:
    rng = random.Random(spec.seed)
    stacking_policy = DemoStackingPolicy(
        max_tiers=3,
        lift_clearance_cm=5.0,
        owner_mode=spec.owner_mode,
        max_top_load_percent=30,
    )

    depot_points = [
        LocationPoint(
            id=f"depot-{idx}",
            source_location_id=f"depot-{idx}",
            name=name,
            latitude=lat,
            longitude=lon,
        )
        for idx, (name, lat, lon) in enumerate(spec.depots)
    ]

    physical_vehicles: List[FleetVehicle] = []
    vehicles: List[FleetVehicle] = []
    drivers: List[DriverOption] = []

    for v_idx in range(spec.vehicle_count):
        v_spec = VEHICLE_SPECS[spec.fleet_mix[v_idx]]
        depot = depot_points[v_idx % len(depot_points)]
        phys_v_id = f"veh-{v_idx + 1:02d}"
        phys_v = FleetVehicle(
            id=phys_v_id,
            source_vehicle_id=phys_v_id,
            plate_number=f"51C-{100 + v_idx:03d}.{10 + (v_idx * 7) % 89:02d}",
            vehicle_type=v_spec.code,
            model=v_spec.code,
            length_cm=v_spec.length_cm,
            width_cm=v_spec.width_cm,
            height_cm=v_spec.height_cm,
            payload_limit_kg=v_spec.payload_limit_kg,
            door_position="REAR",
            fuel_consumption_liters_per_100_km=v_spec.fuel_l_per_100km,
            load_fuel_surcharge_percent_at_full_payload=v_spec.surcharge_pct,
            fixed_operating_cost_vnd=v_spec.fixed_cost_vnd,
            depot=depot,
        )
        physical_vehicles.append(phys_v)

    # Assign B2 drivers only to <= 3500 kg vehicles so full fleet can run concurrently.
    small_indices = [i for i, pv in enumerate(physical_vehicles) if pv.payload_limit_kg <= 3500.0]
    b2_indices = set(small_indices[: spec.b2_driver_count])

    for day in range(spec.service_days):
        day_offset = day * 86_400
        for v_idx, pv in enumerate(physical_vehicles):
            vehicles.append(
                pv.model_copy(
                    update={
                        "id": f"{pv.id}#day{day}",
                        "source_vehicle_id": pv.id,
                        "service_day_index": day,
                        "available_start_sec": day_offset + 7 * 3600 + 1800,   # 07:30
                        "available_end_sec": day_offset + 18 * 3600 + 1800,    # 18:30 (11h shift)
                    }
                )
            )
            lic = "B2" if v_idx in b2_indices else "C"
            drivers.append(
                DriverOption(
                    id=f"drv-{v_idx + 1:02d}#day{day}",
                    source_driver_id=f"drv-{v_idx + 1:02d}",
                    service_day_index=day,
                    full_name=f"Tài xế {v_idx + 1:02d} ({lic})",
                    license_class=lic,
                    fixed_salary_monthly_vnd=12_000_000 if lic == "B2" else 15_500_000,
                    trip_base_pay_vnd=140_000 if lic == "B2" else 180_000,
                    per_km_pay_vnd=1_000 if lic == "B2" else 1_250,
                )
            )

    # Build a reusable pool of pickup hubs and delivery points around depots
    center_lat = sum(d.latitude for d in depot_points) / len(depot_points)
    center_lon = sum(d.longitude for d in depot_points) / len(depot_points)
    pickup_hubs: List[LocationPoint] = []
    hub_count = max(3, min(12, spec.order_count // 6 + 2))
    for h_idx in range(hub_count):
        angle = (2.0 * math.pi * h_idx) / hub_count
        rad = spec.spread_deg * (0.25 + 0.45 * ((h_idx % 3) / 2.0))
        pickup_hubs.append(
            LocationPoint(
                id=f"hub-p-{h_idx + 1:02d}",
                source_location_id=f"hub-p-{h_idx + 1:02d}",
                name=f"Kho nguồn {spec.region_name} #{h_idx + 1}",
                latitude=round(center_lat + rad * math.sin(angle), 6),
                longitude=round(center_lon + rad * math.cos(angle), 6),
            )
        )

    profiles = ("MICRO_PARCEL", "SMALL_MIXED", "MEDIUM_RETAIL", "HEAVY_INDUSTRIAL", "LONG_BULKY")
    customer_pool = [f"cust-{(i % max(4, min(20, spec.order_count // 3 + 2))) + 1:02d}" for i in range(spec.order_count)]

    orders: List[OrderPair] = []
    horizon_end = (spec.service_days - 1) * 86_400 + 18 * 3600 + 1800
    for o_idx in range(spec.order_count):
        order_id = f"ord-{o_idx + 1:03d}"
        customer_id = customer_pool[o_idx]
        profile = profiles[o_idx % len(profiles)]
        pickup_loc = pickup_hubs[o_idx % len(pickup_hubs)]

        angle = rng.uniform(0.0, 2.0 * math.pi)
        rad = spec.spread_deg * rng.uniform(0.20, 0.95)
        delivery_loc = LocationPoint(
            id=f"loc-d-{o_idx + 1:03d}",
            source_location_id=f"loc-d-{o_idx + 1:03d}",
            name=f"Điểm giao {spec.region_name} #{o_idx + 1:03d}",
            latitude=round(center_lat + rad * math.sin(angle), 6),
            longitude=round(center_lon + rad * math.cos(angle), 6),
        )

        # Ensure generated multi-package order fits at least one physical vehicle under 3D rules.
        items: List[CargoItem] = []
        for _attempt in range(10):
            cand_items = _build_order_items(rng, order_id, customer_id, profile)
            probe_order = OrderPair(
                id=order_id,
                source_order_id=order_id,
                order_number=f"ORD-{o_idx + 1:04d}",
                source_order_number=f"ORD-{o_idx + 1:04d}",
                pickup_location=pickup_loc,
                delivery_location=delivery_loc,
                items=cand_items,
            )
            if _verify_single_order_fits_fleet(probe_order, physical_vehicles, stacking_policy):
                items = cand_items
                break
        if not items:
            raise RuntimeError(f"Could not generate feasible 3D order for {order_id} ({profile})")

        # Stagger time windows gently on smaller/multi-day cases while always keeping >= 1 full shift feasible
        if spec.service_days == 1:
            p_start, p_end = 7 * 3600 + 1800, 16 * 3600 + 1800
            d_start, d_end = 8 * 3600, 18 * 3600 + 1800
        else:
            earliest_day = (o_idx * spec.service_days) // max(1, spec.order_count * 2)
            earliest_day = min(earliest_day, max(0, spec.service_days - 2))
            p_start = earliest_day * 86_400 + 7 * 3600 + 1800
            p_end = horizon_end - 3600
            d_start = earliest_day * 86_400 + 8 * 3600
            d_end = horizon_end

        srv_pickup = 300 + 45 * len(items)
        srv_delivery = 300 + 50 * len(items)

        orders.append(
            OrderPair(
                id=order_id,
                source_order_id=order_id,
                order_number=f"ORD-{o_idx + 1:04d}",
                source_order_number=f"ORD-{o_idx + 1:04d}",
                ordered_at_sec=-(rng.choice([0, 43_200, 86_400, 129_600])),
                order_value_vnd=rng.randint(8, 65) * 1_000_000,
                pickup_location=pickup_loc,
                delivery_location=delivery_loc,
                items=items,
                pickup_window_start_sec=p_start,
                pickup_window_end_sec=p_end,
                delivery_window_start_sec=d_start,
                delivery_window_end_sec=d_end,
                service_time_sec=max(srv_pickup, srv_delivery),
                pickup_service_time_sec=srv_pickup,
                delivery_service_time_sec=srv_delivery,
                package_contract_version="1",
            )
        )

    # Build node coordinates list matching FleetOptimizationRequest contract:
    # vehicles[0..nv-1], then pickup_i, delivery_i for each order
    node_points: List[LocationPoint] = [v.depot for v in vehicles]
    for order in orders:
        node_points.append(order.pickup_location)
        node_points.append(order.delivery_location)

    n = len(node_points)
    dist_matrix: List[List[float]] = [[0.0] * n for _ in range(n)]
    dur_matrix: List[List[float]] = [[0.0] * n for _ in range(n)]
    for i in range(n):
        pi = node_points[i]
        for j in range(i + 1, n):
            pj = node_points[j]
            crow = _haversine_meters(pi.latitude, pi.longitude, pj.latitude, pj.longitude)
            if crow < 1.0:
                road_m = 0.0
                sec = 0.0
            else:
                road_m = round(crow * 1.35, 1)
                speed_mps = 8.9 if road_m < 12_000 else 11.2
                sec = round(max(120.0, road_m / speed_mps), 1)
            dist_matrix[i][j] = road_m
            dist_matrix[j][i] = road_m
            dur_matrix[i][j] = sec
            dur_matrix[j][i] = sec

    return FleetOptimizationRequest(
        job_id=spec.job_id,
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        demo_stacking=stacking_policy,
        policy=CostPolicy(
            fuel_price_per_liter_vnd=23_500,
            monthly_working_minutes=12_480,
            cargo_holding_cost_vnd_per_ton_hour=12_000,
            unassigned_order_penalty_vnd=1_000_000_000,
            delivery_grace_days=2,
            late_delivery_penalty_mode="FIXED_PER_DAY",
            late_delivery_penalty_value=50_000,
        ),
        max_time_seconds=spec.max_time_seconds,
        search_time_seconds=spec.search_time_seconds,
        distance_matrix_meters=dist_matrix,
        duration_matrix_seconds=dur_matrix,
    )


def audit_response(request: FleetOptimizationRequest, result: FleetOptimizationResponse) -> Dict[str, object]:
    """Independently verify package conservation, scheduling, driver licenses, and 3D stacking."""
    violations: List[str] = []
    expected_packages = Counter(it.id for o in request.orders for it in o.items)
    order_by_id = {o.id: o for o in request.orders}
    item_by_id = {it.id: it for o in request.orders for it in o.items}
    veh_by_slot = {v.id: v for v in request.vehicles}
    veh_by_phys_day = {(v.source_vehicle_id or v.id, v.service_day_index): v for v in request.vehicles}
    drv_by_id = {d.id: d for d in request.drivers}

    loaded_total = Counter()
    unloaded_total = Counter()
    used_plate_days = set()
    used_driver_days = set()
    peak_tiers = 0
    peak_stacked_count = 0
    max_weight_util = 0.0
    max_area_util = 0.0

    for r_idx, route in enumerate(result.routes):
        veh = veh_by_slot.get(route.route_id or "") or veh_by_phys_day.get((route.vehicle_id, route.service_day_index))
        if veh is None:
            violations.append(f"Route {r_idx}: unknown vehicle {route.vehicle_id} day {route.service_day_index}")
            continue

        plate_day = (route.service_day_index, route.plate_number)
        if plate_day in used_plate_days:
            violations.append(f"Duplicate vehicle {route.plate_number} on day {route.service_day_index}")
        used_plate_days.add(plate_day)

        if route.driver_id:
            drv_day = (route.service_day_index, route.driver_id)
            if drv_day in used_driver_days:
                violations.append(f"Duplicate driver {route.driver_id} on day {route.service_day_index}")
            used_driver_days.add(drv_day)
            drv = drv_by_id.get(route.driver_id)
            if drv and not can_driver_drive_vehicle(drv.license_class, veh.payload_limit_kg, veh.vehicle_type or ""):
                violations.append(f"License mismatch: driver {drv.license_class} on {veh.vehicle_type} ({veh.payload_limit_kg}kg)")

        if route.start_time_sec < veh.available_start_sec or route.end_time_sec > veh.available_end_sec:
            violations.append(
                f"Route {route.vehicle_id} day {route.service_day_index} outside shift "
                f"[{route.start_time_sec}, {route.end_time_sec}] vs [{veh.available_start_sec}, {veh.available_end_sec}]"
            )

        if not route.spatial_validation.is_valid:
            violations.append(
                f"Route {route.vehicle_id}: spatial_validation.is_valid=False ({route.spatial_validation.error_message})"
            )

        onboard = set()
        seen_pickup_orders = set()
        stop_actions: List[StopAction] = []
        for stop, state in zip(route.stops, route.spatial_validation.step_states, strict=True):
            oid = stop.allocation_id or stop.order_id
            if stop.stop_type == "PICKUP":
                seen_pickup_orders.add(oid)
            elif stop.stop_type == "DELIVERY" and oid not in seen_pickup_orders:
                violations.append(f"Route {route.vehicle_id}: delivery before pickup for {oid}")
            if oid in order_by_id:
                ord_obj = order_by_id[oid]
                if stop.stop_type == "PICKUP":
                    if not (ord_obj.pickup_window_start_sec <= stop.arrival_time_sec <= ord_obj.pickup_window_end_sec):
                        violations.append(f"Order {oid} pickup arrival {stop.arrival_time_sec} outside window")
                else:
                    if not (ord_obj.delivery_window_start_sec <= stop.arrival_time_sec <= ord_obj.delivery_window_end_sec):
                        violations.append(f"Order {oid} delivery arrival {stop.arrival_time_sec} outside window")

            onboard.update(stop.items_loaded)
            onboard.difference_update(stop.items_unloaded)
            loaded_total.update(stop.items_loaded)
            unloaded_total.update(stop.items_unloaded)

            if {p.item_id for p in state.placed_items} != onboard:
                violations.append(f"Route {route.vehicle_id} stop {stop.sequence}: placed_items mismatch with onboard")

            placed_map = {p.item_id: p for p in state.placed_items}
            tiers = {}
            for p in sorted(state.placed_items, key=lambda box: box.z):
                if p.support_item_id is None:
                    tiers[p.item_id] = 1
                elif p.support_item_id in tiers:
                    tiers[p.item_id] = tiers[p.support_item_id] + 1
                else:
                    violations.append(f"Route {route.vehicle_id}: missing support {p.support_item_id} for {p.item_id}")
                    tiers[p.item_id] = 2
                if p.x < -EPS or p.y < -EPS or p.z < -EPS:
                    violations.append(f"Negative coordinate for {p.item_id}")
                if (
                    p.x + p.length_cm > veh.length_cm + EPS
                    or p.y + p.width_cm > veh.width_cm + EPS
                    or p.z + p.height_cm > veh.height_cm + EPS
                ):
                    violations.append(f"Out of vehicle bounds for {p.item_id}")
            for left, right in combinations(state.placed_items, 2):
                if not (
                    min(left.x + left.length_cm, right.x + right.length_cm) - max(left.x, right.x) <= EPS
                    or min(left.y + left.width_cm, right.y + right.width_cm) - max(left.y, right.y) <= EPS
                    or min(left.z + left.height_cm, right.z + right.height_cm) - max(left.z, right.z) <= EPS
                ):
                    violations.append(f"3D overlap on {route.vehicle_id}: {left.item_id} vs {right.item_id}")

            peak_tiers = max(peak_tiers, max(tiers.values(), default=0))
            peak_stacked_count = max(peak_stacked_count, sum(1 for t in tiers.values() if t > 1))
            max_weight_util = max(max_weight_util, float(state.weight_utilization_percent))
            max_area_util = max(max_area_util, float(state.area_utilization_percent))

            stop_actions.append(
                StopAction(
                    stop_id=stop.location_id,
                    sequence=stop.sequence,
                    stop_type=stop.stop_type,
                    items_to_load=[item_by_id[iid] for iid in stop.items_loaded],
                    items_to_unload=list(stop.items_unloaded),
                )
            )

        if onboard:
            violations.append(f"Route {route.vehicle_id}: leftover onboard items {sorted(onboard)}")

        # Independent DemoStacks replay check
        floor = VehicleFloor(
            id=veh.id,
            plate_number=veh.plate_number,
            length_cm=veh.length_cm,
            width_cm=veh.width_cm,
            height_cm=veh.height_cm,
            payload_limit_kg=veh.payload_limit_kg,
        )
        independent = DemoStacks(request.demo_stacking, [floor]).validate_stops(
            SpatialValidator(floor, max_search_nodes=20_000, max_time_seconds=4.0),
            stop_actions,
        )
        if not independent.is_valid:
            violations.append(
                f"Independent DemoStacks check failed on {route.vehicle_id}: {independent.violation_code} {independent.error_message}"
            )

    missing_items = set(expected_packages.keys()) - set(loaded_total.keys())
    if loaded_total != unloaded_total:
        violations.append("Loaded != Unloaded packages across solution")

    return {
        "audit_pass": len(violations) == 0 and len(missing_items) == 0,
        "violations": violations,
        "missing_package_count": len(missing_items),
        "peak_tiers": peak_tiers,
        "peak_stacked_items": peak_stacked_count,
        "max_weight_util_pct": round(max_weight_util, 2),
        "max_area_util_pct": round(max_area_util, 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate-only", action="store_true")
    parser.add_argument("--only", nargs="*", help="Filter dataset filenames to run")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    generated_paths: List[Tuple[DatasetSpec, Path, FleetOptimizationRequest]] = []

    for spec in DATASET_SPECS:
        req = generate_dataset(spec)
        path = OUTPUT_DIR / spec.file_name
        path.write_text(json.dumps(req.model_dump(mode="json"), ensure_ascii=False, indent=2), encoding="utf-8")
        total_items = sum(len(o.items) for o in req.orders)
        total_weight = round(sum(o.total_weight_kg for o in req.orders), 1)
        print(
            f"[GENERATED] {spec.file_name} | orders={len(req.orders)} | items={total_items} | "
            f"weight_kg={total_weight} | phys_veh={spec.vehicle_count} | phys_drv={spec.vehicle_count} | "
            f"days={spec.service_days} | slots={len(req.vehicles)}",
            flush=True,
        )
        generated_paths.append((spec, path, req))

    if args.generate_only:
        return 0

    client = TestClient(app, raise_server_exceptions=False)
    summary_rows = []
    selected = set(args.only or [])

    for spec, path, req in generated_paths:
        if selected and spec.file_name not in selected:
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        started = time.perf_counter()
        res = client.post("/optimize-fleet/candidates", json=payload)
        elapsed = round(time.perf_counter() - started, 3)

        if res.status_code != 200:
            row = {
                "file": spec.file_name,
                "orders": len(req.orders),
                "items": sum(len(o.items) for o in req.orders),
                "vehicles": spec.vehicle_count,
                "drivers": spec.vehicle_count,
                "days": spec.service_days,
                "http_status": res.status_code,
                "elapsed_seconds": elapsed,
                "error": res.text[:400],
            }
            summary_rows.append(row)
            print(f"[FAIL] {spec.file_name} -> HTTP {res.status_code} ({elapsed}s)", flush=True)
            continue

        batch = FleetOptimizationBatchResponse.model_validate(res.json())
        if not batch.candidates:
            row = {
                "file": spec.file_name,
                "orders": len(req.orders),
                "items": sum(len(o.items) for o in req.orders),
                "vehicles": spec.vehicle_count,
                "drivers": spec.vehicle_count,
                "days": spec.service_days,
                "http_status": res.status_code,
                "elapsed_seconds": elapsed,
                "status": batch.no_plan_status or "NO_CANDIDATES",
                "candidates": 0,
                "diagnostics": batch.diagnostics,
            }
            summary_rows.append(row)
            print(f"[NO_PLAN] {spec.file_name} -> {batch.no_plan_status} ({elapsed}s): {batch.diagnostics}", flush=True)
            continue

        best = batch.candidates[0].result
        audit = audit_response(req, best)
        phys_used = len({r.plate_number for r in best.routes})
        span_days = max((r.service_day_index + 1 for r in best.routes), default=0)
        row = {
            "file": spec.file_name,
            "orders": len(req.orders),
            "items": sum(len(o.items) for o in req.orders),
            "vehicles": spec.vehicle_count,
            "drivers": spec.vehicle_count,
            "days_available": spec.service_days,
            "owner_mode": spec.owner_mode,
            "http_status": res.status_code,
            "elapsed_seconds": elapsed,
            "status": best.status,
            "strategy": batch.candidates[0].search_strategy,
            "candidates": len(batch.candidates),
            "served_orders": len(req.orders) - len(best.unassigned_orders),
            "unassigned_orders": len(best.unassigned_orders),
            "routes": len(best.routes),
            "physical_vehicles_used": phys_used,
            "planning_span_days": span_days,
            "total_distance_km": best.total_distance_km,
            "total_cost_vnd": best.total_cost_vnd,
            "selection_score_vnd": (
                best.planning_objective.selection_score_vnd if best.planning_objective else None
            ),
            "savings_vs_direct_percent": (
                best.benchmarks.savings_vs_direct_percent if best.benchmarks else None
            ),
            "audit": audit,
            "diagnostics": best.diagnostics[:4],
        }
        summary_rows.append(row)
        print(
            f"[DONE] {spec.file_name} | {best.status} | {row['served_orders']}/{row['orders']} orders | "
            f"routes={row['routes']} (phys={phys_used}, span={span_days}d) | "
            f"dist={best.total_distance_km:.1f}km | cost={best.total_cost_vnd:,}đ | "
            f"tiers={audit['peak_tiers']} | stacked={audit['peak_stacked_items']} | "
            f"audit={'PASS' if audit['audit_pass'] else 'FAIL'} | {elapsed}s",
            flush=True,
        )

    summary_path = OUTPUT_DIR / "results_summary.json"
    summary_path.write_text(json.dumps(summary_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSaved summary to {summary_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
