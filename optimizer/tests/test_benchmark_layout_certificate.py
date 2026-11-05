"""An engine's claimed packing flag must never stand in for a checked witness."""
import pytest

from app.models import CargoItem, PlacedItem, StopAction
from benchmarks.algorithm_comparison.layout_certificate import verify_layout_certificate
from test_benchmark_contract import comparison_request


def certificate():
    vehicle = comparison_request().vehicles[0]
    cargo = [CargoItem(id=name, order_id=name, length_cm=40, width_cm=50,
        height_cm=20, weight_kg=10, can_rotate=False) for name in ["A", "B"]]
    actions = [StopAction(stop_id=str(i), sequence=i+1, stop_type=kind,
        items_to_load=[cargo[index]] if kind == "PICKUP" else [],
        items_to_unload=[cargo[index].id] if kind == "DELIVERY" else [])
        for i, (kind, index) in enumerate([("PICKUP", 0), ("PICKUP", 1),
            ("DELIVERY", 1), ("DELIVERY", 0)])]
    a = PlacedItem(item_id="A", order_id="A", x=0, y=0,
        length_cm=40, width_cm=50, height_cm=20, weight_kg=10)
    b = a.model_copy(update={"item_id": "B", "order_id": "B", "x": 60})
    return vehicle, actions, [[a], [a, b], [a], []], [[], [], ["B"], ["A"]]


def test_fixed_certificate_proves_nonstacking_and_access_without_layout_search():
    assert verify_layout_certificate(*certificate()) is None


@pytest.mark.parametrize("corruption,reason", [
    ("overlap", "overlapping"), ("outside", "outside"), ("moved", "moved"),
    ("missing", "manifest"), ("rotation", "rotation"), ("payload", "payload"),
    ("nonfinite", "nonfinite"), ("steps", "step count"), ("door", "outside"),
])
def test_invalid_certificate_cannot_pass_by_claiming_validity(corruption, reason):
    vehicle, actions, layouts, sequences = certificate()
    if corruption == "overlap":
        layouts[1][1] = layouts[1][1].model_copy(update={"x": 20})
    elif corruption == "outside":
        layouts[1][1] = layouts[1][1].model_copy(update={"x": 80})
    elif corruption == "moved":
        layouts[1][0] = layouts[1][0].model_copy(update={"x": 10})
    elif corruption == "missing":
        layouts[1] = layouts[1][1:]
    elif corruption == "rotation":
        layouts[1][1] = layouts[1][1].model_copy(update={"length_cm": 50, "width_cm": 40})
    elif corruption == "payload":
        vehicle.payload_limit_kg = 15
    elif corruption == "nonfinite":
        layouts[1][1] = layouts[1][1].model_copy(update={"x": float("nan")})
    elif corruption == "steps":
        layouts.pop()
    elif corruption == "door":
        vehicle.door_width_cm = 30
    assert reason in verify_layout_certificate(vehicle, actions, layouts, sequences)


def test_loading_certificate_cannot_temporarily_remove_an_old_package():
    vehicle, actions, layouts, sequences = certificate()
    a = layouts[0][0].model_copy(update={"x": 60})
    b = layouts[1][1].model_copy(update={"x": 0})
    layouts = [[a], [a, b], [a], []]
    assert verify_layout_certificate(vehicle, actions, layouts, sequences) == "certificate blocked pickup"


def test_delivery_certificate_rejects_a_package_blocked_by_later_cargo():
    vehicle, actions, layouts, sequences = certificate()
    actions[2] = actions[2].model_copy(update={"items_to_unload": ["A"]})
    actions[3] = actions[3].model_copy(update={"items_to_unload": ["B"]})
    layouts[2] = [layouts[1][1]]
    sequences[2:] = [["A"], ["B"]]
    assert verify_layout_certificate(vehicle, actions, layouts, sequences) == "certificate blocked delivery"


def test_auditor_checks_the_published_geometry_instead_of_trusting_or_repacking_it(monkeypatch):
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from app.spatial_validator import SpatialValidator
    from benchmarks.algorithm_comparison.unified_audit import audit_solution
    request = comparison_request()
    request.vehicles[0].available_start_sec = 28800
    request.vehicles[0].available_end_sec = 61200
    engine = PackingAwareHybridALNSOptimizer(request, include_benchmarks=False)
    routes, missing = engine._repair_greedy_insert([[]], [o.id for o in engine.orders], randomize=False)
    assert not missing
    plan = engine._build_final_response(routes, [], include_benchmarks=False)

    def unexpected_search(*args, **kwargs):
        raise AssertionError("A complete certificate must be checked, not repacked")

    monkeypatch.setattr(SpatialValidator, "validate_plan", unexpected_search)
    audit = audit_solution(request, plan, False)
    assert audit["spatial_valid"] and audit["complete_manifest"]
    assert audit["spatial_certificate_routes"] == 1 and audit["spatial_search_routes"] == 0
    plan.routes[0].spatial_validation.step_states[0].placed_items[0].x = 9999
    assert plan.routes[0].spatial_validation.is_valid
    audit = audit_solution(request, plan, False)
    assert not audit["spatial_valid"]
    assert "certificate package outside floor" in audit["spatial_errors"]


def test_auditor_uses_the_same_confirmed_d11_rotation_policy_as_production():
    from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
    from benchmarks.algorithm_comparison.unified_audit import audit_solution
    request = comparison_request()
    request.vehicles[0].length_cm, request.vehicles[0].width_cm = 50, 100
    request.vehicles[0].available_start_sec, request.vehicles[0].available_end_sec = 28800, 61200
    request.orders = request.orders[:1]
    request.orders[0].items[0].length_cm = 70
    request.orders[0].items[0].width_cm = 40
    assert not request.orders[0].items[0].can_rotate
    request.distance_matrix_meters = [[0 if i == j else 100 for j in range(3)] for i in range(3)]
    request.duration_matrix_seconds = [[0 if i == j else 10 for j in range(3)] for i in range(3)]
    engine = PackingAwareHybridALNSOptimizer(request, include_benchmarks=False)
    valid, stops = engine._can_insert_order(0, [], engine.orders[0], 0, 1, check_packing=False)
    assert valid
    plan = engine._build_final_response([stops], [], include_benchmarks=False)
    assert not plan.unassigned_orders
    placed = plan.routes[0].spatial_validation.step_states[0].placed_items[0]
    assert (placed.length_cm, placed.width_cm) == (40, 70)
    assert audit_solution(request, plan, False)["spatial_valid"]
