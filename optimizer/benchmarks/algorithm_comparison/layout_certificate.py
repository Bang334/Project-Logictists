"""Verify fixed floor layouts without searching for another packing solution."""
import math
from typing import Optional, Protocol, Sequence

from app.models import FleetVehicle, PlacedItem, StopAction, VehicleFloor
from app.spatial_validator import SpatialValidator


class LayoutItem(Protocol):
    item_id: str
    x: float
    y: float
    length_cm: float
    width_cm: float


def verify_layout_certificate(
    vehicle: FleetVehicle, actions: Sequence[StopAction],
    layouts: Sequence[Sequence[LayoutItem]], unload_sequences: Sequence[Sequence[str]],
) -> Optional[str]:
    """Check identity, geometry, fixed survivors and every ingress/egress.

    Solver validity flags and reported utilization are deliberately unused.
    Reverse removal of new packages proves a loading order: removing a box
    cannot obstruct any of the packages that remain at their fixed positions.
    """
    if len(layouts) != len(actions) or len(unload_sequences) != len(actions):
        return "certificate step count"
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
            if any(not math.isfinite(reported) or abs(reported-expected_value) > tolerance
                for reported, expected_value in [
                    (getattr(item, "height_cm", actual.height_cm), actual.height_cm),
                    (getattr(item, "weight_kg", actual.weight_kg), actual.weight_kg)]):
                return "certificate package metadata"
            footprint = (item.x, item.y, item.length_cm, item.width_cm)
            if not all(math.isfinite(value) for value in footprint):
                return "certificate nonfinite geometry"
            orientations = [(actual.length_cm, actual.width_cm)]
            if actual.can_rotate:
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
            pending = set(loads)
            while pending:
                accessible = next((item_id for item_id in sorted(pending)
                    if geometry.is_path_to_door_clear(remaining[item_id], list(remaining.values()))[0]), None)
                if accessible is None:
                    return "certificate blocked pickup"
                pending.remove(accessible)
                del remaining[accessible]
        previous = current
    return "certificate cargo remains onboard" if previous else None
