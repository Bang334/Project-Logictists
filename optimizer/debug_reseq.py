import json
import sys
import itertools
sys.stdout.reconfigure(encoding='utf-8')

from app.models import FleetOptimizationRequest, StopAction, ScheduledStop
from app.routing_solver import FleetRoutingSolver
from app.spatial_validator import SpatialValidator
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

with open("test_full_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

req = FleetOptimizationRequest(**data)
solver = FleetRoutingSolver(req)

# Hãy xem các xe bị reject:
# Xe 0: 29C-678.92
# Xe 1: 29D-528.36 (thành công)
# Xe 2: 29H-842.15

# Chúng ta chạy solve của FleetRoutingSolver nhưng thêm print
# Hãy xem các hàm của solver
resp = solver.solve()
