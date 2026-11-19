"""Build the 150-order Da Nang 3D benchmark dataset from the latest UI snapshot + updated pickup coordinates."""
import json
import math
from pathlib import Path
from typing import Dict, List, Tuple


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * r * math.asin(math.sqrt(a))


def build_dataset(
    base_payload_path: Path,
    pickups_map_path: Path,
    output_path: Path,
    road_factor: float = 1.32,
    avg_speed_kmh: float = 34.0,
) -> Path:
    payload = json.loads(base_payload_path.read_text(encoding="utf-8"))
    pickups_map: Dict[str, dict] = json.loads(pickups_map_path.read_text(encoding="utf-8"))

    for order in payload["orders"]:
        updated = pickups_map.get(order["id"])
        if updated:
            order["pickup_location"]["name"] = updated["name"]
            order["pickup_location"]["latitude"] = updated["latitude"]
            order["pickup_location"]["longitude"] = updated["longitude"]

    nodes: List[Tuple[float, float]] = [
        (float(v["depot"]["latitude"]), float(v["depot"]["longitude"]))
        for v in payload["vehicles"]
    ]
    for order in payload["orders"]:
        nodes.append((float(order["pickup_location"]["latitude"]), float(order["pickup_location"]["longitude"])))
        nodes.append((float(order["delivery_location"]["latitude"]), float(order["delivery_location"]["longitude"])))

    n = len(nodes)
    dist_matrix = [[0] * n for _ in range(n)]
    dur_matrix = [[0] * n for _ in range(n)]
    speed_mps = avg_speed_kmh * 1000.0 / 3600.0
    for i in range(n):
        lat1, lon1 = nodes[i]
        row_d = dist_matrix[i]
        row_t = dur_matrix[i]
        for j in range(n):
            if i == j:
                continue
            lat2, lon2 = nodes[j]
            d_m = int(round(haversine_meters(lat1, lon1, lat2, lon2) * road_factor))
            row_d[j] = max(50, d_m)
            row_t[j] = max(10, int(round(row_d[j] / speed_mps)))

    payload["distance_matrix_meters"] = dist_matrix
    payload["duration_matrix_seconds"] = dur_matrix
    output_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return output_path


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    scratch = Path(
        r"C:\Users\BANG\.gemini\antigravity\brain\ac082e9e-7c32-4902-9a6a-a441f14285e4\scratch"
    )
    out = build_dataset(
        scratch / "job_3accb505_payload.json",
        scratch / "danang_pickups.json",
        here / "dataset_danang_150_3d.json",
    )
    print("Built dataset:", out)
