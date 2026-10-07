"""Generate deterministic, higher-complexity benchmark datasets.

The scenarios vary temporal tightness, fleet geometry, dynamic floor reuse,
multi-depot/multi-day routing and fragmented 2D packing pressure.
"""

import json
import os
import random
import sys
from typing import Dict, List, Tuple

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from algo_lab.generate_benchmark_scenarios import build_payload


def _vehicle(
    scenario: str,
    index: int,
    depot: Tuple[str, float, float],
    *,
    length: float,
    width: float,
    height: float,
    payload: float,
    fuel: float,
    fixed_cost: int,
) -> Dict:
    depot_name, latitude, longitude = depot
    return {
        "id": f"veh-{scenario}-{index}",
        "plate_number": f"TEST-{scenario.upper()}-{index:02d}",
        "length_cm": length,
        "width_cm": width,
        "height_cm": height,
        "payload_limit_kg": payload,
        "door_position": "REAR",
        "fuel_consumption_liters_per_100_km": fuel,
        "load_fuel_surcharge_percent_at_full_payload": 22.0,
        "fixed_operating_cost_vnd": fixed_cost,
        "depot": {
            "id": f"depot-{scenario}-{index}",
            "name": depot_name,
            "latitude": latitude,
            "longitude": longitude,
        },
    }


def _item(
    scenario: str,
    order_index: int,
    item_index: int,
    length: float,
    width: float,
    height: float,
    weight: float,
) -> Dict:
    return {
        "id": f"item-{scenario}-{order_index}-{item_index}",
        "order_id": f"order-{scenario}-{order_index}",
        "length_cm": length,
        "width_cm": width,
        "height_cm": height,
        "weight_kg": weight,
        "can_rotate": True,
        "description": f"Kiện {scenario} {order_index}.{item_index}",
    }


def _order(
    scenario: str,
    index: int,
    pickup: Tuple[float, float],
    delivery: Tuple[float, float],
    items: List[Dict],
    windows: Tuple[int, int, int, int],
    service_time_sec: int,
) -> Dict:
    pickup_start, pickup_end, delivery_start, delivery_end = windows
    return {
        "id": f"order-{scenario}-{index}",
        "order_number": f"ORD-{scenario.upper()}-{index:03d}",
        "pickup_location": {
            "id": f"pickup-{scenario}-{index}",
            "name": f"Điểm lấy {scenario} {index}",
            "latitude": pickup[0],
            "longitude": pickup[1],
        },
        "delivery_location": {
            "id": f"delivery-{scenario}-{index}",
            "name": f"Điểm giao {scenario} {index}",
            "latitude": delivery[0],
            "longitude": delivery[1],
        },
        "items": items,
        "service_time_sec": service_time_sec,
        "pickup_window_start_sec": pickup_start,
        "pickup_window_end_sec": pickup_end,
        "delivery_window_start_sec": delivery_start,
        "delivery_window_end_sec": delivery_end,
        "order_value_vnd": 20_000_000 + index * 750_000,
    }


def _with_profile(payload: Dict, challenge: str, seed: int) -> Dict:
    payload["scenario_profile"] = {
        "challenge": challenge,
        "seed": seed,
        "generated": True,
    }
    return payload


def create_tight_windows() -> Dict:
    seed = 404
    rng = random.Random(seed)
    depot = ("Hub nội đô time-window", 21.028, 105.854)
    vehicles = [
        _vehicle(
            "tw",
            index,
            depot,
            length=500,
            width=205,
            height=210,
            payload=3_500,
            fuel=13.5,
            fixed_cost=95_000,
        )
        for index in range(1, 10)
    ]
    orders = []
    for index in range(1, 19):
        slot = (index - 1) % 6
        pickup_start = slot * 1_800
        items = [
            _item("tw", index, item_index, 70, 55, 60, 80)
            for item_index in range(1, rng.randint(2, 5))
        ]
        orders.append(
            _order(
                "tw",
                index,
                (21.00 + rng.random() * 0.07, 105.80 + rng.random() * 0.08),
                (20.99 + rng.random() * 0.09, 105.81 + rng.random() * 0.09),
                items,
                (
                    pickup_start,
                    pickup_start + 7_200,
                    pickup_start + 1_800,
                    pickup_start + 12_600,
                ),
                420,
            )
        )
    return _with_profile(
        build_payload("scenario_4_tight_windows", vehicles, orders),
        "18 đơn nội đô, time window chặt và lệch pha",
        seed,
    )


