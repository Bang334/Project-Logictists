import json
import sys
sys.stdout.reconfigure(encoding='utf-8')

from app.models import FleetOptimizationRequest
from app.routing_solver import FleetRoutingSolver

with open("test_full_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

req = FleetOptimizationRequest(**data)
solver = FleetRoutingSolver(req)

# Chúng ta in ra phân bổ ban đầu của OR-Tools (trước khi validate spatial)
# Bằng cách chạy solve nhưng bỏ qua spatial check
import app.routing_solver

class MockSpatialValidator:
    def __init__(self, vehicle):
        pass
    def validate_plan(self, stops):
        from app.models import SpatialValidationResult
        return SpatialValidationResult(is_valid=True, max_weight_kg=0, max_area_cm2=0, step_states=[])

app.routing_solver.SpatialValidator = MockSpatialValidator
resp = solver.solve()

print("OR-Tools initial routes (Raw Routing without spatial check):")
for r in resp.routes:
    print(f"\nVehicle: {r.plate_number}, total_km: {r.total_distance_km}, total_stops: {len(r.stops)}")
    orders_in_route = set()
    for st in r.stops:
        orders_in_route.add(st.order_id)
        print(f"  Stop {st.sequence}: [{st.stop_type}] {st.location_name} (order: {st.order_id})")
    print(f"  -> Orders count: {len(orders_in_route)}, Orders: {list(orders_in_route)}")

print("\nUnassigned count:", len(resp.unassigned_orders))
