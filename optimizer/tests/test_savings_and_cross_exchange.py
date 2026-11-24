import time

from app.hybrid_alns.models import (
    CargoItem as HybridCargoItem,
    CostPolicy as HybridPolicy,
    DriverOption as HybridDriver,
    FleetVehicle as HybridVehicle,
    LocationPoint as HybridLocation,
    OrderPair as HybridOrder,
)
from app.hybrid_alns.savings_constructor import build_savings_routes
from app.hybrid_alns.solver import HybridALNSSolver
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import ScheduledStop
from test_benchmark_contract import comparison_request


def test_savings_constructor_chains_corridor_orders_and_reuses_day0_physical_vehicle():
    base = comparison_request()
    veh0 = base.vehicles[0].model_copy(
        update={
            "id": "vA-day0",
            "source_vehicle_id": "phys-A",
            "plate_number": "A-001",
            "service_day_index": 0,
            "available_start_sec": 0,
            "available_end_sec": 36_000,
        }
    )
    veh1 = veh0.model_copy(
        update={"id": "vB-day0", "source_vehicle_id": "phys-B", "plate_number": "B-002"}
    )
    veh2 = veh0.model_copy(
        update={
            "id": "vA-day1",
            "source_vehicle_id": "phys-A",
            "service_day_index": 1,
            "available_start_sec": 86_400,
            "available_end_sec": 86_400 + 36_000,
        }
    )
    veh3 = veh1.model_copy(
        update={
            "id": "vB-day1",
            "source_vehicle_id": "phys-B",
            "service_day_index": 1,
            "available_start_sec": 86_400,
            "available_end_sec": 86_400 + 36_000,
        }
    )
    drv0 = base.drivers[0].model_copy(
        update={"id": "dA-day0", "source_driver_id": "drv-A", "service_day_index": 0}
    )
    drv1 = drv0.model_copy(update={"id": "dB-day0", "source_driver_id": "drv-B"})
    drv2 = drv0.model_copy(update={"id": "dA-day1", "service_day_index": 1})
    drv3 = drv1.model_copy(update={"id": "dB-day1", "service_day_index": 1})

    tpl = base.orders[0]
    orders = [
        tpl.model_copy(
            update={
                "id": "ord-d0",
                "order_number": "ORD-0",
                "source_order_id": "ord-d0",
                "split_group_id": None,
                "pickup_window_start_sec": 0,
                "pickup_window_end_sec": 10_000,
                "delivery_window_start_sec": 0,
                "delivery_window_end_sec": 20_000,
                "pickup_location": tpl.pickup_location.model_copy(update={"id": "p0"}),
                "delivery_location": tpl.delivery_location.model_copy(update={"id": "d0"}),
                "items": [tpl.items[0].model_copy(update={"id": "pkg-0", "order_id": "ord-d0"})],
            }
        ),
        tpl.model_copy(
            update={
                "id": "ord-d1",
                "order_number": "ORD-1",
                "source_order_id": "ord-d1",
                "split_group_id": None,
                "pickup_window_start_sec": 86_400,
                "pickup_window_end_sec": 86_400 + 10_000,
                "delivery_window_start_sec": 86_400,
                "delivery_window_end_sec": 86_400 + 20_000,
                "pickup_location": tpl.pickup_location.model_copy(update={"id": "p1"}),
                "delivery_location": tpl.delivery_location.model_copy(update={"id": "d1"}),
                "items": [tpl.items[0].model_copy(update={"id": "pkg-1", "order_id": "ord-d1"})],
            }
        ),
    ]
    n_nodes = 4 + 2 * len(orders)
    req = base.model_copy(
        update={
            "demo_stacking": None,
            "vehicles": [veh0, veh1, veh2, veh3],
            "drivers": [drv0, drv1, drv2, drv3],
            "orders": orders,
            "distance_matrix_meters": [[0 if i == j else 1_000 for j in range(n_nodes)] for i in range(n_nodes)],
            "duration_matrix_seconds": [[0 if i == j else 100 for j in range(n_nodes)] for i in range(n_nodes)],
        }
    )
    engine = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=5.0, should_split_orders=False)
    routes, missing = build_savings_routes(engine, [0, 1, 2, 3], time.perf_counter() + 4.0)
    assert missing == []
    used_phys = {
        engine.vehicles[idx].source_vehicle_id
        for idx, route in enumerate(routes)
        if route
    }
    # Day 1 route must reuse Day 0 active physical truck -> only 1 physical truck total.
    assert len(used_phys) == 1


