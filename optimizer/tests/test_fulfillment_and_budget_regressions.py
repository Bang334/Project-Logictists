"""Regression tests for full fulfillment recovery, item-weighted spatial audit, and strict solver deadlines."""

from __future__ import annotations

import time
from typing import Dict, List

import pytest

from app import alns_engine
from app.hybrid_alns.models import (
    CargoItem as HybridCargoItem,
    CostPolicy as HybridCostPolicy,
    DriverOption as HybridDriverOption,
    FleetVehicle as HybridVehicle,
    LocationPoint as HybridLocationPoint,
    OrderPair as HybridOrderPair,
)
from app.hybrid_alns.solver import solve_hybrid_alns
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import (
    CargoItem,
    CostPolicy,
    DemoStackingPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    RouteCostBreakdown,
    ScheduledStop,
    SpatialValidationResult,
    UnassignedOrder,
)
from benchmarks.algorithm_comparison.common import convert_request_to_hybrid
from test_benchmark_contract import comparison_request


def _independent_request(
    *,
    num_orders: int,
    num_vehicles: int,
    items_per_order: List[int],
    vehicle_dims: List[tuple] | None = None,
    vehicle_costs: List[int] | None = None,
    service_days: List[int] | None = None,
) -> FleetOptimizationRequest:
    base = comparison_request()
    depot = base.vehicles[0].depot
    vehicles = []
    drivers = []
    for v_idx in range(num_vehicles):
        l_cm, w_cm, h_cm, max_kg = (
            vehicle_dims[v_idx] if vehicle_dims else (600.0, 220.0, 210.0, 5000.0)
        )
        fixed_cost = vehicle_costs[v_idx] if vehicle_costs else 100_000
        day = service_days[v_idx] if service_days else 0
        vehicles.append(
            base.vehicles[0].model_copy(
                update={
                    "id": f"veh-{v_idx}",
                    "plate_number": f"29A-{10000 + v_idx}",
                    "length_cm": l_cm,
                    "width_cm": w_cm,
                    "height_cm": h_cm,
                    "payload_limit_kg": max_kg,
                    "fixed_operating_cost_vnd": fixed_cost,
                    "service_day_index": day,
                }
            )
        )
        drivers.append(
            base.drivers[0].model_copy(
                update={
                    "id": f"drv-{v_idx}",
                    "service_day_index": day,
                }
            )
        )

    orders = []
    template_order = base.orders[0]
    template_item = template_order.items[0]
    for o_idx in range(num_orders):
        oid = f"ord-{o_idx}"
        n_items = items_per_order[o_idx]
        items = [
            template_item.model_copy(
                update={
                    "id": f"{oid}-item-{k}",
                    "order_id": oid,
                    "length_cm": 30.0,
                    "width_cm": 30.0,
                    "height_cm": 20.0,
                    "weight_kg": 10.0,
                    "can_rotate": False,
                }
            )
            for k in range(n_items)
        ]
        orders.append(
            template_order.model_copy(
                update={
                    "id": oid,
                    "order_number": oid,
                    "source_order_id": None,
                    "split_group_id": None,
                    "pickup_location": depot.model_copy(update={"id": f"p-{o_idx}"}),
                    "delivery_location": depot.model_copy(update={"id": f"d-{o_idx}"}),
                    "items": items,
                }
            )
        )

    n_loc = num_vehicles + 2 * num_orders
    return FleetOptimizationRequest(
        job_id="regression-check",
        vehicles=vehicles,
        drivers=drivers,
        orders=orders,
        policy=base.policy,
        distance_matrix_meters=[[0 if i == j else 1000 for j in range(n_loc)] for i in range(n_loc)],
        duration_matrix_seconds=[[0 if i == j else 60 for j in range(n_loc)] for i in range(n_loc)],
        search_time_seconds=5,
        max_time_seconds=30,
    )


