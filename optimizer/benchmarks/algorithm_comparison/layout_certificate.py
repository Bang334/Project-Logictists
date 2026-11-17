"""Check floor certificates and verify published demo stacks against a policy replay."""
import math
from typing import Optional, Protocol, Sequence

from app.models import DemoStackingPolicy, FleetVehicle, PlacedItem, StopAction, VehicleFloor
from app.packing_rules import resolve_can_rotate
from app.spatial_validator import SpatialValidator
from app.stacking import validate_stop_actions


class LayoutItem(Protocol):
    item_id: str
    x: float
    y: float
    length_cm: float
    width_cm: float


def verify_layout_certificate(
    vehicle: FleetVehicle, actions: Sequence[StopAction],
    layouts: Sequence[Sequence[LayoutItem]], unload_sequences: Sequence[Sequence[str]],
    *, demo_stacking: Optional[DemoStackingPolicy] = None,
) -> Optional[str]:
    """Check identity, geometry, fixed survivors and every ingress/egress.

    Solver validity flags and reported utilization are deliberately unused.
    Reverse removal of new packages proves a loading order: removing a box
    cannot obstruct any of the packages that remain at their fixed positions.
    Elevated demo layouts must also match a successful policy replay.
    """
    if len(layouts) != len(actions) or len(unload_sequences) != len(actions):
        return "certificate step count"
    if any(
        getattr(item, "z", 0.0) != 0 or getattr(item, "support_item_id", None) is not None
        for layout in layouts for item in layout
    ):
        if demo_stacking is None:
            return "certificate stacking policy required"
        return _verify_demo_stack_replay(vehicle, list(actions), layouts, unload_sequences, demo_stacking)
    cargo = {item.id: item for action in actions for item in action.items_to_load}
    floor = VehicleFloor(id=vehicle.id, plate_number=vehicle.plate_number,
        length_cm=vehicle.length_cm, width_cm=vehicle.width_cm, height_cm=vehicle.height_cm,
        payload_limit_kg=vehicle.payload_limit_kg, door_position=vehicle.door_position,
        door_width_cm=vehicle.door_width_cm)
    geometry = SpatialValidator(floor)
    previous: dict[str, PlacedItem] = {}
    loaded_once: set[str] = set()
    tolerance = 0.01
    for action, layout, unload_order in zip(actions, layouts, unload_sequences):
        loads = [item.id for item in action.items_to_load]
        unloads = list(action.items_to_unload)
        if (len(set(loads)) != len(loads) or len(set(unloads)) != len(unloads)
            or set(loads) & loaded_once or not set(unloads) <= previous.keys()
            or (action.stop_type == "PICKUP" and unloads)
            or (action.stop_type == "DELIVERY" and loads)):
            return "certificate action manifest"
        loaded_once.update(loads)
        if action.stop_type == "PICKUP" and unload_order:
            return "certificate unload sequence"
        expected = (previous.keys() | set(loads)) - set(unloads)
        if len({item.item_id for item in layout}) != len(layout) or {item.item_id for item in layout} != expected:
            return "certificate onboard manifest"
        current: dict[str, PlacedItem] = {}
        for item in layout:
            actual = cargo.get(item.item_id)
            if actual is None:
                return "certificate unknown package"
            reported_height = getattr(item, "height_cm", None)
            reported_weight = getattr(item, "weight_kg", None)
            if any(
                not math.isfinite(reported) or abs(reported - expected_value) > tolerance
                for reported, expected_value in [
                    (actual.height_cm if reported_height is None else reported_height, actual.height_cm),
                    (actual.weight_kg if reported_weight is None else reported_weight, actual.weight_kg),
                ]
            ):
                return "certificate package metadata"
            footprint = (item.x, item.y, item.length_cm, item.width_cm)
            if not all(math.isfinite(value) for value in footprint):
                return "certificate nonfinite geometry"
            orientations = [(actual.length_cm, actual.width_cm)]
            if resolve_can_rotate(actual):
                orientations.append((actual.width_cm, actual.length_cm))
            if not any(abs(item.length_cm-length) <= tolerance and abs(item.width_cm-width) <= tolerance
                for length, width in orientations):
                return "certificate footprint or rotation"
            if (item.x < -tolerance or item.y < -tolerance
                or item.x+item.length_cm > vehicle.length_cm+tolerance
                or item.y+item.width_cm > vehicle.width_cm+tolerance
                or actual.height_cm > vehicle.height_cm+tolerance
                or (vehicle.door_width_cm is not None and item.width_cm > vehicle.door_width_cm+tolerance)):
                return "certificate package outside floor"
            current[item.item_id] = PlacedItem(item_id=item.item_id, order_id=actual.order_id,
                x=item.x, y=item.y, length_cm=item.length_cm, width_cm=item.width_cm,
                height_cm=actual.height_cm, weight_kg=actual.weight_kg)
        if sum(item.weight_kg for item in current.values()) > vehicle.payload_limit_kg+tolerance:
            return "certificate payload"
        placed = list(current.values())
        for index, item in enumerate(placed):
            if item.item_id in previous:
                before = previous[item.item_id]
                if any(abs(a-b) > 1e-6 for a, b in zip(
                    (item.x, item.y, item.length_cm, item.width_cm),
                    (before.x, before.y, before.length_cm, before.width_cm))):
                    return "certificate moved onboard package"
            for other in placed[index+1:]:
                if geometry.is_overlap(item.x, item.y, item.length_cm, item.width_cm,
                    other.x, other.y, other.length_cm, other.width_cm):
                    return "certificate overlapping packages"
        if action.stop_type == "DELIVERY":
            if len(unload_order) != len(unloads) or set(unload_order) != set(unloads):
                return "certificate unload sequence"
            remaining = dict(previous)
            for item_id in unload_order:
                if not geometry.is_path_to_door_clear(remaining[item_id], list(remaining.values()))[0]:
                    return "certificate blocked delivery"
                del remaining[item_id]
        else:
            remaining = dict(current)
            # Removing any accessible new package preserves paths that were
            # already clear. Try the packages nearest the rear opening first.
            pending = sorted(
                loads, key=lambda item_id: (
                    -(current[item_id].x + current[item_id].length_cm), item_id,
                ),
            )
            while pending:
                obstacles = list(remaining.values())
                accessible = next((item_id for item_id in pending
                    if geometry.is_path_to_door_clear(remaining[item_id], obstacles)[0]), None)
                if accessible is None:
                    return "certificate blocked pickup"
                pending.remove(accessible)
                del remaining[accessible]
        previous = current
    return "certificate cargo remains onboard" if previous else None


