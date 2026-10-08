"""Generate diverse benchmark scenarios for TMS Algorithm Lab.

Guarantees:
- Every cargo item can fit into at least one vehicle in the fleet (dimension & payload).
- Scenarios cover diverse logistical challenges:
  1. Multi-item intensive (many items per order, packing bottleneck).
  2. Heavy cargo (heavy payload, requires multi-vehicle dispatching).
  3. Dispersed geography (wide geographic distances, routing bottleneck).
"""

import json
import math
import os
import random
import sys
from typing import Dict, List

sys.stdout.reconfigure(encoding="utf-8")


def create_scenario_multi_item():
    """Scenario 1: Multi-item intensive (Đơn có rất nhiều kiện hàng)."""
    vehicles = [
        {
            "id": f"veh-mi-{i}",
            "plate_number": f"29C-MI.{i:03d}",
            "length_cm": 520.0,
            "width_cm": 210.0,
            "height_cm": 210.0,
            "payload_limit_kg": 3500.0,
            "door_position": "REAR",
            "fuel_consumption_liters_per_100_km": 14.0,
            "load_fuel_surcharge_percent_at_full_payload": 20.0,
            "fixed_operating_cost_vnd": 100000,
            "depot": {"id": "depot-han", "name": "Kho Tổng Long Biên", "latitude": 21.034, "longitude": 105.908},
        }
        for i in range(1, 7)
    ]

    orders = []
    # 10 orders, each with 15 to 22 items
    random.seed(42)
    for ord_idx in range(1, 11):
        num_items = random.randint(15, 22)
        items = []
        for it_idx in range(1, num_items + 1):
            # Box dimensions guaranteed to fit in 520x210x210 vehicle
            l = float(random.choice([30, 40, 50, 60]))
            w = float(random.choice([25, 30, 40, 45]))
            h = float(random.choice([20, 25, 35, 40]))
            weight = float(random.choice([15, 20, 25, 30, 40]))
            items.append({
                "id": f"item-mi-{ord_idx}-{it_idx}",
                "order_id": f"order-mi-{ord_idx}",
                "length_cm": l,
                "width_cm": w,
                "height_cm": h,
                "weight_kg": weight,
                "can_rotate": True,
                "description": f"Thùng hàng bán lẻ #{ord_idx}.{it_idx}"
            })

        orders.append({
            "id": f"order-mi-{ord_idx}",
            "order_number": f"ORD-MI-{ord_idx:03d}",
            "pickup_location": {
                "id": f"loc-p-mi-{ord_idx}",
                "name": f"Kho nguồn Miền Bắc {ord_idx}",
                "latitude": 21.0 + (ord_idx % 4) * 0.05,
                "longitude": 105.8 + (ord_idx % 5) * 0.05
            },
            "delivery_location": {
                "id": f"loc-d-mi-{ord_idx}",
                "name": f"Đại lý bán lẻ {ord_idx}",
                "latitude": 20.95 + (ord_idx % 5) * 0.06,
                "longitude": 105.75 + (ord_idx % 4) * 0.06
            },
            "items": items,
            "service_time_sec": 900,
            "pickup_window_start_sec": 3600,
            "pickup_window_end_sec": 28800,
            "delivery_window_start_sec": 7200,
            "delivery_window_end_sec": 43200,
            "order_value_vnd": 25000000
        })

    return build_payload("scenario_1_multi_item", vehicles, orders)


