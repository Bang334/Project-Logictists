from typing import List

import pytest

from algo_lab.algorithms.hybrid_alns import solve_hybrid_alns
from algo_lab.algorithms.greedy_insertion import solve_greedy
from algo_lab.common.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetVehicle,
    LocationPoint,
    OrderPair,
    ScheduledStop,
)
from algo_lab.common.packing_checker import FastPackingChecker
from algo_lab.common.route_evaluator import schedule_and_evaluate_route
from algo_lab.common.solution_validator import audit_solution


def _vehicle(length: float = 600, width: float = 200, height: float = 200) -> FleetVehicle:
    return FleetVehicle(
        id="vehicle-1",
        plate_number="29H-TEST",
        length_cm=length,
        width_cm=width,
        height_cm=height,
        payload_limit_kg=5000,
        depot=LocationPoint(id="depot", name="Depot"),
    )


def _driver(driver_id: str = "driver-1") -> DriverOption:
    return DriverOption(id=driver_id, full_name="Driver")


def _policy() -> CostPolicy:
    return CostPolicy(unassigned_order_penalty_vnd=10_000_000)


def test_fast_checker_rejects_unknown_tall_blocked_and_undelivered_items() -> None:
    vehicle = _vehicle()
    checker = FastPackingChecker(vehicle)

    unknown = [
        ScheduledStop(
            sequence=1,
            stop_type="PICKUP",
            location_id="p",
            location_name="P",
            items_loaded=["missing"],
        )
    ]
    assert checker.validate_route_stops(unknown, {})[0] is False

    tall = CargoItem("tall", "order-tall", 100, 100, 250, 10, False)
    tall_stops = [
        ScheduledStop(1, "PICKUP", "p", "P", items_loaded=["tall"]),
        ScheduledStop(2, "DELIVERY", "d", "D", items_unloaded=["tall"]),
    ]
    assert checker.validate_route_stops(tall_stops, {"tall": tall})[0] is False

    inner = CargoItem("inner", "inner-order", 300, 100, 100, 500, False)
    barrier = CargoItem("barrier", "barrier-order", 100, 200, 100, 500, False)
    blocked = CargoItem("blocked", "blocked-order", 250, 100, 100, 500, False)
    blocked_stops = [
        ScheduledStop(1, "PICKUP", "p1", "P1", items_loaded=["inner", "barrier"]),
        ScheduledStop(2, "PICKUP", "p2", "P2", items_loaded=["blocked"]),
        ScheduledStop(3, "DELIVERY", "d2", "D2", items_unloaded=["blocked"]),
        ScheduledStop(4, "DELIVERY", "d1", "D1", items_unloaded=["barrier", "inner"]),
    ]
    cargo = {item.id: item for item in (inner, barrier, blocked)}
    assert checker.validate_route_stops(blocked_stops, cargo)[0] is False

    undelivered = [
        ScheduledStop(1, "PICKUP", "p", "P", items_loaded=["inner"]),
    ]
    assert checker.validate_route_stops(undelivered, cargo)[0] is False


def test_route_evaluator_waits_for_window_and_rejects_late_delivery() -> None:
    vehicle = _vehicle()
    driver = _driver()
    item = CargoItem("item-1", "order-1", 100, 100, 100, 100)
    order = OrderPair(
        id="order-1",
        order_number="ORD-1",
        pickup_location=LocationPoint("pickup", "Pickup"),
        delivery_location=LocationPoint("delivery", "Delivery"),
        items=[item],
        service_time_sec=100,
        pickup_window_start_sec=1000,
        pickup_window_end_sec=1200,
        delivery_window_start_sec=1500,
        delivery_window_end_sec=1800,
    )
    stops = [
        ScheduledStop(0, "PICKUP", "pickup", "Pickup", order_id=order.id, items_loaded=[item.id]),
        ScheduledStop(0, "DELIVERY", "delivery", "Delivery", order_id=order.id, items_unloaded=[item.id]),
    ]
    matrix = [[0, 100, 300], [100, 0, 200], [300, 200, 0]]
    result = schedule_and_evaluate_route(
        vehicle,
        driver,
        stops,
        {order.id: order},
        {item.id: item},
        _policy(),
        matrix,
        matrix,
        {"depot": 0, "pickup": 1, "delivery": 2},
    )
    assert result.feasible is True
    assert result.stops[0].arrival_time_sec == 1000
    assert result.stops[1].arrival_time_sec == 1500

    order.delivery_window_end_sec = 1250
    late = schedule_and_evaluate_route(
        vehicle,
        driver,
        stops,
        {order.id: order},
        {item.id: item},
        _policy(),
        matrix,
        matrix,
        {"depot": 0, "pickup": 1, "delivery": 2},
    )
    assert late.feasible is False
    assert "time window" in late.reason


