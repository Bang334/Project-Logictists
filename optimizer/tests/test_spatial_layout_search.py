from typing import List

from app.models import CargoItem, PlacedItem, StopAction, VehicleFloor
from app.spatial_validator import SpatialValidator


def _square_package(order_id: str, index: int) -> CargoItem:
    return CargoItem(
        id=f"{order_id}-{index}",
        order_id=order_id,
        length_cm=100,
        width_cm=100,
        height_cm=100,
        weight_kg=10,
        can_rotate=False,
    )


def _two_by_two_truck() -> VehicleFloor:
    return VehicleFloor(
        id="truck-layout-search",
        plate_number="TEST",
        length_cm=200,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=1_000,
    )


def test_searches_an_alternative_layout_instead_of_rejecting_input_order() -> None:
    """Two orders fit either in independent lanes or in delivery-aware rows."""
    first_delivery = [_square_package("order-1", index) for index in range(2)]
    last_delivery = [_square_package("order-2", index) for index in range(2)]

    result = SpatialValidator(_two_by_two_truck()).validate_plan(
        [
            StopAction(
                stop_id="pickup",
                sequence=1,
                stop_type="PICKUP",
                items_to_load=first_delivery + last_delivery,
            ),
            StopAction(
                stop_id="deliver-order-1",
                sequence=2,
                stop_type="DELIVERY",
                items_to_unload=[item.id for item in first_delivery],
            ),
            StopAction(
                stop_id="deliver-order-2",
                sequence=3,
                stop_type="DELIVERY",
                items_to_unload=[item.id for item in last_delivery],
            ),
        ]
    )

    assert result.is_valid is True
    assert len(result.step_states) == 3


def test_layout_result_does_not_depend_on_package_input_order() -> None:
    first_delivery = [_square_package("order-1", index) for index in range(2)]
    last_delivery = [_square_package("order-2", index) for index in range(2)]

    def validate(load_order: List[CargoItem]):
        return SpatialValidator(_two_by_two_truck()).validate_plan(
            [
                StopAction(
                    stop_id="pickup",
                    sequence=1,
                    stop_type="PICKUP",
                    items_to_load=load_order,
                ),
                StopAction(
                    stop_id="deliver-order-1",
                    sequence=2,
                    stop_type="DELIVERY",
                    items_to_unload=[item.id for item in first_delivery],
                ),
                StopAction(
                    stop_id="deliver-order-2",
                    sequence=3,
                    stop_type="DELIVERY",
                    items_to_unload=[item.id for item in last_delivery],
                ),
            ]
        )

    forward = validate(first_delivery + last_delivery)
    reverse = validate(list(reversed(first_delivery + last_delivery)))

    assert forward.is_valid is True
    assert reverse.is_valid is True
    assert {
        (item.item_id, item.x, item.y)
        for item in forward.step_states[0].placed_items
    } == {
        (item.item_id, item.x, item.y)
        for item in reverse.step_states[0].placed_items
    }


def test_later_pickup_may_use_an_independent_corridor() -> None:
    early = CargoItem(
        id="early",
        order_id="order-early",
        length_cm=200,
        width_cm=100,
        height_cm=100,
        weight_kg=20,
        can_rotate=False,
    )
    later = CargoItem(
        id="later",
        order_id="order-later",
        length_cm=200,
        width_cm=100,
        height_cm=100,
        weight_kg=20,
        can_rotate=False,
    )

    result = SpatialValidator(_two_by_two_truck()).validate_plan(
        [
            StopAction(
                stop_id="pickup-early",
                sequence=1,
                stop_type="PICKUP",
                items_to_load=[early],
            ),
            StopAction(
                stop_id="pickup-later",
                sequence=2,
                stop_type="PICKUP",
                items_to_load=[later],
            ),
            StopAction(
                stop_id="deliver-early",
                sequence=3,
                stop_type="DELIVERY",
                items_to_unload=[early.id],
            ),
            StopAction(
                stop_id="deliver-later",
                sequence=4,
                stop_type="DELIVERY",
                items_to_unload=[later.id],
            ),
        ]
    )

    assert result.is_valid is True
    pickup_state = result.step_states[1]
    positions = {item.item_id: item for item in pickup_state.placed_items}
    assert positions[early.id].y != positions[later.id].y