def _pair_stops_for(engine: PackingAwareHybridALNSOptimizer, order_idx: int) -> List[ScheduledStop]:
    order = engine.orders[order_idx]
    item_ids = [it.id for it in order.items]
    return [
        ScheduledStop(
            sequence=1,
            stop_type="PICKUP",
            location_id=order.pickup_location.id,
            location_name=order.pickup_location.name,
            order_id=order.id,
            allocation_id=order.id,
            latitude=order.pickup_location.latitude,
            longitude=order.pickup_location.longitude,
            arrival_time_sec=3600,
            departure_time_sec=3660,
            items_loaded=list(item_ids),
            items_unloaded=[],
        ),
        ScheduledStop(
            sequence=2,
            stop_type="DELIVERY",
            location_id=order.delivery_location.id,
            location_name=order.delivery_location.name,
            order_id=order.id,
            allocation_id=order.id,
            latitude=order.delivery_location.latitude,
            longitude=order.delivery_location.longitude,
            arrival_time_sec=3720,
            departure_time_sec=3780,
            items_loaded=[],
            items_unloaded=list(item_ids),
        ),
    ]


@pytest.mark.parametrize(
    ("allowed_orientations", "expected_rotation"),
    [(None, True), (["LWH"], False)],
)
def test_exact_route_reuses_final_spatial_validation(
    monkeypatch, allowed_orientations, expected_rotation
):
    request = _independent_request(num_orders=1, num_vehicles=1, items_per_order=[1])
    request.orders[0].items[0].allowed_orientations = allowed_orientations
    engine = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=5.0)
    route = _pair_stops_for(engine, 0)
    rotations = []
    validate = alns_engine.validate_stop_actions

    def track(policy, vehicle, actions, **kwargs):
        rotations.append(actions[0].items_to_load[0].can_rotate)
        return validate(policy, vehicle, actions, **kwargs)

    monkeypatch.setattr(alns_engine, "validate_stop_actions", track)
    assert engine._validate_exact_route(0, route, max_time_seconds=1.0)
    response = engine._build_final_response([route], [], include_benchmarks=False)

    assert response.status == "SUCCESS"
    assert rotations == [expected_rotation]

    route[0] = route[0].model_copy(update={"location_name": "Updated pickup"})
    response = engine._build_final_response([route], [], include_benchmarks=False)
    assert response.status == "SUCCESS"
    pickup = response.routes[0].spatial_validation.step_states[0]
    assert pickup.action_description == "Stop 1 (PICKUP) - Updated pickup"


def test_empty_timeout_audit_candidate_does_not_suppress_routed_partial(monkeypatch):
    req = _independent_request(num_orders=2, num_vehicles=2, items_per_order=[1, 1])
    engine = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=5.0, random_seed=0)

    cand0_routes = [_pair_stops_for(engine, 0) + _pair_stops_for(engine, 1), []]
    cand1_routes = [_pair_stops_for(engine, 0), _pair_stops_for(engine, 1)]
    engine._ils_elite_routes_pool = [
        ((0, 0, 0, 0, 0, 0), cand0_routes, []),
        ((0, 1, 0, 0, 0, 0), cand1_routes, []),
    ]

    monkeypatch.setattr(engine, "_audited_cycle_checkpoint", lambda *a, **kw: None)
    monkeypatch.setattr(engine, "_build_hybrid_initial_solution", lambda *a, **kw: None)
    monkeypatch.setattr(engine, "_polish_audited_response", lambda resp, *a, **kw: resp)
    monkeypatch.setattr(engine, "_optimize_production_vehicles", lambda *a, **kw: None)

    valid_route_0 = OptimizedRoute(
        route_id=engine.vehicles[0].id,
        vehicle_id=engine.vehicles[0].id,
        plate_number=engine.vehicles[0].plate_number,
        vehicle_length_cm=engine.vehicles[0].length_cm,
        vehicle_width_cm=engine.vehicles[0].width_cm,
        vehicle_height_cm=engine.vehicles[0].height_cm,
        start_time_sec=3540,
        end_time_sec=3840,
        total_distance_km=2.0,
        total_duration_minutes=5.0,
        stops=_pair_stops_for(engine, 0),
        spatial_validation=SpatialValidationResult(is_valid=True),
        cost=RouteCostBreakdown(
            base_fuel_cost_vnd=30_000,
            load_fuel_surcharge_vnd=5_000,
            fuel_cost_vnd=35_000,
            cargo_holding_cost_vnd=15_000,
            late_delivery_penalty_vnd=0,
            cargo_distance_ton_km=0.2,
            cargo_time_ton_hours=0.1,
            vehicle_fixed_cost_vnd=100_000,
            driver_fixed_salary_allocation_vnd=0,
            driver_trip_pay_vnd=0,
            total_cost_vnd=150_000,
        ),
    )

    def fake_build_final(routes_stops, unassigned_ids, **kwargs):
        if len(routes_stops[0]) == 4:
            return FleetOptimizationResponse(
                job_id=req.job_id,
                status="TIMEOUT",
                routes=[],
                unassigned_orders=[
                    UnassignedOrder(
                        order_id=o.id,
                        order_number=o.order_number,
                        reason_code="TIMEOUT",
                        reason_message="Hết thời gian kiểm tra.",
                    )
                    for o in engine.orders
                ],
            )
        return FleetOptimizationResponse(
            job_id=req.job_id,
            status="PARTIAL",
            total_distance_km=2.0,
            total_duration_minutes=5.0,
            total_cost_vnd=150_000,
            routes=[valid_route_0],
            unassigned_orders=[
                UnassignedOrder(
                    order_id=engine.orders[1].id,
                    order_number=engine.orders[1].order_number,
                    reason_code="UNASSIGNED",
                    reason_message="Không đủ chỗ.",
                )
            ],
        )

    monkeypatch.setattr(engine, "_build_final_response", fake_build_final)
    result = engine.solve()
    assert result.status == "PARTIAL"
    assert len(result.routes) == 1
    assert [u.order_id for u in result.unassigned_orders] == [engine.orders[1].id]