def create_scenario_heavy_cargo():
    """Scenario 2: Heavy cargo (Đơn tải trọng nặng, bắt buộc dùng nhiều xe)."""
    # Fleet with varied capacities: 2.5t, 3.5t, 5.0t, 7.0t
    capacities = [2500.0, 3500.0, 5000.0, 7000.0]
    vehicles = []
    for i, cap in enumerate(capacities * 2, start=1):
        vehicles.append({
            "id": f"veh-heavy-{i}",
            "plate_number": f"29H-HV.{i:03d}",
            "length_cm": 650.0 if cap >= 5000 else 480.0,
            "width_cm": 230.0 if cap >= 5000 else 200.0,
            "height_cm": 220.0,
            "payload_limit_kg": cap,
            "door_position": "REAR",
            "fuel_consumption_liters_per_100_km": 18.0 if cap >= 5000 else 13.0,
            "load_fuel_surcharge_percent_at_full_payload": 25.0,
            "fixed_operating_cost_vnd": 120000 if cap >= 5000 else 80000,
            "depot": {"id": "depot-heavy", "name": "Tổng kho cơ khí", "latitude": 21.02, "longitude": 105.88},
        })

    # 12 heavy industrial orders (800kg to 3,200kg)
    random.seed(101)
    orders = []
    for ord_idx in range(1, 13):
        # 1-3 heavy items per order, total 800 - 3200 kg
        num_items = random.randint(1, 3)
        items = []
        for it_idx in range(1, num_items + 1):
            w_kg = float(random.choice([600, 800, 1100, 1400]))
            items.append({
                "id": f"item-hv-{ord_idx}-{it_idx}",
                "order_id": f"order-hv-{ord_idx}",
                "length_cm": 140.0,
                "width_cm": 110.0,
                "height_cm": 120.0,
                "weight_kg": w_kg,
                "can_rotate": True,
                "description": f"Pallet thép/thiết bị nặng #{ord_idx}.{it_idx}"
            })

        orders.append({
            "id": f"order-hv-{ord_idx}",
            "order_number": f"ORD-HEAVY-{ord_idx:03d}",
            "pickup_location": {
                "id": f"loc-p-hv-{ord_idx}",
                "name": f"Nhà máy công nghiệp {ord_idx}",
                "latitude": 21.05 + (ord_idx % 4) * 0.04,
                "longitude": 105.85 + (ord_idx % 4) * 0.04
            },
            "delivery_location": {
                "id": f"loc-d-hv-{ord_idx}",
                "name": f"Khu xây lắp công trình {ord_idx}",
                "latitude": 20.92 + (ord_idx % 3) * 0.06,
                "longitude": 105.78 + (ord_idx % 4) * 0.05
            },
            "items": items,
            "service_time_sec": 1200,
            "pickup_window_start_sec": 3600,
            "pickup_window_end_sec": 28800,
            "delivery_window_start_sec": 7200,
            "delivery_window_end_sec": 43200,
            "order_value_vnd": 50000000
        })

    return build_payload("scenario_2_heavy_cargo", vehicles, orders)


def create_scenario_dispersed():
    """Scenario 3: Dispersed geographic routing (Địa bàn liên tỉnh phân tán rộng)."""
    vehicles = [
        {
            "id": f"veh-disp-{i}",
            "plate_number": f"29D-DISP.{i:03d}",
            "length_cm": 620.0,
            "width_cm": 220.0,
            "height_cm": 210.0,
            "payload_limit_kg": 5000.0,
            "door_position": "REAR",
            "fuel_consumption_liters_per_100_km": 16.0,
            "load_fuel_surcharge_percent_at_full_payload": 20.0,
            "fixed_operating_cost_vnd": 110000,
            "depot": {"id": "depot-disp", "name": "Hub Trung chuyển Liên tỉnh", "latitude": 21.03, "longitude": 105.90},
        }
        for i in range(1, 6)
    ]

    # Provincial hubs: Hanoi, Bac Ninh, Hung Yen, Hai Phong, Hai Duong, Ha Nam, Vinh Phuc
    provinces = [
        ("KCN Tiên Sơn, Bắc Ninh", 21.12, 106.01),
        ("KCN Phố Nối, Hưng Yên", 20.95, 106.05),
        ("Cảng Đình Vũ, Hải Phòng", 20.84, 106.75),
        ("KCN Đại An, Hải Dương", 20.93, 106.28),
        ("KCN Đồng Văn, Hà Nam", 20.62, 105.95),
        ("KCN Khai Quang, Vĩnh Phúc", 21.30, 105.61),
        ("KCN Quang Châu, Bắc Giang", 21.22, 106.09),
    ]

    orders = []
    random.seed(202)
    for ord_idx in range(1, 15):
        p_name, p_lat, p_lng = random.choice(provinces)
        d_name, d_lat, d_lng = random.choice(provinces)
        while d_lat == p_lat and d_lng == p_lng:
            d_name, d_lat, d_lng = random.choice(provinces)

        items = [
            {
                "id": f"item-disp-{ord_idx}-{k}",
                "order_id": f"order-disp-{ord_idx}",
                "length_cm": 80.0,
                "width_cm": 60.0,
                "height_cm": 70.0,
                "weight_kg": 90.0,
                "can_rotate": True,
                "description": f"Kiện hàng phân phối {k}"
            }
            for k in range(1, random.randint(3, 7))
        ]

        orders.append({
            "id": f"order-disp-{ord_idx}",
            "order_number": f"ORD-DISP-{ord_idx:03d}",
            "pickup_location": {"id": f"loc-p-disp-{ord_idx}", "name": f"Kho {p_name}", "latitude": p_lat, "longitude": p_lng},
            "delivery_location": {"id": f"loc-d-disp-{ord_idx}", "name": f"Điểm giao {d_name}", "latitude": d_lat, "longitude": d_lng},
            "items": items,
            "service_time_sec": 1200,
            "pickup_window_start_sec": 3600,
            "pickup_window_end_sec": 28800,
            "delivery_window_start_sec": 7200,
            "delivery_window_end_sec": 46800,
            "order_value_vnd": 35000000
        })

    return build_payload("scenario_3_dispersed", vehicles, orders)


