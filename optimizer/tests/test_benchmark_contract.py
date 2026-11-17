"""Comparison engines must solve the same request as the production engine."""
import time
import math
import pytest

from app.models import CargoItem, CostPolicy, DriverOption, FleetOptimizationRequest, FleetVehicle, LocationPoint, OrderPair
from benchmarks.algorithm_comparison.common import convert_request_to_hybrid


def test_portfolio_reuses_rank_for_same_routes_but_not_a_different_manifest(monkeypatch):
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from benchmarks.savings_warm_start.variant import VariantHybridALNSOptimizer

    calls = []

    def rank(_optimizer, _routes, unassigned):
        calls.append(set(unassigned))
        return len(set(unassigned)), 0, 0, 0, 0, 0

    monkeypatch.setattr(PackingAwareHybridALNSOptimizer, "_rank_candidate_for_audit", rank)
    optimizer = VariantHybridALNSOptimizer(comparison_request(), cache_load_cycles=True)
    assert optimizer._rank_candidate_for_audit([[]], ["part-0", "part-1"]) == (
        optimizer._rank_candidate_for_audit([[]], ["part-1", "part-0"])
    )
    assert optimizer._rank_candidate_for_audit([[]], ["part-0"])[0] == 1
    assert calls == [{"part-0", "part-1"}, {"part-0"}]


def test_portfolio_worker_ranks_and_audits_original_snapshot_after_pruning(monkeypatch):
    from app.models import FleetOptimizationResponse
    from app.request_preprocessor import prune_unserviceable_virtual_resources
    from benchmarks.savings_warm_start.run import type_request
    from benchmarks.savings_warm_start import variant

    original = type_request("scenario_7_multi_depot_overnight.json", 15)
    pruned, removed = prune_unserviceable_virtual_resources(original)
    assert removed > 0
    optimizer = variant.VariantHybridALNSOptimizer(pruned, audit_request=original)
    task = optimizer._worker_tasks(time.perf_counter() + 15)[1]

    def audit(request, plan, *, is_raw_hybrid):
        assert request.model_dump() == original.model_dump()
        assert request.model_dump() != pruned.model_dump()
        return {"cost_vnd": None}

    def solve(worker, **kwargs):
        assert worker.objective_request.model_dump() == original.model_dump()
        assert worker.request.model_dump() != original.model_dump()
        return FleetOptimizationResponse(job_id=original.job_id, status="TIMEOUT")

    monkeypatch.setattr(variant, "audit_solution", audit)
    monkeypatch.setattr(variant.VariantHybridALNSOptimizer, "solve", solve)
    result = variant._run_portfolio_worker(task)
    assert result["stream"] == "adaptive-sa-alns"


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


def test_hybrid_search_penalty_preserves_order_age_and_grace_period():
    from app.hybrid_alns.solver import HybridALNSSolver
    from app.hybrid_alns.route_evaluator import schedule_and_evaluate_route
    from app.route_costing import calculate_late_delivery_penalty
    request = comparison_request()
    request.orders = [request.orders[0]]
    request.orders[0].ordered_at_sec = -4 * 86400
    request.policy.delivery_grace_days = 2
    request.policy.late_delivery_penalty_mode = 'FIXED_PER_DAY'
    request.policy.late_delivery_penalty_value = 120000
    request.distance_matrix_meters = [row[:3] for row in request.distance_matrix_meters[:3]]
    request.duration_matrix_seconds = [row[:3] for row in request.duration_matrix_seconds[:3]]
    args = convert_request_to_hybrid(request)
    vehicles, drivers, orders, policy, distances, durations, indices = args
    assert orders[0].ordered_at_sec == -4 * 86400
    assert policy.delivery_grace_days == 2
    solver = HybridALNSSolver(*args, time_limit_sec=0.1)
    pickup, delivery = solver._make_stops(orders[0])
    result = schedule_and_evaluate_route(vehicles[0], drivers[0], [pickup, delivery],
        solver.order_by_id, solver.cargo_by_id, policy, distances, durations, indices)
    assert result.feasible, result.reason
    assert result.cost.late_delivery_penalty_vnd == calculate_late_delivery_penalty(
        request.orders[0], result.stops[-1].arrival_time_sec, request.policy)
    assert result.cost.late_delivery_penalty_vnd > 240000