def create_heterogeneous_fleet() -> Dict:
    seed = 505
    rng = random.Random(seed)
    depot = ("Hub đội xe hỗn hợp", 10.82, 106.68)
    specs = (
        (4, 320, 165, 180, 1_200, 10.0, 60_000),
        (4, 520, 210, 220, 3_500, 14.0, 105_000),
        (4, 720, 240, 240, 7_000, 20.0, 180_000),
    )
    vehicles = []
    index = 1
    for count, length, width, height, payload, fuel, fixed in specs:
        for _ in range(count):
            vehicles.append(
                _vehicle(
                    "mix",
                    index,
                    depot,
                    length=length,
                    width=width,
                    height=height,
                    payload=payload,
                    fuel=fuel,
                    fixed_cost=fixed,
                )
            )
            index += 1
    orders = []
    for order_index in range(1, 21):
        if order_index % 7 == 0:
            items = [_item("mix", order_index, 1, 500, 220, 210, 2_800)]
        elif order_index % 5 == 0:
            items = [
                _item("mix", order_index, 1, 260, 180, 180, 1_500),
                _item("mix", order_index, 2, 180, 120, 150, 700),
            ]
        else:
            items = [
                _item(
                    "mix",
                    order_index,
                    item_index,
                    rng.choice([80, 100, 120]),
                    rng.choice([55, 70, 85]),
                    rng.choice([60, 90, 120]),
                    rng.choice([90, 140, 220]),
                )
                for item_index in range(1, rng.randint(2, 6))
            ]
        orders.append(
            _order(
                "mix",
                order_index,
                (10.70 + rng.random() * 0.25, 106.55 + rng.random() * 0.25),
                (10.68 + rng.random() * 0.30, 106.50 + rng.random() * 0.35),
                items,
                (0, 28_800, 3_600, 50_400),
                720,
            )
        )
    return _with_profile(
        build_payload("scenario_5_heterogeneous_fleet", vehicles, orders),
        "20 đơn với van, xe tải vừa và xe lớn có chi phí/kích thước khác nhau",
        seed,
    )


def create_dynamic_reuse() -> Dict:
    seed = 606
    rng = random.Random(seed)
    depot = ("Hub tái sử dụng sàn", 16.06, 108.20)
    vehicles = [
        _vehicle(
            "reuse",
            index,
            depot,
            length=500,
            width=200,
            height=220,
            payload=4_000,
            fuel=15.0,
            fixed_cost=110_000,
        )
        for index in range(1, 7)
    ]
    orders = []
    for index in range(1, 15):
        phase = 0 if index <= 7 else 1
        length = 235 if index % 3 else 200
        items = [
            _item("reuse", index, 1, length, 95, 150, 650),
            _item("reuse", index, 2, length, 95, 150, 650),
        ]
        base = 16.02 + (index % 5) * 0.018
        orders.append(
            _order(
                "reuse",
                index,
                (base, 108.16 + rng.random() * 0.10),
                (base + 0.025, 108.17 + rng.random() * 0.10),
                items,
                (
                    phase * 10_800,
                    phase * 10_800 + 18_000,
                    phase * 10_800 + 3_600,
                    phase * 10_800 + 28_800,
                ),
                600,
            )
        )
    return _with_profile(
        build_payload("scenario_6_dynamic_reuse", vehicles, orders),
        "14 đơn kiện lớn ép giao-lấy xen kẽ và tái sử dụng vùng trống",
        seed,
    )