def test_full_width_later_delivery_still_cannot_block_earlier_delivery() -> None:
    truck = VehicleFloor(
        id="single-lane-truck",
        plate_number="TEST-1",
        length_cm=500,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=1_000,
    )
    early = CargoItem(
        id="early",
        order_id="order-early",
        length_cm=300,
        width_cm=200,
        height_cm=100,
        weight_kg=20,
        can_rotate=False,
    )
    later = CargoItem(
        id="later",
        order_id="order-later",
        length_cm=200,
        width_cm=200,
        height_cm=100,
        weight_kg=20,
        can_rotate=False,
    )

    result = SpatialValidator(truck).validate_plan(
        [
            StopAction(
                stop_id="pickup-early",
                sequence=1,
                stop_type="PICKUP",
                items_to_load=[early],
            ),
            StopAction(
                stop_id="pickup-later",
                sequence=2,
                stop_type="PICKUP",
                items_to_load=[later],
            ),
            StopAction(
                stop_id="deliver-early",
                sequence=3,
                stop_type="DELIVERY",
                items_to_unload=[early.id],
            ),
            StopAction(
                stop_id="deliver-later",
                sequence=4,
                stop_type="DELIVERY",
                items_to_unload=[later.id],
            ),
        ]
    )

    assert result.is_valid is False
    assert result.violation_scenario == "T24"


def test_search_limit_is_not_reported_as_infeasible() -> None:
    package = _square_package("order-1", 0)

    result = SpatialValidator(
        _two_by_two_truck(), max_search_nodes=1
    ).validate_plan(
        [
            StopAction(
                stop_id="pickup",
                sequence=1,
                stop_type="PICKUP",
                items_to_load=[package],
            ),
            StopAction(
                stop_id="delivery",
                sequence=2,
                stop_type="DELIVERY",
                items_to_unload=[package.id],
            ),
        ]
    )

    assert result.is_valid is False
    assert result.violation_code == "PLACEMENT_SEARCH_LIMIT_REACHED"
    assert result.violation_scenario is None
    assert "không kết luận chuyến bất khả thi" in result.error_message


def test_ten_packages_per_order_are_arranged_for_delivery_sequence() -> None:
    truck = VehicleFloor(
        id="truck-twenty-packages",
        plate_number="TEST-20",
        length_cm=1_000,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=1_000,
    )
    first_delivery = [_square_package("order-1", index) for index in range(10)]
    last_delivery = [_square_package("order-2", index) for index in range(10)]

    result = SpatialValidator(truck).validate_plan(
        [
            StopAction(
                stop_id="pickup",
                sequence=1,
                stop_type="PICKUP",
                items_to_load=first_delivery + last_delivery,
            ),
            StopAction(
                stop_id="deliver-order-1",
                sequence=2,
                stop_type="DELIVERY",
                items_to_unload=[item.id for item in first_delivery],
            ),
            StopAction(
                stop_id="deliver-order-2",
                sequence=3,
                stop_type="DELIVERY",
                items_to_unload=[item.id for item in last_delivery],
            ),
        ]
    )

    assert result.is_valid is True
    pickup_state = result.step_states[0]
    assert len(pickup_state.placed_items) == 20
    assert {path.item_id for path in pickup_state.package_access_paths} == {
        item.item_id for item in pickup_state.placed_items
    }


def test_package_can_turn_into_a_clear_side_aisle_before_reaching_rear_door() -> None:
    truck = VehicleFloor(
        id="truck-l-shaped-path",
        plate_number="TEST-PATH",
        length_cm=300,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=1_000,
    )
    target = PlacedItem(
        item_id="target",
        order_id="order-1",
        x=0,
        y=0,
        length_cm=100,
        width_cm=100,
        height_cm=100,
        weight_kg=10,
    )
    direct_blocker = PlacedItem(
        item_id="blocker",
        order_id="order-2",
        x=100,
        y=0,
        length_cm=100,
        width_cm=100,
        height_cm=100,
        weight_kg=10,
    )

    validator = SpatialValidator(truck)
    path_clear, blocker_id = validator.is_path_to_door_clear(target, [direct_blocker])

    assert path_clear is True
    assert blocker_id is None
    access_paths = validator._build_package_access_paths(
        {target.item_id: target, direct_blocker.item_id: direct_blocker}
    )
    target_access = next(
        access_path
        for access_path in access_paths
        if access_path.item_id == target.item_id
    )
    assert target_access.is_clear is True
    assert [(point.x, point.y) for point in target_access.points] == [
        (0.0, 0.0),
        (0.0, 100.0),
        (200.0, 100.0),
    ]