def _verify_demo_stack_replay(
    vehicle: FleetVehicle,
    actions: list[StopAction],
    layouts: Sequence[Sequence[LayoutItem]],
    unload_sequences: Sequence[Sequence[str]],
    policy: DemoStackingPolicy,
) -> Optional[str]:
    """Require the published stack geometry to match a validated policy replay."""
    replay = validate_stop_actions(policy, vehicle, actions, max_time_seconds=3.0)
    if not replay.is_valid or len(replay.step_states) != len(actions):
        return "certificate stack replay could not verify plan"
    for reported, unload_order, state in zip(layouts, unload_sequences, replay.step_states):
        by_id = {item.item_id: item for item in reported}
        expected = {item.item_id: item for item in state.placed_items}
        if len(by_id) != len(reported) or by_id.keys() != expected.keys():
            return "certificate stack onboard manifest"
        if list(unload_order) != state.unload_sequence:
            return "certificate stack unload sequence"
        for item_id, placement in expected.items():
            witness = by_id[item_id]
            if getattr(witness, "support_item_id", None) != placement.support_item_id:
                return "certificate stack support"
            if any(
                not math.isclose(getattr(witness, field, math.nan), getattr(placement, field),
                                 rel_tol=0.0, abs_tol=1e-6)
                for field in ("x", "y", "z", "length_cm", "width_cm", "height_cm", "weight_kg")
            ):
                return "certificate stack geometry"
    return None
