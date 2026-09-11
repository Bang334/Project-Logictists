import json


def main() -> None:
    """Run the legacy validator comparison without affecting pytest imports."""
    import sys

    from app.models import FleetOptimizationRequest
    from app.routing_solver import FleetRoutingSolver
    from smart_validator_test import SmartSpatialValidator

    sys.stdout.reconfigure(encoding="utf-8")
    with open("test_full_payload.json", "r", encoding="utf-8") as f:
        data = json.load(f)

    req = FleetOptimizationRequest(**data)
    solver = FleetRoutingSolver(req)

    # Chỉ monkeypatch trong lần chạy thủ công; pytest không được thay validator toàn cục.
    import app.routing_solver

    app.routing_solver.SpatialValidator = SmartSpatialValidator
    resp = solver.solve()

    print("\n--- KẾT QUẢ KHI DÙNG SMART SPATIAL VALIDATOR ---")
    print("Status:", resp.status)
    print("Routes count:", len(resp.routes))
    for route in resp.routes:
        print(
            f"Vehicle: {route.plate_number}, distance: {route.total_distance_km}km, "
            f"stops: {len(route.stops)}"
        )
        print(f"  Spatial valid: {route.spatial_validation.is_valid}")
        for stop in route.stops:
            print(f"    Stop {stop.sequence}: [{stop.stop_type}] {stop.location_name}")

    print("\nUnassigned orders count:", len(resp.unassigned_orders))
    for unassigned in resp.unassigned_orders:
        print(
            f" - {unassigned.order_number}: [{unassigned.reason_code}] "
            f"{unassigned.reason_message}"
        )


if __name__ == "__main__":
    main()