def test_optimize_production_vehicles_consolidates_duplicate_physical_trucks():
    base = comparison_request()
    veh0 = base.vehicles[0].model_copy(
        update={"id": "vA-day0", "source_vehicle_id": "phys-A", "plate_number": "A-001", "service_day_index": 0}
    )
    veh1 = veh0.model_copy(
        update={"id": "vB-day0", "source_vehicle_id": "phys-B", "plate_number": "B-002", "service_day_index": 0}
    )
    veh2 = veh0.model_copy(
        update={
            "id": "vA-day1",
            "source_vehicle_id": "phys-A",
            "service_day_index": 1,
            "available_start_sec": 86_400,
            "available_end_sec": 86_400 + 36_000,
        }
    )
    veh3 = veh1.model_copy(
        update={
            "id": "vB-day1",
            "source_vehicle_id": "phys-B",
            "service_day_index": 1,
            "available_start_sec": 86_400,
            "available_end_sec": 86_400 + 36_000,
        }
    )
    drv0 = base.drivers[0].model_copy(update={"id": "dA-day0", "source_driver_id": "drv-A", "service_day_index": 0})
    drv1 = drv0.model_copy(update={"id": "dB-day0", "source_driver_id": "drv-B", "service_day_index": 0})
    drv2 = drv0.model_copy(update={"id": "dA-day1", "service_day_index": 1})
    drv3 = drv1.model_copy(update={"id": "dB-day1", "service_day_index": 1})

    tpl = base.orders[0]
    orders = [
        tpl.model_copy(
            update={
                "id": "ord-0",
                "order_number": "ORD-0",
                "source_order_id": "ord-0",
                "split_group_id": None,
                "pickup_window_start_sec": 0,
                "pickup_window_end_sec": 10_000,
                "delivery_window_start_sec": 0,
                "delivery_window_end_sec": 20_000,
                "items": [tpl.items[0].model_copy(update={"id": "pkg-0", "order_id": "ord-0"})],
            }
        ),
        tpl.model_copy(
            update={
                "id": "ord-1",
                "order_number": "ORD-1",
                "source_order_id": "ord-1",
                "split_group_id": None,
                "pickup_window_start_sec": 86_400,
                "pickup_window_end_sec": 86_400 + 10_000,
                "delivery_window_start_sec": 86_400,
                "delivery_window_end_sec": 86_400 + 20_000,
                "pickup_location": tpl.pickup_location.model_copy(update={"id": "p1"}),
                "delivery_location": tpl.delivery_location.model_copy(update={"id": "d1"}),
                "items": [tpl.items[0].model_copy(update={"id": "pkg-1", "order_id": "ord-1"})],
            }
        ),
    ]
    n_nodes = 4 + 2 * len(orders)
    req = base.model_copy(
        update={
            "demo_stacking": None,
            "vehicles": [veh0, veh1, veh2, veh3],
            "drivers": [drv0, drv1, drv2, drv3],
            "orders": orders,
            "distance_matrix_meters": [[0 if i == j else 1_000 for j in range(n_nodes)] for i in range(n_nodes)],
            "duration_matrix_seconds": [[0 if i == j else 100 for j in range(n_nodes)] for i in range(n_nodes)],
        }
    )
    engine = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=5.0, should_split_orders=False)
    s0 = engine._schedule_stops(0, list(engine._stop_templates_by_order_id["ord-0"]))[0]
    s3 = engine._schedule_stops(3, list(engine._stop_templates_by_order_id["ord-1"]))[0]
    # Deliberately place Day 0 on phys-A and Day 1 on phys-B; optimizer must collapse onto phys-A.
    result = engine._optimize_production_vehicles([s0, [], [], s3], [], time.perf_counter() + 2.0)
    assert result is not None
    used_phys = {
        engine.vehicles[idx].source_vehicle_id
        for idx, route in enumerate(result[1])
        if route
    }
    assert len(used_phys) == 1