def test_split_customer_order_is_charged_once_at_its_last_delivery():
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from app.route_costing import calculate_late_delivery_penalty
    from app.planning_objective import apply_planning_objective
    request = comparison_request()
    request.policy.late_delivery_penalty_mode = 'FIXED_PER_DAY'
    request.policy.late_delivery_penalty_value = 50000
    for order in request.orders:
        order.ordered_at_sec = -4 * 86400
    plan = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2, include_benchmarks=False).solve()
    assert not plan.unassigned_orders
    last_delivery = max(stop.arrival_time_sec for route in plan.routes
        for stop in route.stops if stop.stop_type == 'DELIVERY')
    expected = calculate_late_delivery_penalty(request.orders[0], last_delivery, request.policy)
    assert sum(route.cost.late_delivery_penalty_vnd for route in plan.routes) == expected
    cost = plan.total_cost_vnd
    apply_planning_objective(request, plan)
    assert plan.total_cost_vnd == cost


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


def test_request_packing_intensity_is_continuous_and_bounded():
    from benchmarks.savings_warm_start.search_helpers import request_packing_intensity

    base = comparison_request()
    template = base.orders[0]
    item_tpl = template.items[0]

    def build_with_item_counts(counts: list[int]):
        orders = [
            template.model_copy(
                update={
                    "id": f"ord-{idx}",
                    "order_number": f"ORD-{idx}",
                    "items": [
                        item_tpl.model_copy(update={"id": f"it-{idx}-{j}"})
                        for j in range(cnt)
                    ],
                }
            )
            for idx, cnt in enumerate(counts)
        ]
        return base.model_copy(update={"orders": orders})

    low = request_packing_intensity(build_with_item_counts([1, 2, 2, 3]))
    one_outlier = request_packing_intensity(build_with_item_counts([2, 2, 2, 22]))
    medium = request_packing_intensity(build_with_item_counts([10, 10, 12, 12]))
    high = request_packing_intensity(build_with_item_counts([22, 24, 28, 34]))

    assert low == 0.0
    assert 0.0 < one_outlier < medium < 0.75
    assert high == 1.0


def _routed_partial_example():
    import copy
    from benchmarks.savings_warm_start.variant import VariantHybridALNSOptimizer

    base = comparison_request()
    day_start = 8 * 3600
    daytime_vehicles = [
        vehicle.model_copy(
            update={
                "available_start_sec": day_start,
                "available_end_sec": day_start + 10 * 3600,
            }
        )
        for vehicle in base.vehicles
    ]
    independent_orders = [
        order.model_copy(
            update={
                "source_order_id": order.id,
                "source_order_number": order.order_number,
                "split_group_id": None,
                "ordered_at_sec": day_start,
                "pickup_window_start_sec": day_start,
                "pickup_window_end_sec": day_start + 10 * 3600,
                "delivery_window_start_sec": day_start,
                "delivery_window_end_sec": day_start + 10 * 3600,
            }
        )
        for order in base.orders
    ]
    request = base.model_copy(
        update={"vehicles": daytime_vehicles, "orders": independent_orders}
    )
    opt = VariantHybridALNSOptimizer(
        request,
        time_budget_seconds=2.0,
        include_benchmarks=False,
        enable_portfolio=False,
    )
    first_stops = [
        copy.deepcopy(stop)
        for stop in opt._stop_templates_by_order_id[request.orders[0].id]
    ]
    partial = opt._build_final_response([first_stops], [request.orders[1].id])
    return request, opt, partial


def test_can_polish_audited_result_allows_valid_partial_plans_only():
    import time
    from benchmarks.savings_warm_start.variant import _can_polish_audited_result

    _, _, routed_partial = _routed_partial_example()
    empty_plan = routed_partial.model_copy(update={"routes": []})
    now = time.perf_counter()

    valid_partial_result = {
        "quality": (0, -1),
        "metric": {"audit": {"complete_manifest": False}},
    }
    invalid_result = {
        "quality": (1, -1),
        "metric": {"audit": {"complete_manifest": True}},
    }

    assert _can_polish_audited_result(valid_partial_result, routed_partial, now + 2.0, 0.1)
    assert not _can_polish_audited_result(valid_partial_result, empty_plan, now + 2.0, 0.1)
    assert not _can_polish_audited_result(invalid_result, routed_partial, now + 2.0, 0.1)
    assert not _can_polish_audited_result(valid_partial_result, routed_partial, now + 0.02, 0.1)