def create_multi_depot_overnight() -> Dict:
    seed = 707
    rng = random.Random(seed)
    depots = (
        ("Depot Hà Nội", 21.03, 105.85),
        ("Depot Hải Phòng", 20.85, 106.68),
        ("Depot Nam Định", 20.43, 106.17),
    )
    vehicles = []
    for depot_index, depot in enumerate(depots):
        for local_index in range(3):
            index = depot_index * 3 + local_index + 1
            vehicles.append(
                _vehicle(
                    "night",
                    index,
                    depot,
                    length=620,
                    width=220,
                    height=230,
                    payload=5_500,
                    fuel=17.0,
                    fixed_cost=135_000,
                )
            )
    hubs = [(d[1], d[2]) for d in depots]
    orders = []
    for index in range(1, 19):
        source = hubs[(index - 1) % len(hubs)]
        target = hubs[index % len(hubs)]
        day_offset = 0 if index <= 9 else 86_400
        items = [
            _item("night", index, item_index, 100, 70, 90, 180)
            for item_index in range(1, rng.randint(3, 7))
        ]
        orders.append(
            _order(
                "night",
                index,
                (source[0] + rng.uniform(-0.03, 0.03), source[1] + rng.uniform(-0.03, 0.03)),
                (target[0] + rng.uniform(-0.03, 0.03), target[1] + rng.uniform(-0.03, 0.03)),
                items,
                (
                    day_offset,
                    day_offset + 32_400,
                    day_offset + 7_200,
                    day_offset + 57_600,
                ),
                900,
            )
        )
    return _with_profile(
        build_payload("scenario_7_multi_depot_overnight", vehicles, orders),
        "18 đơn qua 3 depot và cửa sổ thời gian kéo sang ngày thứ hai",
        seed,
    )


def create_dense_fragmentation() -> Dict:
    seed = 808
    rng = random.Random(seed)
    depot = ("Hub đóng ghép mật độ cao", 10.95, 106.80)
    vehicles = [
        _vehicle(
            "dense",
            index,
            depot,
            length=600,
            width=220,
            height=220,
            payload=5_000,
            fuel=16.0,
            fixed_cost=120_000,
        )
        for index in range(1, 9)
    ]
    shapes = ((130, 55), (110, 70), (95, 80), (80, 65), (150, 45))
    orders = []
    for index in range(1, 17):
        items = []
        for item_index in range(1, rng.randint(6, 11)):
            length, width = rng.choice(shapes)
            items.append(
                _item(
                    "dense",
                    index,
                    item_index,
                    length,
                    width,
                    rng.choice([80, 110, 140]),
                    rng.choice([70, 100, 140]),
                )
            )
        orders.append(
            _order(
                "dense",
                index,
                (10.84 + rng.random() * 0.20, 106.68 + rng.random() * 0.20),
                (10.82 + rng.random() * 0.24, 106.66 + rng.random() * 0.24),
                items,
                (0, 32_400, 3_600, 57_600),
                840,
            )
        )
    return _with_profile(
        build_payload("scenario_8_dense_fragmentation", vehicles, orders),
        "16 đơn nhiều hình chữ nhật gây áp lực phân mảnh sàn và đường dỡ",
        seed,
    )


SCENARIOS = (
    ("scenario_4_tight_windows.json", create_tight_windows),
    ("scenario_5_heterogeneous_fleet.json", create_heterogeneous_fleet),
    ("scenario_6_dynamic_reuse.json", create_dynamic_reuse),
    ("scenario_7_multi_depot_overnight.json", create_multi_depot_overnight),
    ("scenario_8_dense_fragmentation.json", create_dense_fragmentation),
)


def main() -> None:
    target_dir = os.path.join(os.path.dirname(__file__), "datasets")
    os.makedirs(target_dir, exist_ok=True)
    for filename, factory in SCENARIOS:
        payload = factory()
        path = os.path.join(target_dir, filename)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        print(
            f"{filename}: {len(payload['orders'])} đơn, "
            f"{len(payload['vehicles'])} xe, "
            f"{sum(len(order['items']) for order in payload['orders'])} kiện"
        )


if __name__ == "__main__":
    main()
