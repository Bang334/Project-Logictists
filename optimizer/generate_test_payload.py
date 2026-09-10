import json
import math
import sys

# Đọc snapshot
with open("debug_snapshot.json", "r", encoding="utf-8") as f:
    snapshot = json.load(f)

# Tính ma trận khoảng cách xấp xỉ dựa trên tọa độ (Haversine * 1.3 hệ số đường bộ)
def haversine_distance(lat1, lon1, lat2, lon2):
    R = 6371000  # meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c * 1.35  # hệ số đường bộ thực tế tại VN

coords = []
for v in snapshot["vehicles"]:
    coords.append((v["depot"]["latitude"], v["depot"]["longitude"]))
for o in snapshot["orders"]:
    coords.append((o["pickup_location"]["latitude"], o["pickup_location"]["longitude"]))
    coords.append((o["delivery_location"]["latitude"], o["delivery_location"]["longitude"]))

n = len(coords)
dist_matrix = [[0.0] * n for _ in range(n)]
dur_matrix = [[0.0] * n for _ in range(n)]
avg_speed_mps = 35 * 1000 / 3600  # 35 km/h trong đô thị/ngoại ô

for i in range(n):
    for j in range(n):
        if i != j:
            d = haversine_distance(coords[i][0], coords[i][1], coords[j][0], coords[j][1])
            dist_matrix[i][j] = d
            dur_matrix[i][j] = d / avg_speed_mps

payload = {
    "job_id": "test-debug",
    "vehicles": snapshot["vehicles"],
    "drivers": snapshot["drivers"],
    "orders": snapshot["orders"],
    "policy": snapshot["policy"],
    "max_time_seconds": 10,
    "distance_matrix_meters": dist_matrix,
    "duration_matrix_seconds": dur_matrix,
}

with open("test_full_payload.json", "w", encoding="utf-8") as f:
    json.dump(payload, f)

print(f"Generated test payload with {n} nodes matrix successfully.")
