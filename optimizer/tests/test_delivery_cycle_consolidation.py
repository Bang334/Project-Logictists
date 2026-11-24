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


def test_append_cycles_prefers_sequential_and_reuses_active_physical_vehicle():
    """When overlap fails on floor limits, append sequentially before opening unused trucks."""
    request = comparison_request()
    day0_v0 = request.vehicles[0].model_copy(update={
        "id": "v0-day0", "source_vehicle_id": "v0", "service_day_index": 0,
        "length_cm": 100, "width_cm": 100, "height_cm": 100, "payload_limit_kg": 1000,
        "available_start_sec": 0, "available_end_sec": 30_000,
    })
    day0_v1 = request.vehicles[0].model_copy(update={
        "id": "v1-day0", "source_vehicle_id": "v1", "plate_number": "TRK-02", "service_day_index": 0,
        "length_cm": 100, "width_cm": 100, "height_cm": 100, "payload_limit_kg": 1000,
        "available_start_sec": 0, "available_end_sec": 30_000,
    })
    day1_v0 = day0_v0.model_copy(update={
        "id": "v0-day1", "service_day_index": 1,
        "available_start_sec": 86_400, "available_end_sec": 86_400 + 30_000,
    })
    day1_v1 = day0_v1.model_copy(update={
        "id": "v1-day1", "service_day_index": 1,
        "available_start_sec": 86_400, "available_end_sec": 86_400 + 30_000,
    })
    request.vehicles = [day0_v0, day0_v1, day1_v0, day1_v1]
    request.drivers = [
        request.drivers[0].model_copy(update={"id": "drv0-d0", "source_driver_id": "drv0", "service_day_index": 0}),
        request.drivers[0].model_copy(update={"id": "drv1-d0", "source_driver_id": "drv1", "service_day_index": 0}),
        request.drivers[0].model_copy(update={"id": "drv0-d1", "source_driver_id": "drv0", "service_day_index": 1}),
        request.drivers[0].model_copy(update={"id": "drv1-d1", "source_driver_id": "drv1", "service_day_index": 1}),
    ]
    template = request.orders[0]
    # Each order fills the full 100x100 floor (overlap impossible).
    # First 2 orders fit sequentially on day 0 v0; 3rd order belongs to day 1 and must reuse v0.
    request.orders = [
        template.model_copy(update={
            "id": "ord-0", "order_number": "ORD-0", "source_order_id": None, "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": "p0"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": "d0"}),
            "pickup_window_start_sec": 0, "pickup_window_end_sec": 20_000,
            "delivery_window_start_sec": 0, "delivery_window_end_sec": 25_000,
            "items": [template.items[0].model_copy(update={
                "id": "pkg-0", "order_id": "ord-0", "length_cm": 90, "width_cm": 90, "height_cm": 90, "no_top_load_requested": True,
            })],
        }),
        template.model_copy(update={
            "id": "ord-1", "order_number": "ORD-1", "source_order_id": None, "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": "p1"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": "d1"}),
            "pickup_window_start_sec": 0, "pickup_window_end_sec": 20_000,
            "delivery_window_start_sec": 0, "delivery_window_end_sec": 25_000,
            "items": [template.items[0].model_copy(update={
                "id": "pkg-1", "order_id": "ord-1", "length_cm": 90, "width_cm": 90, "height_cm": 90, "no_top_load_requested": True,
            })],
        }),
        template.model_copy(update={
            "id": "ord-2", "order_number": "ORD-2", "source_order_id": None, "split_group_id": None,
            "pickup_location": template.pickup_location.model_copy(update={"id": "p2"}),
            "delivery_location": template.delivery_location.model_copy(update={"id": "d2"}),
            "pickup_window_start_sec": 86_400, "pickup_window_end_sec": 86_400 + 20_000,
            "delivery_window_start_sec": 86_400, "delivery_window_end_sec": 86_400 + 25_000,
            "items": [template.items[0].model_copy(update={
                "id": "pkg-2", "order_id": "ord-2", "length_cm": 90, "width_cm": 90, "height_cm": 90, "no_top_load_requested": True,
            })],
        }),
    ]
    n_nodes = len(request.vehicles) + 2 * len(request.orders)
    request.distance_matrix_meters = [[0 if i == j else 1000 for j in range(n_nodes)] for i in range(n_nodes)]
    request.duration_matrix_seconds = [[0 if i == j else 60 for j in range(n_nodes)] for i in range(n_nodes)]

    engine = PackingAwareHybridALNSOptimizer(request, should_split_orders=False, include_benchmarks=False)
    routes = [[], [], [], []]
    missing = engine._append_delivery_cycles(routes, [0, 1, 2, 3], time.perf_counter() + 3.0, allow_overlap=True)
    assert not missing
    used_physical = {
        request.vehicles[idx].source_vehicle_id
        for idx, route in enumerate(routes)
        if route
    }
    assert used_physical == {"v0"}
    assert sum(bool(r) for r in routes) == 2


