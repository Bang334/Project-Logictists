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


def test_across_route_consolidation_merges_corridor_routes_and_refine_direct_span_keeps_win():
    """Orders split on two trucks along the same corridor should consolidate onto one truck."""
    request = comparison_request()
    request.vehicles = [
        request.vehicles[0].model_copy(update={"id": "v0", "source_vehicle_id": "v0"}),
        request.vehicles[0].model_copy(update={"id": "v1", "source_vehicle_id": "v1", "plate_number": "TRK-02"}),
    ]
    request.drivers = [
        request.drivers[0].model_copy(update={"id": "d0"}),
        request.drivers[0].model_copy(update={"id": "d1", "full_name": "Driver 2"}),
    ]
    for v in request.vehicles:
        v.length_cm = 400
        v.width_cm = 200
    template = request.orders[0]
    request.orders = [
        template.model_copy(update={
            "id": "order-0", "order_number": "ORD-0", "source_order_id": None, "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": "pickup-0"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": "delivery-0"}),
            "items": [template.items[0].model_copy(update={"id": "pkg-0", "order_id": "order-0"})],
        }),
        template.model_copy(update={
            "id": "order-1", "order_number": "ORD-1", "source_order_id": None, "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": "pickup-1"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": "delivery-1"}),
            "items": [template.items[0].model_copy(update={"id": "pkg-1", "order_id": "order-1"})],
            # Earlier window forces a brief pickup wait when merged ahead of order-0 delivery.
            "pickup_window_start_sec": 3600,
        }),
    ]
    # Nodes: v0(0), v1(1), p0(2), d0(3), p1(4), d1(5)
    # Corridor: depot(0) -> p0(10km) -> p1(11km) -> d0(30km) -> d1(31km)
    coords = [0, 0, 10, 30, 11, 31]
    request.distance_matrix_meters = [[abs(a - b) * 1000 for b in coords] for a in coords]
    request.duration_matrix_seconds = [[abs(a - b) * 60 for b in coords] for a in coords]

    engine = PackingAwareHybridALNSOptimizer(request, should_split_orders=False, include_benchmarks=False)
    _, r0 = engine._can_insert_order(0, [], request.orders[0], 0, 1, check_packing=False)
    _, r1 = engine._can_insert_order(1, [], request.orders[1], 0, 1, check_packing=False)
    r0 = engine._schedule_stops(0, r0)[0]
    r1 = engine._schedule_stops(1, r1)[0]

    before_km = sum(engine._calc_route_distance_km(i, rt) for i, rt in enumerate([r0, r1]) if rt)
    merged = engine._consolidate_across_routes([r0, r1], [], time.perf_counter() + 2.0)
    nonempty = [rt for rt in merged if rt]
    assert len(nonempty) == 1
    assert engine._calc_route_distance_km(0 if merged[0] else 1, nonempty[0]) < before_km

    # Also verify direct-span refinement preserves this multi-order merge even if duration shifts.
    checkpoint = engine._build_final_response([r0, r1], [], include_benchmarks=False, spatial_time_budget_seconds=2.0)
    assert checkpoint.status == "SUCCESS" and len(checkpoint.routes) == 2
    refined = engine.refine_direct_span(checkpoint, {}, time.perf_counter() + 4.0)
    assert refined.status == "SUCCESS"
    assert len(refined.routes) == 1
    assert refined.total_distance_km < checkpoint.total_distance_km

    # Also confirm _append_delivery_cycles(allow_overlap=True) packs corridor orders together immediately.
    overlap_routes = [[], []]
    missing = engine._append_delivery_cycles(overlap_routes, [0, 1], time.perf_counter() + 2.0, allow_overlap=True)
    assert not missing
    assert sum(bool(r) for r in overlap_routes) == 1