def test_three_orders_with_fifteen_packages_can_unload_through_top_aisle() -> None:
    """Regression for the 9 columns x 5 rows layout shown by the user."""
    truck = VehicleFloor(
        id="truck-user-diagram",
        plate_number="TEST-45",
        length_cm=1_000,
        width_cm=600,
        height_cm=200,
        payload_limit_kg=5_000,
    )
    onboard = {}
    order_one_columns = []
    for column in range(9):
        order_number = column % 3 + 1
        if order_number == 1:
            order_one_columns.append(column)
        for row in range(5):
            item_id = f"order-{order_number}-column-{column}-row-{row}"
            onboard[item_id] = PlacedItem(
                item_id=item_id,
                order_id=f"order-{order_number}",
                x=column * 100,
                y=row * 100,
                length_cm=100,
                width_cm=100,
                height_cm=100,
                weight_kg=10,
            )

    validator = SpatialValidator(truck)
    for column in order_one_columns:
        # Clear each vertical column from the top package down. Each removal
        # extends the vertical access channel to the aisle at y=500..600.
        for row in reversed(range(5)):
            item_id = f"order-1-column-{column}-row-{row}"
            target = onboard[item_id]
            others = [item for key, item in onboard.items() if key != item_id]
            path_clear, blocker_id = validator.is_path_to_door_clear(target, others)
            assert path_clear is True, f"{item_id} was blocked by {blocker_id}"
            del onboard[item_id]

    assert len(onboard) == 30


def test_southern_demo_snapshot_loads_45_packages_before_sequential_deliveries() -> None:
    """Keep the seed dimensions and the full six-stop operation executable."""
    truck = VehicleFloor(
        id="branch-sgn-heavy-truck",
        plate_number="50H-156.78",
        length_cm=960,
        width_cm=240,
        height_cm=240,
        payload_limit_kg=14_800,
    )
    orders = [
        [
            CargoItem(
                id=f"sgn-order-{order_number}-{item_number:02}",
                order_id=f"sgn-order-{order_number}",
                length_cm=90,
                width_cm=40,
                height_cm=45,
                weight_kg=140,
                can_rotate=False,
            )
            for item_number in range(1, 16)
        ]
        for order_number in range(1, 4)
    ]
    actions = [
        StopAction(
            stop_id=f"pickup-{index}",
            sequence=index,
            stop_type="PICKUP",
            items_to_load=items,
        )
        for index, items in enumerate(orders, 1)
    ]
    actions.extend(
        StopAction(
            stop_id=f"delivery-{index}",
            sequence=index + 3,
            stop_type="DELIVERY",
            items_to_unload=[item.id for item in items],
        )
        for index, items in enumerate(orders, 1)
    )

    result = SpatialValidator(truck).validate_plan(actions)

    assert result.is_valid is True
    assert len(result.step_states) == 6
    assert max(len(step.placed_items) for step in result.step_states) == 45
    assert result.max_weight_kg == 6_300
    assert result.step_states[-1].placed_items == []


def test_side_gap_narrower_than_package_is_not_a_valid_detour() -> None:
    truck = VehicleFloor(
        id="truck-narrow-aisle",
        plate_number="TEST-NARROW",
        length_cm=300,
        width_cm=190,
        height_cm=200,
        payload_limit_kg=1_000,
    )
    target = PlacedItem(
        item_id="target",
        order_id="order-1",
        x=0,
        y=0,
        length_cm=100,
        width_cm=100,
        height_cm=100,
        weight_kg=10,
    )
    blocker = PlacedItem(
        item_id="blocker",
        order_id="order-2",
        x=100,
        y=0,
        length_cm=100,
        width_cm=100,
        height_cm=100,
        weight_kg=10,
    )

    path_clear, blocker_id = SpatialValidator(truck).is_path_to_door_clear(
        target, [blocker]
    )

    assert path_clear is False
    assert blocker_id == blocker.item_id