def test_audit_persists_the_executable_unload_sequence() -> None:
    """A PASS result must expose the package order that can actually reach the door."""
    vehicle = _vehicle(length=330, width=140)
    driver = _driver()
    items = [
        CargoItem(f"item-{index}", "order-1", 110, 140, 100, 100, False)
        for index in range(1, 4)
    ]
    order = OrderPair(
        id="order-1",
        order_number="ORD-1",
        pickup_location=LocationPoint("pickup", "Pickup"),
        delivery_location=LocationPoint("delivery", "Delivery"),
        items=items,
        service_time_sec=30,
        pickup_window_start_sec=0,
        pickup_window_end_sec=4000,
        delivery_window_start_sec=0,
        delivery_window_end_sec=5000,
    )
    matrix = [
        [0, 100, 200],
        [100, 0, 100],
        [200, 100, 0],
    ]
    args = (
        [vehicle],
        [driver],
        [order],
        _policy(),
        matrix,
        matrix,
        {"depot": 0, "pickup": 1, "delivery": 2},
    )

    solution = solve_greedy(*args)
    delivery = solution.routes[0].stops[1]
    assert delivery.items_unloaded == ["item-1", "item-2", "item-3"]

    audit = audit_solution(solution, *args)

    assert audit.is_valid is True
    audited_delivery = solution.routes[0].stops[1]
    assert audited_delivery.items_unloaded == ["item-3", "item-2", "item-1"]


def _tiny_problem():
    vehicle = _vehicle(length=400, width=200)
    driver = _driver()
    orders: List[OrderPair] = []
    for index in range(2):
        order_id = f"order-{index}"
        item = CargoItem(f"item-{index}", order_id, 100, 100, 100, 100)
        orders.append(
            OrderPair(
                id=order_id,
                order_number=f"ORD-{index}",
                pickup_location=LocationPoint(f"p-{index}", f"P{index}"),
                delivery_location=LocationPoint(f"d-{index}", f"D{index}"),
                items=[item],
                service_time_sec=30,
                pickup_window_start_sec=0,
                pickup_window_end_sec=4000,
                delivery_window_start_sec=0,
                delivery_window_end_sec=5000,
            )
        )
    node_ids = ["depot", "p-0", "d-0", "p-1", "d-1"]
    matrix = [
        [0 if i == j else 100 + abs(i - j) * 10 for j in range(len(node_ids))]
        for i in range(len(node_ids))
    ]
    return [vehicle], [driver], orders, _policy(), matrix, matrix, {
        node_id: index for index, node_id in enumerate(node_ids)
    }


@pytest.mark.parametrize("seed", [0, 1])
def test_hybrid_alns_returns_independently_valid_solution(seed: int) -> None:
    args = _tiny_problem()
    solution = solve_hybrid_alns(*args, time_limit_sec=0.4, random_seed=seed)
    assert solution.fulfillment_rate == 100.0
    assert solution.is_contract_valid is True
    assert solution.is_temporally_valid is True
    assert solution.is_spatial_valid is True
    assert solution.validation_notes == []
