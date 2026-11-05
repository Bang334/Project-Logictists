"""Unit and integration tests for the algorithm comparison suite and Hybrid ALNS enhancements."""

import json
from pathlib import Path

from app.models import FleetOptimizationRequest
from app.hybrid_alns.models import (
    CargoItem as HybridCargo,
    FleetVehicle as HybridVehicle,
    LocationPoint as HybridLocation,
    ScheduledStop as HybridStop,
)
from app.hybrid_alns.packing_checker import FastPackingChecker
from benchmarks.algorithm_comparison.algo1_hybrid_genetic import PackingAwareHGS
from benchmarks.algorithm_comparison.algo2_set_partitioning import SetPartitioningMatheuristic
from benchmarks.algorithm_comparison.algo3_cp_sat_benders import LogicBasedBendersOptimizer


CASE_PATH = (
    Path(__file__).resolve().parents[1]
    / "benchmarks"
    / "cases"
    / "db_nhatrang_2_orders.json"
)


def _load_nhatrang_request() -> FleetOptimizationRequest:
    payload = json.loads(CASE_PATH.read_text(encoding="utf-8"))
    payload.pop("scenario_profile", None)
    return FleetOptimizationRequest.model_validate(payload)


def test_lifo_loading_order_prevents_false_negative_in_fast_packing_checker() -> None:
    """Items loaded at the same pickup stop must be ordered so later-delivered cargo sits deeper."""
    vehicle = HybridVehicle(
        id="v1",
        plate_number="51C-123.45",
        length_cm=400.0,
        width_cm=200.0,
        height_cm=200.0,
        payload_limit_kg=3000.0,
        depot=HybridLocation(id="d", name="Depot"),
    )
    # Both items span the full width (200cm), so whoever is placed at x=0 is blocked by x=200.
    # order_early is delivered at stop 2, order_late at stop 3.
    # Even if item_early is listed first in items_loaded, LIFO-guided loading must place
    # item_late at x=0 and item_early at x=200 (near rear door x=400).
    cargo_by_id = {
        "item_early": HybridCargo(
            id="item_early",
            order_id="order_early",
            length_cm=180.0,
            width_cm=200.0,
            height_cm=100.0,
            weight_kg=500.0,
            can_rotate=False,
        ),
        "item_late": HybridCargo(
            id="item_late",
            order_id="order_late",
            length_cm=180.0,
            width_cm=200.0,
            height_cm=100.0,
            weight_kg=500.0,
            can_rotate=False,
        ),
    }
    stops = [
        HybridStop(
            sequence=1,
            stop_type="PICKUP",
            location_id="loc_p",
            location_name="Pickup",
            order_id="order_early",
            items_loaded=["item_early", "item_late"],
        ),
        HybridStop(
            sequence=2,
            stop_type="DELIVERY",
            location_id="loc_d1",
            location_name="Delivery 1",
            order_id="order_early",
            items_unloaded=["item_early"],
        ),
        HybridStop(
            sequence=3,
            stop_type="DELIVERY",
            location_id="loc_d2",
            location_name="Delivery 2",
            order_id="order_late",
            items_unloaded=["item_late"],
        ),
    ]

    checker = FastPackingChecker(vehicle)
    valid, reason = checker.validate_route_stops(stops, cargo_by_id)
    assert valid is True, f"Expected LIFO-guided loading to succeed, got: {reason}"


def test_all_three_experimental_algorithms_solve_and_pass_spatial_audit() -> None:
    request = _load_nhatrang_request()

    m1 = PackingAwareHGS(request, time_limit_sec=1.5).solve("db_nhatrang_2_orders.json")
    assert m1.orders_served == m1.total_orders
    assert m1.spatial_audit_pass is True
    assert m1.total_cost_vnd > 0

    m2 = SetPartitioningMatheuristic(request, time_limit_sec=1.5).solve("db_nhatrang_2_orders.json")
    assert m2.orders_served == m2.total_orders
    assert m2.spatial_audit_pass is True
    assert m2.total_cost_vnd > 0

    m3 = LogicBasedBendersOptimizer(request, time_limit_sec=1.5).solve("db_nhatrang_2_orders.json")
    assert m3.orders_served == m3.total_orders
    assert m3.spatial_audit_pass is True
    assert m3.total_cost_vnd > 0


def test_cp_sat_set_partitioning_recombines_elite_routes() -> None:
    """Verify _solve_set_partitioning picks the cheaper route for each order across candidates."""
    from app.hybrid_alns.solver import HybridALNSSolver
    from benchmarks.algorithm_comparison.common import convert_request_to_hybrid

    request = _load_nhatrang_request()
    vehicles, drivers, orders, policy, dist_m, dur_m, node_to_idx = convert_request_to_hybrid(request)
    solver = HybridALNSSolver(
        vehicles, drivers, orders, policy, dist_m, dur_m, node_to_idx, time_limit_sec=1.0
    )

    o1, o2 = orders[0], orders[1]
    p1, d1 = solver._make_stops(o1)
    p2, d2 = solver._make_stops(o2)

    # Candidate A: o1 on vehicle 0, o2 on vehicle 1
    routes_a = [[] for _ in vehicles]
    routes_a[0] = [p1, d1]
    routes_a[1] = [p2, d2]

    # Candidate B: both o1 and o2 consolidated on vehicle 0
    routes_b = [[] for _ in vehicles]
    routes_b[0] = [p1, p2, d2, d1]

    cost_a = solver._plan_cost(routes_a, [])
    cost_b = solver._plan_cost(routes_b, [])

    elite = [(cost_a, routes_a, []), (cost_b, routes_b, [])]
    result = solver._solve_set_partitioning(elite, time_limit_sec=0.5)

    assert result is not None
    sp_cost, sp_routes, sp_unassigned = result
    assert sp_unassigned == []
    assert sp_cost <= min(cost_a, cost_b)

