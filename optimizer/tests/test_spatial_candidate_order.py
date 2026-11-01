"""A constructive deep placement should not exhaust the layout branch budget."""
from app.models import CargoItem, StopAction, VehicleFloor
from app.spatial_validator import SpatialValidator


def test_multi_pickup_reuse_retains_access_with_a_bounded_layout_search():
    floor = VehicleFloor(id="floor", plate_number="test", length_cm=500,
        width_cm=205, height_cm=210, payload_limit_kg=3500)
    groups = [[CargoItem(id=f"{i}-{j}", order_id=str(i), length_cm=70,
        width_cm=55, height_cm=60, weight_kg=80, can_rotate=True)
        for j in range(count)] for i, count in enumerate([3, 4, 4, 4])]
    sequence = [("PICKUP", 0), ("PICKUP", 1), ("PICKUP", 2),
        ("DELIVERY", 2), ("DELIVERY", 1), ("PICKUP", 3),
        ("DELIVERY", 3), ("DELIVERY", 0)]
    stops = [StopAction(stop_id=str(i), sequence=i+1, stop_type=kind,
        items_to_load=groups[group] if kind == "PICKUP" else [],
        items_to_unload=[c.id for c in groups[group]] if kind == "DELIVERY" else [])
        for i, (kind, group) in enumerate(sequence)]
    validator = SpatialValidator(floor, max_search_nodes=500, max_time_seconds=2)
    result = validator.validate_plan(stops)
    assert result.is_valid, result.error_message
    assert len(result.step_states) == len(stops)
    assert len(result.step_states[2].placed_items) == 11
    assert len(result.step_states[5].placed_items) == 7
    assert not result.step_states[-1].placed_items
    # The long-lived first group remains fixed across unloading and reuse.
    held_ids = {item.id for item in groups[0]}
    layouts = [{item.item_id: (item.x, item.y, item.length_cm, item.width_cm)
        for item in step.placed_items if item.item_id in held_ids}
        for step in result.step_states[:-1]]
    assert all(layout == layouts[0] for layout in layouts)
    previous = {}
    for action, step in zip(stops, result.step_states):
        current = {item.item_id: item for item in step.placed_items}
        for item_id in previous.keys() & current.keys():
            before, after = previous[item_id], current[item_id]
            assert (before.x, before.y, before.length_cm, before.width_cm) == (
                after.x, after.y, after.length_cm, after.width_cm)
        if action.stop_type == "DELIVERY":
            remaining = dict(previous)
            assert set(step.unload_sequence) == set(action.items_to_unload)
            for item_id in step.unload_sequence:
                assert validator.is_path_to_door_clear(remaining[item_id], list(remaining.values()))[0]
                del remaining[item_id]
            assert remaining.keys() == current.keys()
        for index, item in enumerate(step.placed_items):
            assert item.x >= 0 and item.y >= 0
            assert item.x + item.length_cm <= floor.length_cm
            assert item.y + item.width_cm <= floor.width_cm
            for other in step.placed_items[index+1:]:
                assert (item.x + item.length_cm <= other.x
                    or other.x + other.length_cm <= item.x
                    or item.y + item.width_cm <= other.y
                    or other.y + other.width_cm <= item.y)
        previous = current