def test_audited_cycle_checkpoint_handles_surplus_slots_and_filters_small_vehicles(monkeypatch):
    # 4 resource pairs for 2 orders (surplus multi-day slots), >= 10 * orders items (20 items)
    req = _independent_request(
        num_orders=2,
        num_vehicles=4,
        items_per_order=[15, 5],
        vehicle_dims=[
            (100.0, 100.0, 200.0, 5000.0),  # veh-0 too small for 15 items (30,000 cm2)
            (400.0, 200.0, 200.0, 5000.0),  # veh-1 large enough
            (100.0, 100.0, 200.0, 5000.0),  # veh-2 too small
            (400.0, 200.0, 200.0, 5000.0),  # veh-3 large enough
        ],
        vehicle_costs=[10_000, 50_000, 10_000, 50_000],
        service_days=[0, 0, 1, 1],
    )
    engine = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=5.0, random_seed=0)
    routes, missing = engine._conservative_cycle_construction(
        [engine.orders[0].id, engine.orders[1].id],
        time.perf_counter() + 3.0,
        [0, 1, 2, 3],
    )
    assert not missing
    # Oversized 15-item order must NOT be placed on small veh-0 or veh-2
    assert any(s.order_id == engine.orders[0].id for s in routes[1] + routes[3])
    assert not any(s.order_id == engine.orders[0].id for s in routes[0] + routes[2])

    # Even if construction + native search produce nothing, surplus-slot checkpoint recovers 100%
    monkeypatch.setattr(engine, "_build_hybrid_initial_solution", lambda *a, **kw: None)
    result = engine.solve()
    assert result.status == "SUCCESS"
    assert not result.unassigned_orders


def test_build_final_response_allocates_weighted_budget_to_dense_route(monkeypatch):
    req = _independent_request(num_orders=2, num_vehicles=2, items_per_order=[2, 45])
    engine = PackingAwareHybridALNSOptimizer(req, time_budget_seconds=8.0, random_seed=0)
    routes_stops = [_pair_stops_for(engine, 0), _pair_stops_for(engine, 1)]

    recorded_budgets: Dict[int, float] = {}

    def spy_validate(vehicle_index, actions, max_time_seconds=None):
        recorded_budgets[vehicle_index] = float(max_time_seconds or 0.0)
        return SpatialValidationResult(is_valid=True, step_states=[])

    monkeypatch.setattr(engine, "_validate_spatial_actions", spy_validate)
    res = engine._build_final_response(
        routes_stops,
        [],
        include_benchmarks=False,
        spatial_time_budget_seconds=3.2,
    )
    assert res.status == "SUCCESS"
    assert recorded_budgets[1] > 1.5
    assert recorded_budgets[1] > recorded_budgets[0]