def test_hybrid_cross_exchange_finds_swap_across_many_active_routes():
    depot = HybridLocation(id="depot", name="Depot", latitude=16.05, longitude=108.20)
    vehicles = [
        HybridVehicle(
            id=f"v-{i}",
            plate_number=f"43C-{i:03d}",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=5_000,
            depot=depot,
            fuel_consumption_liters_per_100_km=15.0,
            fixed_operating_cost_vnd=100_000,
            available_start_sec=0,
            available_end_sec=36_000,
        )
        for i in range(5)
    ]
    drivers = [
        HybridDriver(id=f"d-{i}", full_name=f"Driver {i}", license_class="C")
        for i in range(5)
    ]
    # Build 6 orders across 2 distant zones (North vs South) + middle routes 1..3 so active_indices == 5 (> 3).
    zone_coords = [
        ("n0", 16.06, 108.20),
        ("n1", 16.07, 108.20),
        ("m1", 16.12, 108.20),
        ("m2", 16.14, 108.20),
        ("m3", 16.16, 108.20),
        ("s0", 16.40, 108.20),
        ("s1", 16.41, 108.20),
    ]
    orders = []
    node_id_to_index = {"depot": 0}
    coords = [(16.05, 108.20)]
    for tag, lat, lng in zone_coords:
        p_id = f"p-{tag}"
        d_id = f"d-{tag}"
        node_id_to_index[p_id] = len(coords)
        coords.append((lat, lng))
        node_id_to_index[d_id] = len(coords)
        coords.append((lat + 0.001, lng + 0.001))
        orders.append(
            HybridOrder(
                id=f"ord-{tag}",
                order_number=f"ORD-{tag}",
                pickup_location=HybridLocation(id=p_id, name=p_id, latitude=lat, longitude=lng),
                delivery_location=HybridLocation(id=d_id, name=d_id, latitude=lat + 0.001, longitude=lng + 0.001),
                items=[HybridCargoItem(id=f"item-{tag}", order_id=f"ord-{tag}", length_cm=40, width_cm=40, height_cm=40, weight_kg=10)],
                pickup_window_start_sec=0,
                pickup_window_end_sec=30_000,
                delivery_window_start_sec=0,
                delivery_window_end_sec=35_000,
            )
        )
    n = len(coords)
    dist = [[0.0] * n for _ in range(n)]
    dur = [[0.0] * n for _ in range(n)]
    for a in range(n):
        for b in range(n):
            km = (abs(coords[a][0] - coords[b][0]) + abs(coords[a][1] - coords[b][1])) * 111_000
            dist[a][b] = km
            dur[a][b] = km / 10.0

    policy = HybridPolicy(fuel_price_per_liter_vnd=23_500, demo_stacking=None)
    solver = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist, dur, node_id_to_index, time_limit_sec=5.0
    )
    # Mix North & South across route 0 [ord-n0, ord-s1] and route 4 [ord-s0, ord-n1] -> swapping s1 <-> n1 saves huge distance.
    routes = [[] for _ in range(5)]
    route_orders = {
        0: ["ord-n0", "ord-s1"],
        1: ["ord-m1"],
        2: ["ord-m2"],
        3: ["ord-m3"],
        4: ["ord-s0", "ord-n1"],
    }
    for r_idx, oids in route_orders.items():
        stops = [s for oid in oids for s in solver._make_stops(solver.order_by_id[oid])]
        routes[r_idx] = solver._evaluate_route(r_idx, stops).stops

    old_cost = solver._plan_cost(routes, [])
    exchanged = solver._best_order_exchange(routes, [], time.perf_counter() + 2.0)
    assert exchanged is not None
    assert exchanged[0] < old_cost
