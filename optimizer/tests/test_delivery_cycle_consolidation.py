import time
import pytest

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from test_benchmark_contract import comparison_request


@pytest.mark.parametrize("bed_length, expected_peak", [(200, 4), (40, 2)])
def test_consolidation_carries_orders_together_and_keeps_all_deliveries(bed_length, expected_peak):
    request = comparison_request()
    request.vehicles[0].length_cm = bed_length
    request.vehicles[0].width_cm = 100
    template = request.orders[0]
    request.orders = [
        template.model_copy(update={
            "id": f"order-{i}", "source_order_id": None, "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": f"pickup-{i}"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": f"delivery-{i}"}),
            "items": [template.items[0].model_copy(update={"id": f"package-{i}", "order_id": f"order-{i}"})],
        }) for i in range(4)
    ]
    locations = [0, 0, 1, 0, 2, 0, 3, 0, 4]
    request.distance_matrix_meters = [[abs(a - b) * 1000 for b in locations] for a in locations]
    request.duration_matrix_seconds = [[abs(a - b) * 60 for b in locations] for a in locations]
    engine = PackingAwareHybridALNSOptimizer(request, should_split_orders=False)
    routes = [[]]
    assert not engine._append_delivery_cycles(routes, [0], time.perf_counter() + 2)
    before = engine._calc_route_distance_km(0, routes[0])
    merged = engine._consolidate_delivery_cycles(routes, [], time.perf_counter() + 3)
    onboard = set()
    counts = []
    for stop in merged[0]:
        if stop.stop_type == "PICKUP":
            onboard.add(stop.order_id)
        else:
            onboard.remove(stop.order_id)
        counts.append(len(onboard))
    assert max(counts) == expected_peak
    assert not onboard
    assert engine._calc_route_distance_km(0, merged[0]) < before
    assert engine._validate_exact_route(0, merged[0], 1)
