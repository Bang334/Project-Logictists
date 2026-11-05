"""Comparison engines must solve the same request as the production engine."""
import time
import math
import pytest

from app.models import CargoItem, CostPolicy, DriverOption, FleetOptimizationRequest, FleetVehicle, LocationPoint, OrderPair
from benchmarks.algorithm_comparison.common import convert_request_to_hybrid


def comparison_request() -> FleetOptimizationRequest:
    depot = LocationPoint(id="depot", name="depot", latitude=10, longitude=106)
    vehicle = FleetVehicle(id="v", plate_number="TEST", depot=depot, length_cm=100,
        width_cm=50, height_cm=100, payload_limit_kg=1000,
        fuel_consumption_liters_per_100_km=10, fixed_operating_cost_vnd=100000)
    orders = [OrderPair(id=f"part-{i}", order_number=f"part-{i}",
        source_order_id="parent-order", split_group_id="whole-order",
        pickup_location=depot.model_copy(update={"id": f"p{i}"}),
        delivery_location=depot.model_copy(update={"id": f"d{i}"}),
        pickup_service_time_sec=17, delivery_service_time_sec=23,
        items=[CargoItem(id=f"pkg-{i}", order_id="parent-order", length_cm=40,
            width_cm=50, height_cm=20, weight_kg=10, can_rotate=False)]) for i in range(2)]
    return FleetOptimizationRequest(job_id="contract", vehicles=[vehicle],
        drivers=[DriverOption(id="driver", full_name="test", fixed_salary_monthly_vnd=0,
            trip_base_pay_vnd=0, per_km_pay_vnd=0)], orders=orders,
        policy=CostPolicy(fuel_price_per_liter_vnd=23000, monthly_working_minutes=10560),
        distance_matrix_meters=[[0 if i==j else 100 for j in range(5)] for i in range(5)],
        duration_matrix_seconds=[[0 if i==j else 10 for j in range(5)] for i in range(5)])


def test_comparison_keeps_parent_order_and_all_or_nothing_group():
    request = comparison_request()
    converted = convert_request_to_hybrid(request)[2]
    assert [(o.source_order_id, o.split_group_id) for o in converted] == [
        (o.source_order_id, o.split_group_id) for o in request.orders
    ]


def test_comparison_keeps_distinct_pickup_and_delivery_service_durations():
    request = comparison_request()
    converted = convert_request_to_hybrid(request)[2]
    assert [(o.service_seconds("PICKUP"), o.service_seconds("DELIVERY")) for o in converted] == [
        (17, 23) for _ in request.orders
    ]


def test_comparison_uses_the_same_d11_floor_rotation_policy_as_production():
    request = comparison_request()
    converted = convert_request_to_hybrid(request)[2]
    assert all(c.can_rotate for o in converted for c in o.items)


def test_split_group_is_all_or_nothing_not_a_ban_on_sharing_one_vehicle():
    from app.hybrid_alns.solver import HybridALNSSolver
    from app.hybrid_alns.route_evaluator import schedule_and_evaluate_route
    args = convert_request_to_hybrid(comparison_request())
    vehicles, drivers, orders, policy, distances, durations, indices = args
    # Exercise the caller independently of the converter's grouping bug.
    for order in orders:
        order.source_order_id = "parent-order"
        order.split_group_id = "whole-order"
    solver = HybridALNSSolver(*args, time_limit_sec=1)
    p0, d0 = solver._make_stops(orders[0])
    p1, d1 = solver._make_stops(orders[1])
    evaluation = schedule_and_evaluate_route(vehicles[0], drivers[0], [p0,p1,d1,d0],
        solver.order_by_id, solver.cargo_by_id, policy, distances, durations, indices)
    assert evaluation.feasible, evaluation.reason
    assert solver._insertions_for_order(orders[1].id, [[p0,d0]], time.perf_counter()+1)
    shuttle = schedule_and_evaluate_route(vehicles[0], drivers[0], [p0,d0,p1,d1],
        solver.order_by_id, solver.cargo_by_id, policy, distances, durations, indices)
    assert not shuttle.feasible


@pytest.mark.parametrize("count,length", [(2,40), (5,40), (7,30)])
def test_grouping_generalizes_to_different_manifest_sizes(count, length):
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    base = comparison_request()
    vehicle_count = math.ceil(count * length / 100) + 1
    orders = []
    for i in range(count):
        template = base.orders[0]
        orders.append(template.model_copy(update={
            "id": f"part-{i}", "order_number": f"part-{i}",
            "pickup_location": template.pickup_location.model_copy(update={"id":f"p-{i}"}),
            "delivery_location": template.delivery_location.model_copy(update={"id":f"d-{i}"}),
            "pickup_window_end_sec": 100, "delivery_window_start_sec": 200,
            "delivery_window_end_sec": 3000,
            "items": [template.items[0].model_copy(update={"id":f"pkg-{i}","length_cm":length})],
        }))
    size = vehicle_count + len(orders)*2
    request = base.model_copy(update={
        "orders": orders,
        "vehicles": [base.vehicles[0].model_copy(update={"id":f"v-{i}",
            "available_start_sec":0,"available_end_sec":3600}) for i in range(vehicle_count)],
        "drivers": [base.drivers[0].model_copy(update={"id":f"driver-{i}"}) for i in range(vehicle_count)],
        "distance_matrix_meters": [[0 if i==j else 100 for j in range(size)] for i in range(size)],
        "duration_matrix_seconds": [[0 if i==j else 10 for j in range(size)] for i in range(size)],
    })
    result = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=0.5, random_seed=0).solve()
    assert not result.unassigned_orders
    # All boxes span the full width. Area alone is only a lower bound:
    # a 100-long floor holds two 40-long boxes, never two and a half.
    assert len(result.routes) == math.ceil(count / (100 // length))
    loaded = [cid for route in result.routes for stop in route.stops for cid in stop.items_loaded]
    delivered = [cid for route in result.routes for stop in route.stops for cid in stop.items_unloaded]
    assert len(loaded) == len(set(loaded)) == count
    assert set(loaded) == set(delivered) == {f"pkg-{i}" for i in range(count)}
    assert all(route.spatial_validation.is_valid for route in result.routes)
    assert all(stop.departure_time_sec <= 3600 for route in result.routes for stop in route.stops)
