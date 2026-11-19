"""Replay 120 synthetic cargo orders on a preserved road matrix."""
import copy
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
from fastapi.testclient import TestClient
from app.main import app
from app.models import FleetOptimizationRequest


def main():
    payload = json.loads(Path("benchmarks/stress_3d_multiday_20261118/input.json").read_text(encoding="utf-8"))
    reference_path = Path("benchmarks/cases/db_danang_30_orders.json")
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    reference_vehicle_count = len(reference["vehicles"])
    mapping = [0] * len(payload["vehicles"])
    for index, order in enumerate(payload["orders"]):
        source_index = index % len(reference["orders"])
        source = reference["orders"][source_index]
        for name in ("pickup_location", "delivery_location"):
            order[name] = copy.deepcopy(source[name])
        mapping.extend([reference_vehicle_count + 2 * source_index, reference_vehicle_count + 2 * source_index + 1])
    for vehicle in payload["vehicles"]:
        vehicle["depot"] = copy.deepcopy(reference["vehicles"][0]["depot"])
    for name in ("distance_matrix_meters", "duration_matrix_seconds"):
        matrix = reference[name]
        payload[name] = [[matrix[a][b] for b in mapping] for a in mapping]
    payload["job_id"] = "stress-3d-road-matrix-seven-days"
    FleetOptimizationRequest.model_validate(payload)
    output = Path("benchmarks/stress_3d_road_multiday_20261118")
    output.mkdir(exist_ok=True)
    (output / "input.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    provenance = dict(
        matrix_source=str(reference_path),
        matrix_method="Submatrix and repeated nodes from preserved operational snapshot. No new provider requests.",
        location_pairs=30,
        orders_per_location_pair=4,
        physical_vehicles=20,
        vehicle_day_slots=140,
        days=7,
        cargo_items=1260,
        cost_parameters="Unchanged synthetic benchmark costs",
        search_budget_seconds=30,
    )
    (output / "provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    started = time.perf_counter()
    response = TestClient(app, raise_server_exceptions=False).post("/optimize-fleet/candidates", json=payload)
    record = dict(elapsed_seconds=time.perf_counter()-started, http_status=response.status_code, response=response.json() if response.status_code==200 else response.text)
    (output / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print("SAVED", record["http_status"], record["elapsed_seconds"], flush=True)


if __name__ == "__main__":
    main()