def test_spare_budget_lns_polish_inserts_unassigned_orders_when_feasible():
    import time
    from benchmarks.algorithm_comparison.unified_audit import audit_solution
    from benchmarks.savings_warm_start.search_helpers import spare_budget_lns_polish

    request, opt, partial = _routed_partial_example()
    assert len(partial.unassigned_orders) == 1
    assert partial.routes

    polished = spare_budget_lns_polish(opt, partial, time.perf_counter() + 3.0)
    audit = audit_solution(request, polished, is_raw_hybrid=False)
    assert len(polished.unassigned_orders) == 0
    assert audit["complete_manifest"] is True
    assert audit["spatial_valid"] is True
    assert audit["basic_schedule_valid"] is True


def test_demo_stacking_cache_hits_valid_and_skips_search_limit_timeouts(monkeypatch):
    from unittest.mock import patch
    from app import stacking
    from app.models import DemoStackingPolicy, FloorState, SpatialValidationResult, StopAction
    from benchmarks.savings_warm_start import variant
    from benchmarks.savings_warm_start.variant import VariantHybridALNSOptimizer

    base = comparison_request().model_copy(
        update={
            "demo_stacking": DemoStackingPolicy(
                max_tiers=2, lift_clearance_cm=10, owner_mode="ANY_CUSTOMER"
            )
        }
    )
    opt = VariantHybridALNSOptimizer(
        base, time_budget_seconds=2.0, include_benchmarks=False, enable_portfolio=False
    )
    cargo = base.orders[0].items[0].model_copy(update={"allow_upper_tier": True})
    actions_a = [
        StopAction(stop_id="s-a1", sequence=1, stop_type="PICKUP", address="A1", items_to_load=[cargo]),
        StopAction(stop_id="s-a2", sequence=2, stop_type="DELIVERY", address="A2", items_to_unload=[cargo.id]),
    ]
    actions_b = [
        StopAction(stop_id="s-b1", sequence=1, stop_type="PICKUP", address="B1", items_to_load=[cargo]),
        StopAction(stop_id="s-b2", sequence=2, stop_type="DELIVERY", address="B2", items_to_unload=[cargo.id]),
    ]

    calls = {"count": 0}
    real_validate = variant._RAW_VALIDATE_STOP_ACTIONS

    def fake_validate(policy, vehicle, actions, *, max_search_nodes=None, max_time_seconds=None):
        calls["count"] += 1
        if calls["count"] == 1:
            return SpatialValidationResult(
                is_valid=False,
                violation_code="PLACEMENT_SEARCH_LIMIT_REACHED",
                error_message="timeout",
            )
        return SpatialValidationResult(
            is_valid=True,
            violation_code="",
            max_weight_kg=cargo.weight_kg,
            max_area_cm2=cargo.length_cm * cargo.width_cm,
            step_states=[
                FloorState(
                    step_index=i,
                    stop_id=a.stop_id,
                    stop_type=a.stop_type,
                    action_description=f"orig-{a.stop_id}",
                    placed_items=[],
                    current_weight_kg=0.0,
                    current_occupied_area_cm2=0.0,
                    floor_area_cm2=base.vehicles[0].length_cm * base.vehicles[0].width_cm,
                    weight_utilization_percent=0.0,
                    area_utilization_percent=0.0,
                    is_valid=True,
                )
                for i, a in enumerate(actions)
            ],
            demo_stacking=policy,
        )

    assert callable(real_validate)
    with patch.object(stacking, "validate_stop_actions", side_effect=fake_validate):
        # 1st call returns PLACEMENT_SEARCH_LIMIT_REACHED -> must NOT be cached
        first = opt._validate_spatial_actions(0, actions_a, max_time_seconds=0.5)
        assert not first.is_valid and first.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED"
        # 2nd call re-invokes validator and gets valid result -> MUST be cached
        second = opt._validate_spatial_actions(0, actions_a, max_time_seconds=0.5)
        assert second.is_valid and calls["count"] == 2
        # 3rd call with different stop_id/address hits cache and rewrites step_states metadata
        third = opt._validate_spatial_actions(0, actions_b, max_time_seconds=0.5)
        assert third.is_valid and calls["count"] == 2
        assert [s.stop_id for s in third.step_states] == ["s-b1", "s-b2"]
        assert "B1" in third.step_states[0].action_description

    # Verify fast_validate_stacked_route caching inside _fast_packing_context
    fast_calls = {"count": 0}

    def fake_fast_validate(vehicle, stops, cargo_by_id, policy, *, allow_layout_search=True):
        fast_calls["count"] += 1
        if fast_calls["count"] == 1:
            return False, "temporary_fallback_miss"
        return True, "Hợp lệ"

    from app.hybrid_alns import packing_checker
    vehicle = base.vehicles[0]
    stops_a = [
        stop.model_copy(update={"stop_id": "fa-1"})
        for stop in opt._stop_templates_by_order_id[base.orders[0].id]
    ]
    cargo_map = {cargo.id: cargo}
    with patch.object(stacking, "fast_validate_stacked_route", side_effect=fake_fast_validate):
        with variant._fast_packing_context(
            True,
            opt._cycle_validators,
            stacking_cache=opt._stacking_action_cache,
            fast_stacking_cache=opt._fast_stacking_cache,
        ):
            r1 = packing_checker.fast_validate_stacked_route(vehicle, stops_a, cargo_map, base.demo_stacking, allow_layout_search=True)
            assert r1 == (False, "temporary_fallback_miss") and fast_calls["count"] == 1
            # Negative allow_layout_search=True must NOT be cached -> retries and succeeds
            r2 = packing_checker.fast_validate_stacked_route(vehicle, stops_a, cargo_map, base.demo_stacking, allow_layout_search=True)
            assert r2 == (True, "Hợp lệ") and fast_calls["count"] == 2
            # Positive hit must be cached
            r3 = packing_checker.fast_validate_stacked_route(vehicle, stops_a, cargo_map, base.demo_stacking, allow_layout_search=True)
            assert r3 == (True, "Hợp lệ") and fast_calls["count"] == 2