def build_payload(job_id: str, vehicles: List[dict], orders: List[dict]) -> dict:
    drivers = [
        {
            "id": f"driver-{v['id']}",
            "full_name": f"Tài xế chuyên nghiệp {idx}",
            "license_class": "C",
            "fixed_salary_monthly_vnd": 12500000,
            "trip_base_pay_vnd": 160000,
            "per_km_pay_vnd": 1200,
        }
        for idx, v in enumerate(vehicles, start=1)
    ]

    # Build node list for distance/duration matrix
    nodes = []
    for v in vehicles:
        nodes.append(v["depot"])
    for o in orders:
        nodes.append(o["pickup_location"])
        nodes.append(o["delivery_location"])

    node_count = len(nodes)
    distance_matrix = []
    duration_matrix = []

    # Calculate real-like distances using Haversine formula
    for i in range(node_count):
        dist_row = []
        dur_row = []
        for j in range(node_count):
            if i == j:
                dist_row.append(0.0)
                dur_row.append(0.0)
            else:
                lat1, lon1 = nodes[i]["latitude"], nodes[i]["longitude"]
                lat2, lon2 = nodes[j]["latitude"], nodes[j]["longitude"]
                # Approximate distance in meters (1 deg lat ~ 111km)
                d_lat = (lat2 - lat1) * 111000
                d_lon = (lon2 - lon1) * 111000 * math.cos(math.radians(lat1))
                euclid_m = math.sqrt(d_lat**2 + d_lon**2)
                # Road winding factor: 1.35
                road_m = max(1000.0, euclid_m * 1.35)
                # Average speed: 40 km/h (11.1 m/s)
                road_sec = max(120.0, road_m / 11.1)
                dist_row.append(round(road_m, 1))
                dur_row.append(round(road_sec, 1))
        distance_matrix.append(dist_row)
        duration_matrix.append(dur_row)

    policy = {
        "monthly_working_minutes": 10560,
        "fuel_price_per_liter_vnd": 23800,
        "unassigned_order_penalty_vnd": 10000000,
        "cargo_holding_cost_vnd_per_ton_hour": 15000,
    }

    return {
        "job_id": job_id,
        "vehicles": vehicles,
        "drivers": drivers,
        "orders": orders,
        "policy": policy,
        "max_time_seconds": 15,
        "distance_matrix_meters": distance_matrix,
        "duration_matrix_seconds": duration_matrix,
    }


def main():
    target_dir = os.path.join(os.path.dirname(__file__), "datasets")
    os.makedirs(target_dir, exist_ok=True)

    scenarios = [
        ("scenario_1_multi_item.json", create_scenario_multi_item()),
        ("scenario_2_heavy_cargo.json", create_scenario_heavy_cargo()),
        ("scenario_3_dispersed.json", create_scenario_dispersed()),
    ]

    for fname, payload in scenarios:
        fpath = os.path.join(target_dir, fname)
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"✅ Đã tạo kịch bản: {fname} ({len(payload['orders'])} đơn, {len(payload['vehicles'])} xe, {sum(len(o['items']) for o in payload['orders'])} kiện)")


if __name__ == "__main__":
    main()
