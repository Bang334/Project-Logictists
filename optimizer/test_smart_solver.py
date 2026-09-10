import json
import sys
sys.stdout.reconfigure(encoding='utf-8')

from app.models import FleetOptimizationRequest
from app.routing_solver import FleetRoutingSolver
from smart_validator_test import SmartSpatialValidator

with open("test_full_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

req = FleetOptimizationRequest(**data)
solver = FleetRoutingSolver(req)

# Chúng ta thử dùng SmartSpatialValidator thay thế trong solver
import app.routing_solver
app.routing_solver.SpatialValidator = SmartSpatialValidator

resp = solver.solve()
print("\n--- KẾT QUẢ KHI DÙNG SMART SPATIAL VALIDATOR ---")
print("Status:", resp.status)
print("Routes count:", len(resp.routes))
for r in resp.routes:
    print(f"Vehicle: {r.plate_number}, distance: {r.total_distance_km}km, stops: {len(r.stops)}")
    print(f"  Spatial valid: {r.spatial_validation.is_valid}")
    for st in r.stops:
        print(f"    Stop {st.sequence}: [{st.stop_type}] {st.location_name}")

print("\nUnassigned orders count:", len(resp.unassigned_orders))
for u in resp.unassigned_orders:
    print(f" - {u.order_number}: [{u.reason_code}] {u.reason_message}")