def test_fast_placement_and_lifo_place_box_match_reference():
    from app import alns_engine
    from app.hybrid_alns.packing_checker import FastPackingChecker
    from app.models import CargoItem, PlacedItem
    from benchmarks.savings_warm_start import variant
    from benchmarks.savings_warm_start.cycle_validator import CycleCachingSpatialValidator
    from benchmarks.savings_warm_start.dynamic_packing import FastDynamicPackingChecker

    vehicle = comparison_request().vehicles[0].model_copy(
        update={"length_cm": 300.0, "width_cm": 160.0, "height_cm": 160.0}
    )
    ref_checker = FastPackingChecker(vehicle)
    fast_checker = FastDynamicPackingChecker(vehicle)
    ranks = {"ord-1": 2, "ord-2": 1, "ord-3": 3}

    items = [
        CargoItem(
            id="it-1", order_id="ord-1", description="Heavy base",
            length_cm=100.0, width_cm=80.0, height_cm=80.0,
            weight_kg=300.0, cargo_kind="STANDARD", can_rotate=True,
        ),
        CargoItem(
            id="it-2", order_id="ord-2", description="Fragile box",
            length_cm=60.0, width_cm=50.0, height_cm=50.0,
            weight_kg=12.0, cargo_kind="FRAGILE", can_rotate=True,
        ),
        CargoItem(
            id="it-3", order_id="ord-1", description="Mid box",
            length_cm=90.0, width_cm=70.0, height_cm=60.0,
            weight_kg=90.0, cargo_kind="STANDARD", can_rotate=True,
        ),
        CargoItem(
            id="it-4", order_id="ord-3", description="Side fill",
            length_cm=70.0, width_cm=45.0, height_cm=40.0,
            weight_kg=45.0, cargo_kind="FRAGILE", can_rotate=False,
        ),
        CargoItem(
            id="it-too-tall", order_id="ord-3", description="Oversized height",
            length_cm=40.0, width_cm=40.0, height_cm=220.0,
            weight_kg=20.0, cargo_kind="STANDARD",
        ),
    ]

    ref_placed: list[PlacedItem] = []
    fast_placed: list[PlacedItem] = []
    for it in items:
        rank = ranks[it.order_id]
        r_res = ref_checker.find_placement(it, ref_placed, rank, ranks)
        f_res = fast_checker.find_placement(it, fast_placed, rank, ranks)
        assert (r_res is None) == (f_res is None)
        if r_res is not None and f_res is not None:
            assert (r_res.x, r_res.y, r_res.length_cm, r_res.width_cm) == (
                f_res.x, f_res.y, f_res.length_cm, f_res.width_cm
            )
            ref_placed.append(r_res)
            fast_placed.append(f_res)

    raw_lifo = alns_engine.FastLIFOPackingChecker(vehicle)
    ref_boxes: list[dict] = []
    fast_boxes: list[dict] = []
    validators = {0: CycleCachingSpatialValidator(vehicle)}
    for it in items[:-1]:
        r_box = raw_lifo._place_box(it, ref_boxes)
        with variant._fast_packing_context(False, validators):
            f_box = alns_engine.FastLIFOPackingChecker(vehicle)._place_box(it, fast_boxes)
        assert r_box == f_box
        if r_box is not None:
            ref_boxes.append(r_box)
            fast_boxes.append(f_box)


