"""Construct an executable floor layout for a uniform pickup and delivery."""

from math import isfinite
from time import perf_counter

from app.models import SpatialValidationResult, StopAction
from app.spatial_validator import SpatialValidator, _StepSnapshot


def try_uniform_load_cycle(
    validator: SpatialValidator, stops: list[StopAction],
    *, deadline: float | None = None,
) -> SpatialValidationResult | None:
    """Try rows of equal rectangles, with exact door checks for every move."""
    if len(stops) != 2:
        return None
    pickup, delivery = stops
    items = pickup.items_to_load
    loaded_ids = {item.id for item in items}
    if (
        pickup.stop_type != "PICKUP" or delivery.stop_type != "DELIVERY"
        or not items or pickup.items_to_unload or delivery.items_to_load
        or len(loaded_ids) != len(items)
        or len(delivery.items_to_unload) != len(items)
        or set(delivery.items_to_unload) != loaded_ids
    ):
        return None

    length, width = items[0].length_cm, items[0].width_cm
    door_width = validator.vehicle.door_width_cm
    if (
        length <= 0 or width <= 0 or validator.vehicle.door_position != "REAR"
        or not all(isfinite(value) for value in (length, width, validator.floor_length, validator.floor_width))
        or (door_width is not None and door_width < validator.floor_width)
        or any(
            (item.length_cm, item.width_cm) != (length, width)
            or item.height_cm > validator.floor_height
            or (item.allowed_orientations and "LWH" not in item.allowed_orientations)
            for item in items
        )
    ):
        return None
    lanes = int(validator.floor_width // width)
    columns = int(validator.floor_length // length)
    weight = sum(item.weight_kg for item in items)
    if lanes * columns < len(items) or not isfinite(weight) or weight > validator.payload_limit:
        return None

    # Deterministic row fill. Reversing it removes the packages nearest the
    # rear door first. The inverse sequence loads the same fixed positions.
    placed = tuple(
        validator._to_placed_item(item, ((index // lanes) * length, (index % lanes) * width, length, width))
        for index, item in enumerate(sorted(items, key=lambda item: item.id))
    )
    onboard = []
    for item in placed:
        if deadline is not None and perf_counter() >= deadline:
            return None
        if not validator.is_path_to_door_clear(item, onboard)[0]:
            return None
        onboard.append(item)
    snapshots = [
        _StepSnapshot(stop_index=0, placed_items=placed),
        _StepSnapshot(
            stop_index=1, placed_items=(),
            unload_sequence=tuple(item.item_id for item in reversed(placed)),
        ),
    ]
    states = validator._build_floor_states(stops, snapshots)
    balance = states[0].weight_balance
    return SpatialValidationResult(
        is_valid=True,
        max_weight_kg=round(weight, 3),
        max_area_cm2=len(placed) * length * width,
        max_lateral_imbalance_percent=balance.lateral_imbalance_percent if balance else 0.0,
        step_states=states,
    )
