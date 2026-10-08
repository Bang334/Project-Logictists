import pytest
from pydantic import ValidationError

from app.models import FleetOptimizationRequest


def minimal_fleet_request() -> dict:
    return {
        "job_id": "job-1",
        "vehicles": [
            {
                "id": "vehicle-1",
                "plate_number": "29H-123.45",
                "length_cm": 600,
                "width_cm": 200,
                "height_cm": 200,
                "payload_limit_kg": 5000,
                "depot": {
                    "id": "depot-1",
                    "name": "Main depot",
                    "latitude": 21.0285,
                    "longitude": 105.8542,
                },
                "fuel_consumption_liters_per_100_km": 12,
                "fixed_operating_cost_vnd": 100_000,
            }
        ],
        "drivers": [
            {
                "id": "driver-1",
                "full_name": "Driver One",
                "fixed_salary_monthly_vnd": 10_000_000,
                "trip_base_pay_vnd": 100_000,
                "per_km_pay_vnd": 2_000,
            }
        ],
        "orders": [
            {
                "id": "order-1",
                "order_number": "SO-001",
                "pickup_location": {
                    "id": "pickup-1",
                    "name": "Pickup",
                    "latitude": 21.03,
                    "longitude": 105.85,
                },
                "delivery_location": {
                    "id": "delivery-1",
                    "name": "Delivery",
                    "latitude": 21.04,
                    "longitude": 105.86,
                },
                "items": [
                    {
                        "id": "cargo-1",
                        "order_id": "order-1",
                        "length_cm": 100,
                        "width_cm": 80,
                        "height_cm": 70,
                        "weight_kg": 200,
                    }
                ],
            }
        ],
        "policy": {
            "fuel_price_per_liter_vnd": 25_000,
            "monthly_working_minutes": 10_560,
        },
        "distance_matrix_meters": [[0, 1, 1], [1, 0, 1], [1, 1, 0]],
        "duration_matrix_seconds": [[0, 1, 1], [1, 0, 1], [1, 1, 0]],
    }


def test_request_rejects_unknown_contract_fields():
    payload = minimal_fleet_request()
    payload["orders"][0]["pickup_window_end_seconds"] = 100

    with pytest.raises(ValidationError) as error:
        FleetOptimizationRequest.model_validate(payload)

    assert "pickup_window_end_seconds" in str(error.value)
    assert "Extra inputs are not permitted" in str(error.value)


def test_request_rejects_reversed_order_time_window():
    payload = minimal_fleet_request()
    payload["orders"][0].update(
        pickup_window_start_sec=200,
        pickup_window_end_sec=100,
    )

    with pytest.raises(ValidationError) as error:
        FleetOptimizationRequest.model_validate(payload)

    assert "pickup time window is invalid" in str(error.value)


def test_request_accepts_only_bounded_explicit_search_time():
    payload = minimal_fleet_request()
    payload["search_time_seconds"] = 45

    request = FleetOptimizationRequest.model_validate(payload)

    assert request.search_time_seconds == 45

    for invalid_value in (0, 121):
        payload["search_time_seconds"] = invalid_value
        with pytest.raises(ValidationError):
            FleetOptimizationRequest.model_validate(payload)
