"""Physical Package v1 consumer regression; matrices here are explicit test fixtures."""
import pytest
from pydantic import ValidationError
from app.models import OrderPair, OptimizationRequest, VehicleFloor, LocationPoint
from app.routing_solver import OrToolsRoutingSolver


def order_payload():
    return dict(
        id="order-uuid", order_number="EXAMPLE-ORDER",
        package_contract_version="1", time_window_basis="SERVICE_START",
        pickup_location=dict(id="pickup-stop-uuid", name="pickup", latitude=21, longitude=105),
        delivery_location=dict(id="delivery-stop-uuid", name="delivery", latitude=21.1, longitude=105),
        items=[dict(id=f"package-uuid-{i}", order_id="order-uuid", order_item_id="line-uuid",
                    length_cm=40.1, width_cm=30.2, height_cm=20.3, weight_kg=weight,
                    can_rotate=False) for i, weight in enumerate([10.001, 20.002])],
        pickup_window_start_sec=85800, pickup_window_end_sec=86400,
        delivery_window_start_sec=86400, delivery_window_end_sec=90000,
        pickup_service_time_sec=600, delivery_service_time_sec=1200,
    )


def test_v1_requires_both_service_durations_and_explicit_basis():
    data = order_payload()
    del data["pickup_service_time_sec"]
    with pytest.raises(ValidationError, match="requires both service durations"):
        OrderPair(**data)
    data = order_payload()
    data["time_window_basis"] = "COMPLETION"
    with pytest.raises(ValidationError):
        OrderPair(**data)


def test_real_solver_preserves_package_ids_grams_and_overnight_windows():
    order = OrderPair(**order_payload())
    request = OptimizationRequest(
        job_id="package-v1-contract", orders=[order], max_time_seconds=1,
        depot=LocationPoint(id="depot", name="depot", latitude=21, longitude=105),
        vehicle=VehicleFloor(id="truck", plate_number="TEST", length_cm=400,
                             width_cm=200, height_cm=200, payload_limit_kg=1000),
        distance_matrix_meters=[[0 if i == j else 1000 for j in range(3)] for i in range(3)],
        duration_matrix_seconds=[[0 if i == j else 60 for j in range(3)] for i in range(3)],
    )
    result = OrToolsRoutingSolver(request).solve()
    assert result.status == "SUCCESS", result.diagnostics
    assert result.package_contract_version == "1"
    pickup, delivery = result.stops
    assert pickup.location_id == "pickup-stop-uuid"
    assert delivery.location_id == "delivery-stop-uuid"
    assert pickup.items_loaded == delivery.items_unloaded == [p.id for p in order.items]
    assert pickup.current_weight_kg == pytest.approx(30.003)
    assert delivery.current_weight_kg == 0
    for stop, start, end, service in [(pickup, 85800, 86400, 600), (delivery, 86400, 90000, 1200)]:
        service_start = max(start, stop.arrival_time_sec)
        assert service_start <= end
        assert stop.departure_time_sec == service_start + service
        assert stop.service_time_sec == service
    assert delivery.arrival_time_sec >= pickup.departure_time_sec + 60
