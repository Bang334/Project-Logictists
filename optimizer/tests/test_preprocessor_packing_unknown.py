"""A bounded packing failure must not fabricate a need to split an order."""
from app.models import SpatialValidationResult
from app.request_preprocessor import split_infeasible_orders_across_fleet
from test_benchmark_contract import comparison_request


def bundle_request(packages, vehicles):
    request = comparison_request()
    template = request.orders[0]
    request.orders = [template.model_copy(update={"id": "bundle", "order_number": "bundle",
        "source_order_id": "bundle", "split_group_id": None,
        "items": [template.items[0].model_copy(update={"id": f"pkg-{i}", "order_id": "bundle"})
            for i in range(packages)]})]
    request.vehicles = [request.vehicles[0].model_copy(update={"id": f"v-{i}"}) for i in range(vehicles)]
    request.drivers = [request.drivers[0].model_copy(update={"id": f"driver-{i}"}) for i in range(vehicles)]
    size = vehicles+2
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(size)] for i in range(size)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(size)] for i in range(size)]
    return request


def unknown_packing(*args, **kwargs):
    return SpatialValidationResult(is_valid=False, violation_code="PLACEMENT_SEARCH_LIMIT_REACHED")


def test_unknown_layout_search_keeps_the_original_order_and_matrix(monkeypatch):
    from app.spatial_validator import SpatialValidator
    request = bundle_request(2, 2)
    monkeypatch.setattr(SpatialValidator, "validate_plan", unknown_packing)
    normalized, count = split_infeasible_orders_across_fleet(request)
    assert count == 0
    assert normalized.orders == request.orders
    assert normalized.distance_matrix_meters == request.distance_matrix_meters
    assert normalized.duration_matrix_seconds == request.duration_matrix_seconds


def test_unknown_subsets_are_not_accepted_as_verified_split_bins(monkeypatch):
    from app.spatial_validator import SpatialValidator
    request = bundle_request(4, 4)  # Total floor area forces a split.
    monkeypatch.setattr(SpatialValidator, "validate_plan", unknown_packing)
    normalized, count = split_infeasible_orders_across_fleet(request)
    assert count == 1
    assert len(normalized.orders) == 4
    assert all(len(order.items) == 1 for order in normalized.orders)
    assert {cargo.id for order in normalized.orders for cargo in order.items} == {f"pkg-{i}" for i in range(4)}