def test_ordered_seed_orders_prioritizes_earlier_grace_deadline():
    request = comparison_request()
    template = request.orders[0]
    request.policy.delivery_grace_days = 1
    request.orders = [
        template.model_copy(update={
            "id": "ord-fresh",
            "order_number": "ORD-FRESH",
            "source_order_id": None,
            "split_group_id": None,
            "pickup_window_start_sec": 0,
            "pickup_window_end_sec": 25_000,
            "delivery_window_start_sec": 0,
            "delivery_window_end_sec": 40_000,
            "ordered_at_sec": 0,
        }),
        template.model_copy(update={
            "id": "ord-urgent",
            "order_number": "ORD-URGENT",
            "source_order_id": None,
            "split_group_id": None,
            "pickup_window_start_sec": 0,
            "pickup_window_end_sec": 25_000,
            "delivery_window_start_sec": 0,
            "delivery_window_end_sec": 40_000,
            "ordered_at_sec": -86_400 * 3,
        }),
    ]
    n_nodes = len(request.vehicles) + 2 * len(request.orders)
    request.distance_matrix_meters = [[0 if i == j else 1000 for j in range(n_nodes)] for i in range(n_nodes)]
    request.duration_matrix_seconds = [[0 if i == j else 60 for j in range(n_nodes)] for i in range(n_nodes)]

    for seed in range(5):
        engine = PackingAwareHybridALNSOptimizer(
            request,
            random_seed=seed,
            should_split_orders=False,
            include_benchmarks=False,
        )
        ordered = engine._ordered_seed_orders()
        assert [order.id for order in ordered] == ["ord-urgent", "ord-fresh"]


def test_ordered_seed_orders_seed1_prefers_far_delivery_within_same_urgency_bucket():
    request = comparison_request()
    template = request.orders[0]
    depot_lat = request.vehicles[0].depot.latitude
    depot_lng = request.vehicles[0].depot.longitude
    request.orders = [
        template.model_copy(update={
            "id": "ord-near",
            "order_number": "ORD-NEAR",
            "source_order_id": None,
            "split_group_id": None,
            "delivery_location": template.delivery_location.model_copy(
                update={"id": "d-near", "latitude": depot_lat + 0.01, "longitude": depot_lng}
            ),
        }),
        template.model_copy(update={
            "id": "ord-far",
            "order_number": "ORD-FAR",
            "source_order_id": None,
            "split_group_id": None,
            "delivery_location": template.delivery_location.model_copy(
                update={"id": "d-far", "latitude": depot_lat + 0.50, "longitude": depot_lng}
            ),
        }),
    ]
    n_nodes = len(request.vehicles) + 2 * len(request.orders)
    request.distance_matrix_meters = [[0 if i == j else 1000 for j in range(n_nodes)] for i in range(n_nodes)]
    request.duration_matrix_seconds = [[0 if i == j else 60 for j in range(n_nodes)] for i in range(n_nodes)]

    engine = PackingAwareHybridALNSOptimizer(
        request,
        random_seed=1,
        should_split_orders=False,
        include_benchmarks=False,
    )
    assert [order.id for order in engine._ordered_seed_orders()] == ["ord-far", "ord-near"]

