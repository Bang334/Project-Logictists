import json
import sys
sys.stdout.reconfigure(encoding='utf-8')

from app.models import FleetOptimizationRequest
from app.routing_solver import FleetRoutingSolver

with open("test_full_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

req = FleetOptimizationRequest(**data)
solver = FleetRoutingSolver(req)
resp = solver.solve()

print("Status:", resp.status)
print("Routes count:", len(resp.routes))
for r in resp.routes:
    print(f"\n==========================================")
    print(f"Vehicle: {r.plate_number}, distance: {r.total_distance_km}km, duration: {r.total_duration_minutes}m, stops: {len(r.stops)}")
    for st in r.stops:
        print(f"  Stop {st.sequence}: [{st.stop_type}] {st.location_name} (order: {st.order_id})")
        print(f"     Arr: {st.arrival_time_sec}s, Dep: {st.departure_time_sec}s, Weight: {st.current_weight_kg}kg")
        print(f"     Items loaded: {st.items_loaded}")
        print(f"     Items unloaded: {st.items_unloaded}")
    if r.spatial_validation:
        print(f"  Spatial valid: {r.spatial_validation.is_valid}, MaxWeight: {r.spatial_validation.max_weight_kg}kg, MaxArea: {r.spatial_validation.max_area_cm2}cm2")
        if not r.spatial_validation.is_valid:
            print(f"  Spatial error: {r.spatial_validation.error_message}")

print(f"\n==========================================")
print("Unassigned orders count:", len(resp.unassigned_orders))
for u in resp.unassigned_orders:
    print(f" - {u.order_number}: [{u.reason_code}] {u.reason_message}")
