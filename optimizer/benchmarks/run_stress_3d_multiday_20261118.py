"""Replay the stress fixture with seven daily resource schedules."""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))

from fastapi.testclient import TestClient
from app.main import app
from app.models import FleetOptimizationRequest

def main():
    source = Path("benchmarks/stress_3d_concurrent_20261118/input.json")
    payload = json.loads(source.read_text(encoding="utf-8"))
    original_vehicles = payload["vehicles"]
    original_drivers = payload["drivers"]
    vehicles = []
    drivers = []
    for day in range(7):
        for vehicle in original_vehicles:
            vehicles.append(dict(
                vehicle,
                id=f"{vehicle['id']}#day{day}",
                source_vehicle_id=vehicle["id"],
                service_day_index=day,
                available_start_sec=day * 86400 + 8 * 3600,
                available_end_sec=day * 86400 + 17 * 3600,
            ))
        for driver in original_drivers:
            drivers.append(dict(
                driver,
                id=f"{driver['id']}#day{day}",
                source_driver_id=driver["id"],
                service_day_index=day,
            ))
    node_mapping = [
        index % len(original_vehicles) for index in range(len(vehicles))
    ] + list(range(len(original_vehicles), len(original_vehicles) + 2 * len(payload["orders"])))
    for name in ("distance_matrix_meters", "duration_matrix_seconds"):
        original = payload[name]
        payload[name] = [[original[a][b] for b in node_mapping] for a in node_mapping]
    payload["vehicles"] = vehicles
    payload["drivers"] = drivers
    for order in payload["orders"]:
        order.update(
            pickup_window_start_sec=8 * 3600,
            pickup_window_end_sec=6 * 86400 + 17 * 3600,
            delivery_window_start_sec=8 * 3600,
            delivery_window_end_sec=6 * 86400 + 17 * 3600,
        )
    payload["job_id"] = "stress-3d-seven-days"
    FleetOptimizationRequest.model_validate(payload)
    output = Path("benchmarks/stress_3d_multiday_20261118")
    output.mkdir(exist_ok=True)
    (output / "input.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    started = time.perf_counter()
    response = TestClient(app, raise_server_exceptions=False).post(
        "/optimize-fleet/candidates", json=payload,
    )
    record = dict(
        elapsed_seconds=time.perf_counter() - started,
        http_status=response.status_code,
        physical_vehicles=20,
        physical_drivers=20,
        resource_slots=140,
        planning_days=7,
        shift="08:00-17:00",
        search_budget_seconds=30,
        synthetic_matrix=True,
        response=response.json() if response.status_code == 200 else response.text,
    )
    (output / "result.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    print("SAVED", response.status_code, record["elapsed_seconds"], flush=True)

if __name__ == "__main__":
    main()
