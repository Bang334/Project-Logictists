import json
import sys
import itertools
sys.stdout.reconfigure(encoding='utf-8')

from app.models import FleetOptimizationRequest, StopAction, ScheduledStop
from app.routing_solver import FleetRoutingSolver
from app.spatial_validator import SpatialValidator

with open("test_full_payload.json", "r", encoding="utf-8") as f:
    data = json.load(f)

req = FleetOptimizationRequest(**data)
solver = FleetRoutingSolver(req)

# Lấy 3 nhóm đơn hàng mà OR-Tools ban đầu đã phân bổ cho 3 xe:
# Xe 0 (29C-678.92): 3 đơn
orders_v0 = [solver.order_by_id[oid] for oid in ['a6677b8a-6dea-4b49-806a-8998f21c202e', 'd2e3f815-71c7-4e4f-9254-7b3030fce497', 'bb2980db-25cb-4bad-8c9b-fdc882b94dc1']]

# Xe 2 (29H-842.15): 4 đơn
orders_v2 = [solver.order_by_id[oid] for oid in ['b0c55f23-2d86-4649-a5ba-19482c007fcc', '8263a7df-ee45-4bde-b0ff-0f0dd5648d86', '50ab9b34-5d58-48ec-b632-faae8bb9c231', '6f6b7d67-bee0-4722-b9d9-b3d7dceb0290']]

def generate_lifo_sequences(orders):
    """
    Sinh các chuỗi dừng thỏa mãn nguyên tắc LIFO (hàng bốc sau dỡ trước hoặc tách biệt).
    Không bao giờ có cặp A, B mà P(A) < P(B) < D(A) < D(B).
    """
    n = len(orders)
    nodes = []
    for o in orders:
        nodes.append((o.id, "PICKUP", o))
        nodes.append((o.id, "DELIVERY", o))
    
    valid_sequences = []
    
    # Đệ quy sinh chuỗi dừng hợp lệ với ngăn xếp LIFO
    def backtrack(current_seq, stack, remaining_pickups):
        if len(current_seq) == 2 * n:
            valid_sequences.append(list(current_seq))
            return
        
        # 1. Có thể pickup thêm đơn hàng mới (nếu còn)
        for o in remaining_pickups:
            rem = [x for x in remaining_pickups if x.id != o.id]
            current_seq.append((o.id, "PICKUP", o))
            stack.append(o.id)
            backtrack(current_seq, stack, rem)
            stack.pop()
            current_seq.pop()
            
        # 2. Có thể delivery đơn hàng ở đỉnh ngăn xếp (LIFO chuẩn xác!)
        if stack:
            top_order_id = stack[-1]
            top_order = next(o for o in orders if o.id == top_order_id)
            current_seq.append((top_order_id, "DELIVERY", top_order))
            stack.pop()
            backtrack(current_seq, stack, remaining_pickups)
            stack.append(top_order_id)
            current_seq.pop()

    backtrack([], [], list(orders))
    return valid_sequences

print("Testing LIFO generator:")
seqs_v0 = generate_lifo_sequences(orders_v0)
print(f"Xe 0 (3 đơn): Sinh được {len(seqs_v0)} chuỗi LIFO hoàn hảo!")

# Thử nghiệm kiểm tra trên Xe 0:
vehicle0 = solver.request.vehicles[0]
val0 = SpatialValidator(vehicle0)
node_id_to_idx = {node["id"]: idx for idx, node in enumerate(solver.nodes)}

best_score = float("inf")
best_res = None

for seq in seqs_v0:
    actions = []
    for i, (oid, st_type, o) in enumerate(seq, 1):
        if st_type == "PICKUP":
            actions.append(StopAction(stop_id=o.pickup_location.id, sequence=i, stop_type="PICKUP", address=o.pickup_location.name, latitude=o.pickup_location.latitude, longitude=o.pickup_location.longitude, items_to_load=o.items))
        else:
            actions.append(StopAction(stop_id=o.delivery_location.id, sequence=i, stop_type="DELIVERY", address=o.delivery_location.name, latitude=o.delivery_location.latitude, longitude=o.delivery_location.longitude, items_to_unload=[it.id for it in o.items]))
    
    eval_res = solver._evaluate_resequence_candidate(vehicle0, 0, actions, node_id_to_idx)
    if eval_res is not None and eval_res[2] < best_score:
        sp = val0.validate_plan(actions)
        if sp.is_valid:
            best_score = eval_res[2]
            best_res = (eval_res, actions, sp)

if best_res:
    print(">>> THÀNH CÔNG RỰC RỠ CHO XE 0! Tìm thấy phương án LIFO hợp lệ 100%!")
    sched, dist, score, dur = best_res[0]
    print(f"Quãng đường: {dist/1000:.2f}km, Thời gian: {dur/60:.1f}phút, Spatial Valid: True!")
    for st in sched:
        print(f"  Stop {st.sequence}: [{st.stop_type}] {st.location_name} (Order: {st.order_id})")
else:
    print("Xe 0 chưa tìm được chuỗi thỏa cả time window.")

# Tương tự thử nghiệm cho Xe 2 (4 đơn):
print("\nTesting for Xe 2 (4 đơn):")
seqs_v2 = generate_lifo_sequences(orders_v2)
print(f"Xe 2 (4 đơn): Sinh được {len(seqs_v2)} chuỗi LIFO hoàn hảo!")

vehicle2 = solver.request.vehicles[2]
val2 = SpatialValidator(vehicle2)
best_score2 = float("inf")
best_res2 = None

for seq in seqs_v2:
    actions = []
    for i, (oid, st_type, o) in enumerate(seq, 1):
        if st_type == "PICKUP":
            actions.append(StopAction(stop_id=o.pickup_location.id, sequence=i, stop_type="PICKUP", address=o.pickup_location.name, latitude=o.pickup_location.latitude, longitude=o.pickup_location.longitude, items_to_load=o.items))
        else:
            actions.append(StopAction(stop_id=o.delivery_location.id, sequence=i, stop_type="DELIVERY", address=o.delivery_location.name, latitude=o.delivery_location.latitude, longitude=o.delivery_location.longitude, items_to_unload=[it.id for it in o.items]))
    
    eval_res = solver._evaluate_resequence_candidate(vehicle2, 2, actions, node_id_to_idx)
    if eval_res is not None and eval_res[2] < best_score2:
        sp = val2.validate_plan(actions)
        if sp.is_valid:
            best_score2 = eval_res[2]
            best_res2 = (eval_res, actions, sp)

if best_res2:
    print(">>> THÀNH CÔNG RỰC RỠ CHO XE 2! Tìm thấy phương án LIFO hợp lệ 100%!")
    sched, dist, score, dur = best_res2[0]
    print(f"Quãng đường: {dist/1000:.2f}km, Thời gian: {dur/60:.1f}phút, Spatial Valid: True!")
    for st in sched:
        print(f"  Stop {st.sequence}: [{st.stop_type}] {st.location_name} (Order: {st.order_id})")
else:
    print("Xe 2 chưa tìm được chuỗi thỏa cả time window.")
