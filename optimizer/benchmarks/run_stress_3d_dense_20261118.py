"""Build and run a bulky-cargo scenario on nearby preserved road locations."""
import copy
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
from app.models import FleetOptimizationRequest
from fastapi.testclient import TestClient
from app.main import app


def main():
    root = Path("benchmarks/stress_3d_dense_20261118")
    root.mkdir(exist_ok=True)
    payload = json.loads(Path("benchmarks/stress_3d_road_multiday_20261118/input.json").read_text(encoding="utf-8"))
    source = json.loads(Path("benchmarks/cases/db_danang_30_orders.json").read_text(encoding="utf-8"))
    source_vehicle_count = len(source["vehicles"])
    locations = {}
    for index, order in enumerate(source["orders"]):
        for offset, name in enumerate(("pickup_location", "delivery_location")):
            node = source_vehicle_count + 2 * index + offset
            location = order[name]
            key = (location["longitude"], location["latitude"])
            distance = max(source["distance_matrix_meters"][0][node], source["distance_matrix_meters"][node][0])
            if distance >= 100:
                locations[key] = (distance, node, location)
    nearby = sorted(locations.values(), key=lambda item: item[0])[:11]
    mapping = [0] * len(payload["vehicles"])
    pickup = dict(source["vehicles"][0]["depot"], name="Bãi lấy hàng thử nghiệm Hòa Cầm")
    original_volume = 0
    new_volume = 0
    for index, order in enumerate(payload["orders"]):
        destination = nearby[index % len(nearby)]
        order["pickup_location"] = copy.deepcopy(pickup)
        order["delivery_location"] = copy.deepcopy(destination[2])
        mapping.extend([0, destination[1]])
        for item_index, item in enumerate(order["items"]):
            original_volume += item["length_cm"] * item["width_cm"] * item["height_cm"] / 1e6
            group = item_index // 3
            item.update(
                length_cm=[100, 120, 150][(index + group) % 3],
                width_cm=[80, 100, 120][(index + group) % 3],
                height_cm=65 + 5 * ((index + group) % 4),
            )
            new_volume += item["length_cm"] * item["width_cm"] * item["height_cm"] / 1e6
    for name in ("distance_matrix_meters", "duration_matrix_seconds"):
        original = source[name]
        payload[name] = [[original[a][b] for b in mapping] for a in mapping]
    payload["job_id"] = "stress-danang-bulky-nearby-120"
    payload["search_time_seconds"] = 60
    FleetOptimizationRequest.model_validate(payload)
    data = json.dumps(payload, ensure_ascii=False, indent=2)
    (root / "input.json").write_text(data, encoding="utf-8")
    Path("benchmarks/cases/stress_3d_danang_dense_120_orders.json").write_text(data, encoding="utf-8")
    metadata = dict(
        orders=120, packages=1260, physical_vehicles=20, days=7,
        old_volume_m3=original_volume, volume_m3=new_volume, volume_multiplier=new_volume/original_volume,
        dimensions_cm=dict(length=[100,120,150],width=[80,100,120],height=[65,70,75,80]),
        delivery_locations=len(nearby), max_depot_round_direction_km=max(item[0] for item in nearby)/1000,
        matrix_source="Preserved db_danang_30_orders.json, exact node remapping",
    )
    (root / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print("GENERATED", json.dumps(metadata), flush=True)
    started = time.perf_counter()
    response = TestClient(app, raise_server_exceptions=False).post("/optimize-fleet/candidates", json=payload)
    result = dict(elapsed_seconds=time.perf_counter()-started, http_status=response.status_code,
                  response=response.json() if response.status_code == 200 else response.text)
    (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print("SAVED", response.status_code, result["elapsed_seconds"], flush=True)


if __name__ == "__main__":
    main()
