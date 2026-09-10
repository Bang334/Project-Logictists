import json
import sys
sys.stdout.reconfigure(encoding='utf-8')

from app.models import FleetOptimizationRequest
from app.routing_solver import FleetRoutingSolver
from app.spatial_validator import SpatialValidator

with open("test_full_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

req = FleetOptimizationRequest(**data)
solver = FleetRoutingSolver(req)

# Chúng ta inspect xem OR-Tools sinh ra những routes nào
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

# Chạy giải
resp = solver.solve()

print("Rejected reasons:")
for u in resp.unassigned_orders:
    print(f" - {u.order_number}: {u.reason_message}")
