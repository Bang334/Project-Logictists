import json

with open("debug_snapshot.json", "r", encoding="utf-8") as f:
    snapshot = json.load(f)

print("Vehicles count:", len(snapshot["vehicles"]))
for v in snapshot["vehicles"]:
    print(f"Vehicle: {v['plate_number']} - payload: {v['payload_limit_kg']}kg - L:{v['length_cm']} W:{v['width_cm']}")

print("\nOrders count:", len(snapshot["orders"]))
for o in snapshot["orders"]:
    p_win = (o.get("pickup_window_start_sec"), o.get("pickup_window_end_sec"))
    d_win = (o.get("delivery_window_start_sec"), o.get("delivery_window_end_sec"))
    total_w = sum(it["weight_kg"] for it in o["items"])
    print(f"Order {o['order_number']}: items={len(o['items'])}, total_weight={total_w:.1f}kg, P_win={p_win}, D_win={d_win}")