def test_min_route_clique_lower_bound_uses_simultaneous_sweep_bound():
    from benchmarks.savings_warm_start.search_helpers import _min_route_clique_lower_bound
    from benchmarks.savings_warm_start.variant import VariantHybridALNSOptimizer

    base = comparison_request()
    # Configure 3 identical heavy orders whose guaranteed onboard intervals (lp < ed)
    # overlap simultaneously at t = 150..250: any pair fits on 1 truck, but all 3 cannot.
    v_cap = float(base.vehicles[0].payload_limit_kg)
    each_wt = round(v_cap * 0.45, 2)
    base_ord = base.orders[0]
    orders = []
    for idx in range(3):
        oid = f"sweep-o{idx}"
        it = base_ord.items[0].model_copy(
            update={"id": f"sweep-it-{idx}", "order_id": oid, "weight_kg": each_wt}
        )
        orders.append(
            base_ord.model_copy(
                update={
                    "id": oid,
                    "order_number": f"SW-{idx}",
                    "split_group_id": None,
                    "items": [it],
                    "pickup_window_start_sec": 0,
                    "pickup_window_end_sec": 100,
                    "delivery_window_start_sec": 400,
                    "delivery_window_end_sec": 2000,
                }
            )
        )
    vehs = [
        base.vehicles[0].model_copy(update={"id": f"sv-{i}", "source_vehicle_id": f"sv-{i}"})
        for i in range(3)
    ]
    drvs = [
        base.drivers[0].model_copy(update={"id": f"sd-{i}", "source_driver_id": f"sd-{i}"})
        for i in range(3)
    ]
    n = len(vehs) + 2 * len(orders)
    dist = [[1000 if a != b else 0 for b in range(n)] for a in range(n)]
    dur = [[100 if a != b else 0 for b in range(n)] for a in range(n)]
    req = base.model_copy(
        update={
            "vehicles": vehs,
            "drivers": drvs,
            "orders": orders,
            "distance_matrix_meters": dist,
            "duration_matrix_seconds": dur,
        }
    )
    opt = VariantHybridALNSOptimizer(
        req, time_budget_seconds=2.0, include_benchmarks=False, enable_portfolio=False
    )
    # Pairwise 0.90 * cap <= cap, so only the sweep-line sum (1.35 * cap > cap) proves >= 2.
    assert _min_route_clique_lower_bound(opt) == 2


def test_variant_evaluate_plan_cost_matches_exact_route_economics():
    import time
    from app.route_costing import calculate_route_economic_metrics
    from benchmarks.savings_warm_start.variant import VariantHybridALNSOptimizer

    req = comparison_request()
    opt = VariantHybridALNSOptimizer(
        req, time_budget_seconds=2.0, include_benchmarks=False, enable_portfolio=False
    )
    assert opt._allow_layout_search is True
    routes, failed = opt._repair(
        [[] for _ in opt.vehicles],
        [o.id for o in opt.orders],
        "regret2",
        time.perf_counter() + 1.5,
    )
    assert not failed
    penalized, economic, _ = opt._evaluate_plan_cost(routes, [])
    active_routes = sum(bool(r) for r in routes)
    assert penalized == economic + active_routes * 1_000_000

    # Verify exact route fuel+surcharge+holding sum matches calculate_route_economic_metrics.
    nodes = [{"id": v.depot.id} for v in opt.vehicles] + [
        loc
        for o in opt.orders
        for loc in ({"id": o.pickup_location.id}, {"id": o.delivery_location.id})
    ]
    expected_econ = 0
    for vi, rt in enumerate(routes):
        if not rt:
            continue
        sch = opt._schedule_stops(vi, list(rt))[0]
        w = 0.0
        for st in sch:
            o = opt.order_by_id[st.allocation_id or st.order_id]
            w += o.total_weight_kg * (1 if st.stop_type == "PICKUP" else -1)
            st.current_weight_kg = max(0.0, w)
        base, sur, hold, _, _ = calculate_route_economic_metrics(
            opt.request, nodes, opt.order_by_id, opt.vehicles[vi], sch
        )
        dist_km = opt._calc_route_distance_km(vi, sch)
        expected_econ += base + sur + hold + opt.vehicles[vi].fixed_operating_cost_vnd + (
            150_000 + round(1_200 * dist_km)
        )
    assert economic >= expected_econ