def test_solve_hybrid_alns_respects_tight_budget_with_complete_warm_start(monkeypatch):
    import app.hybrid_alns.solver as solver_mod
    from app.hybrid_alns.greedy_insertion import solve_greedy

    # 20 orders x 8 items = 160 items where an un-deadlined solve_greedy rerun would overrun
    positions = [0] + [1 + i for i in range(40)]
    locs = [HybridLocationPoint(id=f"n{i}", name=f"N{i}", latitude=10.0, longitude=106.0) for i in positions]
    vehicles = [
        HybridVehicle(
            id=f"v{k}",
            plate_number=f"29B-00{k}",
            depot=locs[0],
            length_cm=600.0,
            width_cm=220.0,
            height_cm=210.0,
            payload_limit_kg=6000.0,
            fuel_consumption_liters_per_100_km=12.0,
            fixed_operating_cost_vnd=120_000,
        )
        for k in range(4)
    ]
    drivers = [
        HybridDriverOption(id=f"d{k}", full_name=f"D{k}", fixed_salary_monthly_vnd=0, trip_base_pay_vnd=0, per_km_pay_vnd=0)
        for k in range(4)
    ]
    orders = [
        HybridOrderPair(
            id=f"o{i}",
            order_number=f"o{i}",
            pickup_location=locs[1 + 2 * i],
            delivery_location=locs[2 + 2 * i],
            pickup_window_end_sec=28800,
            delivery_window_end_sec=43200,
            service_time_sec=30,
            items=[
                HybridCargoItem(
                    id=f"o{i}-c{j}",
                    order_id=f"o{i}",
                    length_cm=35.0,
                    width_cm=35.0,
                    height_cm=20.0,
                    weight_kg=5.0,
                )
                for j in range(8)
            ],
        )
        for i in range(20)
    ]
    matrix = [[abs(x - y) * 500 for y in positions] for x in positions]
    dur = [[abs(x - y) * 30 for y in positions] for x in positions]
    node_map = {loc.id: idx for idx, loc in enumerate(locs)}
    policy = HybridCostPolicy(fuel_price_per_liter_vnd=22000, monthly_working_minutes=10560)

    warm = solve_greedy(
        vehicles,
        drivers,
        orders,
        policy,
        matrix,
        dur,
        node_map,
    )
    assert not warm.unassigned_orders

    def fail_greedy(*args, **kwargs):
        raise AssertionError("solve_greedy should not be recomputed when complete warm start is given")

    monkeypatch.setattr(solver_mod, "solve_greedy", fail_greedy)

    t0 = time.perf_counter()
    sol = solve_hybrid_alns(
        vehicles,
        drivers,
        orders,
        policy,
        matrix,
        dur,
        node_map,
        time_limit_sec=1.5,
        post_audit_reserve_sec=0.3,
        max_iterations=50,
        random_seed=0,
        initial_solution=warm,
        search_profile="historical_portfolio",
    )
    elapsed = time.perf_counter() - t0
    assert elapsed <= 2.5
    assert not sol.unassigned_orders


def test_default_request_enables_3d_any_customer_stacking_and_standard_upper_tier():
    default_item = CargoItem(
        id="def", order_id="o1", length_cm=40, width_cm=40, height_cm=20, weight_kg=10
    )
    assert default_item.cargo_kind == "STANDARD"
    assert default_item.allow_upper_tier is True

    fragile_item = CargoItem(
        id="frg",
        order_id="o1",
        length_cm=40,
        width_cm=40,
        height_cm=20,
        weight_kg=10,
        cargo_kind="FRAGILE",
    )
    assert fragile_item.allow_upper_tier is False

    protected_item = CargoItem(
        id="prt",
        order_id="o1",
        length_cm=40,
        width_cm=40,
        height_cm=20,
        weight_kg=10,
        no_top_load_requested=True,
    )
    assert protected_item.allow_upper_tier is False

    depot = LocationPoint(id="depot", name="Depot", latitude=10.76, longitude=106.66)
    locs = [
        LocationPoint(id=k, name=k, latitude=10.76 + i * 0.01, longitude=106.66)
        for i, k in enumerate(["p_base", "p_top", "d_top", "d_base"])
    ]
    vehicle = FleetVehicle(
        id="v1",
        plate_number="51C-33333",
        depot=depot,
        length_cm=110,
        width_cm=110,
        height_cm=120,
        payload_limit_kg=1000,
        fuel_consumption_liters_per_100_km=12,
        fixed_operating_cost_vnd=500_000,
    )
    driver = DriverOption(
        id="drv1",
        full_name="Driver 1",
        fixed_salary_monthly_vnd=0,
        trip_base_pay_vnd=100_000,
        per_km_pay_vnd=2_000,
    )
    orders = [
        OrderPair(
            id="o-base",
            order_number="ORD-BASE",
            pickup_location=locs[0],
            delivery_location=locs[3],
            pickup_window_start_sec=0,
            pickup_window_end_sec=1000,
            delivery_window_start_sec=3000,
            delivery_window_end_sec=10000,
            pickup_service_time_sec=60,
            delivery_service_time_sec=60,
            items=[
                CargoItem(
                    id="base-box",
                    order_id="o-base",
                    customer_id="cust-A",
                    length_cm=100,
                    width_cm=100,
                    height_cm=30,
                    weight_kg=100,
                    allow_upper_tier=False,
                    max_top_load_g=29000,
                )
            ],
        ),
        OrderPair(
            id="o-top",
            order_number="ORD-TOP",
            pickup_location=locs[1],
            delivery_location=locs[2],
            pickup_window_start_sec=0,
            pickup_window_end_sec=3000,
            delivery_window_start_sec=0,
            delivery_window_end_sec=2800,
            pickup_service_time_sec=60,
            delivery_service_time_sec=60,
            items=[
                CargoItem(
                    id="top-box",
                    order_id="o-top",
                    customer_id="cust-B",
                    length_cm=60,
                    width_cm=60,
                    height_cm=20,
                    weight_kg=15,
                )
            ],
        ),
    ]
    dist = [[0 if i == j else 3000 for j in range(5)] for i in range(5)]
    dur = [[0 if i == j else 300 for j in range(5)] for i in range(5)]
    policy = CostPolicy(fuel_price_per_liter_vnd=23000, monthly_working_minutes=10560)

    # Omitting demo_stacking activates 3D default (3 tiers, 5.0cm, ANY_CUSTOMER)
    req_default_3d = FleetOptimizationRequest(
        job_id="default-3d-check",
        vehicles=[vehicle],
        drivers=[driver],
        orders=orders,
        policy=policy,
        max_time_seconds=8,
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )
    assert req_default_3d.demo_stacking == DemoStackingPolicy(
        max_tiers=3, lift_clearance_cm=5.0, owner_mode="ANY_CUSTOMER"
    )
    res_3d = PackingAwareHybridALNSOptimizer(
        req_default_3d, time_budget_seconds=4.0, random_seed=0
    ).solve()
    assert res_3d.status == "SUCCESS"
    assert not res_3d.unassigned_orders
    placed_all = [
        p
        for r in res_3d.routes
        for st in r.spatial_validation.step_states
        for p in st.placed_items
    ]
    assert any(
        p.item_id == "top-box" and p.z == 30.0 and p.support_item_id == "base-box"
        for p in placed_all
    )

    # Explicit demo_stacking=None opts out to 2D non-stacking
    req_2d_opt_out = FleetOptimizationRequest(
        job_id="explicit-2d-opt-out",
        vehicles=[vehicle],
        drivers=[driver],
        orders=orders,
        demo_stacking=None,
        policy=policy,
        max_time_seconds=8,
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )
    assert req_2d_opt_out.demo_stacking is None
    res_2d = PackingAwareHybridALNSOptimizer(
        req_2d_opt_out, time_budget_seconds=4.0, random_seed=0
    ).solve()
    assert res_2d.status == "PARTIAL"
    assert len(res_2d.unassigned_orders) == 1
