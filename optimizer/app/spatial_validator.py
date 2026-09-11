import time
from collections import deque
from dataclasses import dataclass, field
from typing import Dict, Iterable, Iterator, List, Optional, Set, Tuple

from .models import (
    CargoItem,
    FloorState,
    MovementPoint,
    PackageAccessPath,
    PlacedItem,
    SpatialValidationResult,
    StopAction,
    VehicleFloor,
)


_GEOMETRY_TOLERANCE_CM = 0.01
_DEFAULT_MAX_SEARCH_NODES = 20_000


@dataclass
class _SearchFailure:
    depth: Tuple[int, int]
    violation_code: str
    violation_scenario: Optional[str]
    error_message: str
    max_weight_kg: float
    max_area_cm2: float
    step_states: List[FloorState]


@dataclass
class _SearchContext:
    max_nodes: int
    visited_nodes: int = 0
    limit_reached: bool = False
    best_failure: Optional[_SearchFailure] = None
    max_time_seconds: float = 6.0
    start_time: float = field(default_factory=time.monotonic)

    def consume_node(self) -> bool:
        if self.visited_nodes >= self.max_nodes or (time.monotonic() - self.start_time) >= self.max_time_seconds:
            self.limit_reached = True
            return False
        self.visited_nodes += 1
        return True

    def record_failure(self, failure: _SearchFailure) -> None:
        if self.best_failure is None or failure.depth > self.best_failure.depth:
            self.best_failure = failure


class SpatialValidator:
    """Validate dynamic, non-stacking floor layouts for a complete stop sequence.

    The validator searches alternative orthogonal layouts instead of accepting the
    first input-order placement. Cargo already on board is never moved. Every new
    placement must be reachable from the rear door and must preserve the unload
    path of every package scheduled for an earlier delivery.
    """

    def __init__(
        self,
        vehicle: VehicleFloor,
        max_search_nodes: int = _DEFAULT_MAX_SEARCH_NODES,
        max_time_seconds: float = 6.0,
    ):
        if max_search_nodes <= 0:
            raise ValueError("max_search_nodes must be greater than zero")
        self.vehicle = vehicle
        self.floor_length = vehicle.length_cm
        self.floor_width = vehicle.width_cm
        self.floor_height = vehicle.height_cm
        self.payload_limit = vehicle.payload_limit_kg
        self.total_floor_area = self.floor_length * self.floor_width
        self.max_search_nodes = max_search_nodes
        self.max_time_seconds = max_time_seconds

    def is_overlap(
        self,
        x1: float,
        y1: float,
        l1: float,
        w1: float,
        x2: float,
        y2: float,
        l2: float,
        w2: float,
    ) -> bool:
        """Return whether two floor rectangles overlap, allowing edge contact."""
        return not (
            x1 + l1 <= x2 + _GEOMETRY_TOLERANCE_CM
            or x2 + l2 <= x1 + _GEOMETRY_TOLERANCE_CM
            or y1 + w1 <= y2 + _GEOMETRY_TOLERANCE_CM
            or y2 + w2 <= y1 + _GEOMETRY_TOLERANCE_CM
        )

    def is_path_to_door_clear(
        self,
        target_item: PlacedItem,
        other_items: List[PlacedItem],
    ) -> Tuple[bool, Optional[str]]:
        """Check whether a package can translate through free floor space to the rear door.

        The package keeps its current orientation, but its path may contain both
        longitudinal and lateral segments. Other packages remain fixed.
        """
        obstacles = [
            item for item in other_items if item.item_id != target_item.item_id
        ]
        path = self._find_translation_path_to_door(target_item, obstacles)
        if path is not None:
            return True, None

        direct_blocker = self._first_straight_path_blocker(target_item, obstacles)
        if direct_blocker is not None:
            return False, direct_blocker.item_id
        return False, obstacles[0].item_id if obstacles else None

    def _find_translation_path_to_door(
        self,
        target_item: PlacedItem,
        obstacles: List[PlacedItem],
    ) -> Optional[List[Tuple[float, float]]]:
        """Find an axis-aligned translation path in package configuration space."""
        max_x = self.floor_length - target_item.length_cm
        max_y = self.floor_width - target_item.width_cm
        start = (
            self._normalize_coordinate(target_item.x),
            self._normalize_coordinate(target_item.y),
        )
        if (
            max_x < -_GEOMETRY_TOLERANCE_CM
            or max_y < -_GEOMETRY_TOLERANCE_CM
            or start[0] < -_GEOMETRY_TOLERANCE_CM
            or start[1] < -_GEOMETRY_TOLERANCE_CM
            or start[0] > max_x + _GEOMETRY_TOLERANCE_CM
            or start[1] > max_y + _GEOMETRY_TOLERANCE_CM
        ):
            return None

        max_x = self._normalize_coordinate(max_x)
        max_y = self._normalize_coordinate(max_y)
        if self._first_straight_path_blocker(target_item, obstacles) is None:
            return [start, (max_x, start[1])]

        x_values = self._movement_axis_values(
            start[0],
            max_x,
            (
                coordinate
                for obstacle in obstacles
                for coordinate in (
                    obstacle.x - target_item.length_cm,
                    obstacle.x + obstacle.length_cm,
                )
            ),
        )
        y_values = self._movement_axis_values(
            start[1],
            max_y,
            (
                coordinate
                for obstacle in obstacles
                for coordinate in (
                    obstacle.y - target_item.width_cm,
                    obstacle.y + obstacle.width_cm,
                )
            ),
        )
        x_index = {value: index for index, value in enumerate(x_values)}
        y_index = {value: index for index, value in enumerate(y_values)}
        start_node = (x_index[start[0]], y_index[start[1]])

        valid_nodes: Dict[Tuple[int, int], bool] = {}

        def is_valid_node(node: Tuple[int, int]) -> bool:
            cached = valid_nodes.get(node)
            if cached is not None:
                return cached
            x = x_values[node[0]]
            y = y_values[node[1]]
            valid = not any(
                self.is_overlap(
                    x,
                    y,
                    target_item.length_cm,
                    target_item.width_cm,
                    obstacle.x,
                    obstacle.y,
                    obstacle.length_cm,
                    obstacle.width_cm,
                )
                for obstacle in obstacles
            )
            valid_nodes[node] = valid
            return valid

        if not is_valid_node(start_node):
            return None

        frontier = deque([start_node])
        previous: Dict[Tuple[int, int], Optional[Tuple[int, int]]] = {
            start_node: None
        }
        goal: Optional[Tuple[int, int]] = None
        while frontier:
            node = frontier.popleft()
            if node[0] == len(x_values) - 1:
                goal = node
                break

            for neighbor in self._movement_neighbors(node, x_values, y_values):
                if neighbor in previous or not is_valid_node(neighbor):
                    continue
                start_point = (x_values[node[0]], y_values[node[1]])
                end_point = (x_values[neighbor[0]], y_values[neighbor[1]])
                if not self._translation_segment_is_clear(
                    target_item, start_point, end_point, obstacles
                ):
                    continue
                previous[neighbor] = node
                frontier.append(neighbor)

        if goal is None:
            return None

        reversed_path: List[Tuple[float, float]] = []
        cursor: Optional[Tuple[int, int]] = goal
        while cursor is not None:
            reversed_path.append((x_values[cursor[0]], y_values[cursor[1]]))
            cursor = previous[cursor]
        return self._compress_translation_path(list(reversed(reversed_path)))

    def _compress_translation_path(
        self,
        path: List[Tuple[float, float]],
    ) -> List[Tuple[float, float]]:
        """Keep only endpoints and actual turns from the grid-search path."""
        if len(path) <= 2:
            return path
        compressed = [path[0]]
        for index in range(1, len(path) - 1):
            previous = path[index - 1]
            current = path[index]
            following = path[index + 1]
            same_horizontal_segment = (
                abs(previous[1] - current[1]) <= _GEOMETRY_TOLERANCE_CM
                and abs(current[1] - following[1]) <= _GEOMETRY_TOLERANCE_CM
            )
            same_vertical_segment = (
                abs(previous[0] - current[0]) <= _GEOMETRY_TOLERANCE_CM
                and abs(current[0] - following[0]) <= _GEOMETRY_TOLERANCE_CM
            )
            if not same_horizontal_segment and not same_vertical_segment:
                compressed.append(current)
        compressed.append(path[-1])
        return compressed

    def _first_straight_path_blocker(
        self,
        target_item: PlacedItem,
        obstacles: List[PlacedItem],
    ) -> Optional[PlacedItem]:
        for other in obstacles:
            if self._blocks_straight_path(target_item, other):
                return other
        return None

    def _movement_axis_values(
        self,
        start: float,
        maximum: float,
        critical_values: Iterable[float],
    ) -> List[float]:
        values = {0.0, start, maximum}
        for value in critical_values:
            if -_GEOMETRY_TOLERANCE_CM <= value <= maximum + _GEOMETRY_TOLERANCE_CM:
                clamped = min(max(value, 0.0), maximum)
                values.add(self._normalize_coordinate(clamped))
        return sorted(values)

    def _movement_neighbors(
        self,
        node: Tuple[int, int],
        x_values: List[float],
        y_values: List[float],
    ) -> Iterator[Tuple[int, int]]:
        x_index, y_index = node
        if x_index > 0:
            yield x_index - 1, y_index
        if x_index + 1 < len(x_values):
            yield x_index + 1, y_index
        if y_index > 0:
            yield x_index, y_index - 1
        if y_index + 1 < len(y_values):
            yield x_index, y_index + 1

    def _translation_segment_is_clear(
        self,
        target_item: PlacedItem,
        start: Tuple[float, float],
        end: Tuple[float, float],
        obstacles: List[PlacedItem],
    ) -> bool:
        if abs(start[1] - end[1]) <= _GEOMETRY_TOLERANCE_CM:
            swept_x = min(start[0], end[0])
            swept_y = start[1]
            swept_length = abs(end[0] - start[0]) + target_item.length_cm
            swept_width = target_item.width_cm
        elif abs(start[0] - end[0]) <= _GEOMETRY_TOLERANCE_CM:
            swept_x = start[0]
            swept_y = min(start[1], end[1])
            swept_length = target_item.length_cm
            swept_width = abs(end[1] - start[1]) + target_item.width_cm
        else:
            return False

        return not any(
            self.is_overlap(
                swept_x,
                swept_y,
                swept_length,
                swept_width,
                obstacle.x,
                obstacle.y,
                obstacle.length_cm,
                obstacle.width_cm,
            )
            for obstacle in obstacles
        )

    def find_placement_position(
        self,
        item: CargoItem,
        current_placed: List[PlacedItem],
    ) -> Optional[Tuple[float, float, float, float]]:
        """Find the first reachable candidate while preserving the public API.

        Full delivery-aware search is performed by :meth:`validate_plan`, where
        the complete stop sequence is available.
        """
        for candidate in self._candidate_placements(item, current_placed):
            x, y, length, width = candidate
            placed = self._to_placed_item(item, candidate)
            path_clear, _ = self.is_path_to_door_clear(placed, current_placed)
            if path_clear:
                return x, y, length, width
        return None

    def validate_plan(self, stops: List[StopAction]) -> SpatialValidationResult:
        """Search and validate a fixed pickup/delivery sequence step by step."""
        unload_step_by_item = self._build_unload_steps(stops)
        context = _SearchContext(
            max_nodes=self.max_search_nodes,
            max_time_seconds=self.max_time_seconds,
        )
        failed_states: Set[Tuple[int, Tuple[Tuple[object, ...], ...]]] = set()

        solution = self._search_stops(
            stops=stops,
            stop_index=0,
            current_items={},
            unload_step_by_item=unload_step_by_item,
            step_states=[],
            max_weight=0.0,
            max_area=0.0,
            context=context,
            failed_states=failed_states,
        )
        if solution is not None:
            states, max_weight, max_area = solution
            return SpatialValidationResult(
                is_valid=True,
                max_weight_kg=max_weight,
                max_area_cm2=max_area,
                step_states=states,
            )

        if context.limit_reached:
            failure = context.best_failure
            return SpatialValidationResult(
                is_valid=False,
                violation_code="PLACEMENT_SEARCH_LIMIT_REACHED",
                error_message=(
                    "Đã đạt giới hạn tìm kiếm bố trí trước khi xác minh được phương án; "
                    "không kết luận chuyến bất khả thi."
                ),
                max_weight_kg=failure.max_weight_kg if failure else 0.0,
                max_area_cm2=failure.max_area_cm2 if failure else 0.0,
                step_states=failure.step_states if failure else [],
            )

        failure = context.best_failure
        if failure is None:
            return SpatialValidationResult(
                is_valid=False,
                violation_code="NO_FEASIBLE_LAYOUT",
                error_message="Không tìm được bố trí xếp/dỡ hợp lệ cho chuỗi điểm dừng.",
            )
        return SpatialValidationResult(
            is_valid=False,
            violation_code=failure.violation_code,
            violation_scenario=failure.violation_scenario,
            error_message=failure.error_message,
            max_weight_kg=failure.max_weight_kg,
            max_area_cm2=failure.max_area_cm2,
            step_states=failure.step_states,
        )

    def _build_unload_steps(self, stops: List[StopAction]) -> Dict[str, int]:
        unload_steps: Dict[str, int] = {}
        for stop_index, stop in enumerate(stops):
            for item_id in stop.items_to_unload:
                # The first declared unload is the physical deadline. A duplicate
                # unload is later rejected as ITEM_NOT_ON_BOARD during simulation.
                unload_steps.setdefault(item_id, stop_index)
        return unload_steps

    def _search_stops(
        self,
        stops: List[StopAction],
        stop_index: int,
        current_items: Dict[str, PlacedItem],
        unload_step_by_item: Dict[str, int],
        step_states: List[FloorState],
        max_weight: float,
        max_area: float,
        context: _SearchContext,
        failed_states: Set[Tuple[int, Tuple[Tuple[object, ...], ...]]],
    ) -> Optional[Tuple[List[FloorState], float, float]]:
        if not context.consume_node():
            return None
        if stop_index >= len(stops):
            return step_states, max_weight, max_area

        state_key = (stop_index, self._layout_key(current_items.values()))
        if state_key in failed_states:
            return None

        stop = stops[stop_index]
        unload_ids = list(stop.items_to_unload)
        missing_item_id = next(
            (item_id for item_id in unload_ids if item_id not in current_items), None
        )
        if missing_item_id is not None or len(unload_ids) != len(set(unload_ids)):
            invalid_item_id = missing_item_id or next(
                item_id for item_id in unload_ids if unload_ids.count(item_id) > 1
            )
            self._record_failure(
                context,
                stop_index,
                0,
                "ITEM_NOT_ON_BOARD",
                "T21",
                (
                    f"Kiện [{invalid_item_id}] cần dỡ tại Stop {stop.sequence} "
                    f"({stop.address}) nhưng hiện không có trên xe hoặc bị khai báo dỡ lặp."
                ),
                step_states,
                max_weight,
                max_area,
            )
            failed_states.add(state_key)
            return None

        unload_sequence = self._find_unload_sequence(
            current_items, unload_ids, context
        )
        if unload_sequence is None:
            blocked_item_id = unload_ids[0] if unload_ids else "unknown"
            target = current_items.get(blocked_item_id)
            blocker_id: Optional[str] = None
            if target is not None:
                _, blocker_id = self.is_path_to_door_clear(
                    target,
                    [
                        item
                        for item_id, item in current_items.items()
                        if item_id != blocked_item_id
                    ],
                )
            self._record_failure(
                context,
                stop_index,
                0,
                "UNLOAD_PATH_BLOCKED",
                "T24",
                (
                    f"Vi phạm T24/T26: Không thể dỡ các kiện tại Stop {stop.sequence} "
                    f"({stop.address}); kiện [{blocker_id or blocked_item_id}] hoặc mạng "
                    "chướng ngại chắn ngay trên hành lang ra cửa và không có đường vòng 2D."
                ),
                step_states,
                max_weight,
                max_area,
            )
            failed_states.add(state_key)
            return None

        after_unload = dict(current_items)
        for item_id in unload_sequence:
            del after_unload[item_id]

        load_items = sorted(
            stop.items_to_load,
            key=lambda item: (
                -unload_step_by_item.get(item.id, len(stops) + 1),
                -(item.length_cm * item.width_cm),
                -max(item.length_cm, item.width_cm),
                item.id,
            ),
        )

        produced_layout = False
        for loaded_items in self._search_load_placements(
            items=load_items,
            item_index=0,
            current_items=after_unload,
            unload_step_by_item=unload_step_by_item,
            stops_count=len(stops),
            stop=stop,
            stop_index=stop_index,
            prior_step_states=step_states,
            prior_max_weight=max_weight,
            prior_max_area=max_area,
            context=context,
        ):
            produced_layout = True
            current_weight = sum(item.weight_kg for item in loaded_items.values())
            occupied_area = sum(
                item.length_cm * item.width_cm for item in loaded_items.values()
            )
            next_max_weight = max(max_weight, current_weight)
            next_max_area = max(max_area, occupied_area)
            next_states = step_states + [
                FloorState(
                    step_index=stop_index + 1,
                    stop_id=stop.stop_id,
                    stop_type=stop.stop_type,
                    action_description=(
                        f"Stop {stop.sequence} ({stop.stop_type}) - {stop.address}"
                    ),
                    placed_items=sorted(
                        loaded_items.values(), key=lambda item: item.item_id
                    ),
                    current_weight_kg=round(current_weight, 1),
                    current_occupied_area_cm2=round(occupied_area, 1),
                    floor_area_cm2=self.total_floor_area,
                    weight_utilization_percent=round(
                        (current_weight / self.payload_limit) * 100, 1
                    ),
                    area_utilization_percent=round(
                        (occupied_area / self.total_floor_area) * 100, 1
                    ),
                    is_valid=True,
                    package_access_paths=self._build_package_access_paths(
                        loaded_items
                    ),
                )
            ]
            solution = self._search_stops(
                stops=stops,
                stop_index=stop_index + 1,
                current_items=loaded_items,
                unload_step_by_item=unload_step_by_item,
                step_states=next_states,
                max_weight=next_max_weight,
                max_area=next_max_area,
                context=context,
                failed_states=failed_states,
            )
            if solution is not None:
                return solution
            if context.limit_reached:
                return None

        if not produced_layout and not context.limit_reached:
            # A detailed placement failure is normally recorded by the load
            # search. This fallback covers a stop without load candidates.
            if not load_items:
                self._record_failure(
                    context,
                    stop_index,
                    0,
                    "NO_FEASIBLE_LAYOUT",
                    None,
                    "Không tìm được trạng thái mặt sàn hợp lệ sau điểm dừng.",
                    step_states,
                    max_weight,
                    max_area,
                )
        failed_states.add(state_key)
        return None

    def _find_unload_sequence(
        self,
        current_items: Dict[str, PlacedItem],
        unload_ids: List[str],
        context: _SearchContext,
    ) -> Optional[List[str]]:
        """Find an executable order for packages delivered at the same stop."""
        failed_remaining_sets: Set[Tuple[str, ...]] = set()

        def search(
            onboard: Dict[str, PlacedItem],
            remaining: Tuple[str, ...],
        ) -> Optional[List[str]]:
            if not remaining:
                return []
            if not context.consume_node():
                return None
            remaining_key = tuple(sorted(remaining))
            if remaining_key in failed_remaining_sets:
                return None

            candidates = sorted(
                remaining,
                key=lambda item_id: (
                    onboard[item_id].x + onboard[item_id].length_cm,
                    onboard[item_id].y,
                    item_id,
                ),
                reverse=True,
            )
            for item_id in candidates:
                target = onboard[item_id]
                other_items = [
                    item for other_id, item in onboard.items() if other_id != item_id
                ]
                path_clear, _ = self.is_path_to_door_clear(target, other_items)
                if not path_clear:
                    continue
                next_onboard = dict(onboard)
                del next_onboard[item_id]
                suffix = search(
                    next_onboard,
                    tuple(candidate for candidate in remaining if candidate != item_id),
                )
                if suffix is not None:
                    return [item_id] + suffix

            failed_remaining_sets.add(remaining_key)
            return None

        return search(dict(current_items), tuple(unload_ids))

    def _search_load_placements(
        self,
        items: List[CargoItem],
        item_index: int,
        current_items: Dict[str, PlacedItem],
        unload_step_by_item: Dict[str, int],
        stops_count: int,
        stop: StopAction,
        stop_index: int,
        prior_step_states: List[FloorState],
        prior_max_weight: float,
        prior_max_area: float,
        context: _SearchContext,
    ) -> Iterator[Dict[str, PlacedItem]]:
        if item_index >= len(items):
            yield current_items
            return

        item = items[item_index]
        if item.id in current_items:
            self._record_failure(
                context,
                stop_index,
                item_index,
                "DUPLICATE_ITEM_ON_BOARD",
                "T21",
                f"Kiện [{item.id}] đã có trên xe nhưng lại được yêu cầu bốc lần nữa.",
                prior_step_states,
                prior_max_weight,
                prior_max_area,
            )
            return

        unload_step = unload_step_by_item.get(item.id)
        if unload_step is not None and unload_step <= stop_index:
            self._record_failure(
                context,
                stop_index,
                item_index,
                "DELIVERY_BEFORE_PICKUP",
                "T27",
                f"Kiện [{item.id}] được bốc sau hoặc ngay tại bước đã khai báo dỡ.",
                prior_step_states,
                prior_max_weight,
                prior_max_area,
            )
            return

        current_weight = sum(placed.weight_kg for placed in current_items.values())
        if current_weight + item.weight_kg > self.payload_limit:
            self._record_failure(
                context,
                stop_index,
                item_index,
                "PAYLOAD_EXCEEDED",
                "T21",
                (
                    f"Tải trọng tại Stop {stop.sequence} đạt "
                    f"{current_weight + item.weight_kg:.1f} kg, vượt tải trọng cho phép "
                    f"của xe ({self.payload_limit:.1f} kg)."
                ),
                prior_step_states,
                prior_max_weight,
                prior_max_area,
            )
            return

        if item.height_cm > self.floor_height + _GEOMETRY_TOLERANCE_CM:
            self._record_failure(
                context,
                stop_index,
                item_index,
                "ITEM_EXCEEDS_VEHICLE_DIMENSIONS",
                "T21",
                f"Kiện [{item.id}] cao hơn chiều cao lọt lòng của thùng xe.",
                prior_step_states,
                prior_max_weight,
                prior_max_area,
            )
            return

        candidates = self._candidate_placements(item, list(current_items.values()))
        if not candidates:
            self._record_no_candidate_failure(
                item,
                current_items,
                stop_index,
                item_index,
                prior_step_states,
                prior_max_weight,
                prior_max_area,
                context,
            )
            return

        ingress_candidate_found = False
        unload_safe_candidate_found = False
        identical_predecessor_positions = []
        for predecessor in items[:item_index]:
            if (
                predecessor.order_id == item.order_id
                and abs(predecessor.length_cm - item.length_cm)
                <= _GEOMETRY_TOLERANCE_CM
                and abs(predecessor.width_cm - item.width_cm)
                <= _GEOMETRY_TOLERANCE_CM
                and abs(predecessor.height_cm - item.height_cm)
                <= _GEOMETRY_TOLERANCE_CM
                and abs(predecessor.weight_kg - item.weight_kg)
                <= _GEOMETRY_TOLERANCE_CM
                and predecessor.can_rotate == item.can_rotate
                and unload_step_by_item.get(predecessor.id)
                == unload_step_by_item.get(item.id)
                and predecessor.id in current_items
            ):
                placed_predecessor = current_items[predecessor.id]
                identical_predecessor_positions.append(
                    (
                        placed_predecessor.x,
                        placed_predecessor.y,
                        placed_predecessor.length_cm,
                        placed_predecessor.width_cm,
                    )
                )
        minimum_symmetric_position = max(
            identical_predecessor_positions, default=None
        )
        for candidate in candidates:
            if not context.consume_node():
                return
            # Các kiện được bốc cùng đợt, cùng đơn, cùng kích thước/khối lượng và
            # cùng điểm dỡ là đối xứng. Chỉ giữ thứ tự vị trí chuẩn để không thử
            # lại cùng một bố trí chỉ vì hoán đổi ID kiện.
            if (
                minimum_symmetric_position is not None
                and candidate < minimum_symmetric_position
            ):
                continue
            placed_item = self._to_placed_item(item, candidate)
            path_clear, _ = self.is_path_to_door_clear(
                placed_item, list(current_items.values())
            )
            if not path_clear:
                continue
            ingress_candidate_found = True

            next_items = dict(current_items)
            next_items[item.id] = placed_item
            if not self._layout_respects_unload_order(
                next_items.values(), unload_step_by_item, stops_count
            ):
                continue
            unload_safe_candidate_found = True

            yield from self._search_load_placements(
                items=items,
                item_index=item_index + 1,
                current_items=next_items,
                unload_step_by_item=unload_step_by_item,
                stops_count=stops_count,
                stop=stop,
                stop_index=stop_index,
                prior_step_states=prior_step_states,
                prior_max_weight=prior_max_weight,
                prior_max_area=prior_max_area,
                context=context,
            )
            if context.limit_reached:
                return

        if unload_safe_candidate_found:
            return
        if ingress_candidate_found:
            code = "FUTURE_UNLOAD_PATH_BLOCKED"
            scenario = "T24"
            message = (
                f"Vi phạm T24: Không có vị trí cho kiện [{item.id}] mà vẫn giữ được "
                "đường dỡ của các kiện phải giao trước; nếu đặt tại vùng còn lại, "
                "kiện sẽ chắn ngay trên hành lang ra cửa."
            )
        else:
            code = "LOAD_PATH_BLOCKED"
            scenario = "T26"
            message = (
                f"Vi phạm T26: Có vùng sàn cho kiện [{item.id}] nhưng đường đưa kiện "
                "từ cửa sau đến các vị trí đó đều bị chắn."
            )
        self._record_failure(
            context,
            stop_index,
            item_index,
            code,
            scenario,
            message,
            prior_step_states,
            prior_max_weight,
            prior_max_area,
        )

    def _candidate_placements(
        self,
        item: CargoItem,
        current_placed: List[PlacedItem],
    ) -> List[Tuple[float, float, float, float]]:
        orientations = [(item.length_cm, item.width_cm)]
        if item.can_rotate and abs(item.length_cm - item.width_cm) > _GEOMETRY_TOLERANCE_CM:
            orientations.append((item.width_cm, item.length_cm))

        candidates: List[Tuple[Tuple[float, ...], Tuple[float, float, float, float]]] = []
        seen: Set[Tuple[float, float, float, float]] = set()
        current_max_x = max(
            (placed.x + placed.length_cm for placed in current_placed), default=0.0
        )

        for orientation_index, (length, width) in enumerate(orientations):
            if (
                length > self.floor_length + _GEOMETRY_TOLERANCE_CM
                or width > self.floor_width + _GEOMETRY_TOLERANCE_CM
            ):
                continue

            x_values = {0.0, self.floor_length - length}
            y_values = {0.0, self.floor_width - width}
            for placed in current_placed:
                x_values.update(
                    {
                        placed.x,
                        placed.x + placed.length_cm,
                        placed.x - length,
                        placed.x + placed.length_cm - length,
                    }
                )
                y_values.update(
                    {
                        placed.y,
                        placed.y + placed.width_cm,
                        placed.y - width,
                        placed.y + placed.width_cm - width,
                    }
                )

            for raw_x in x_values:
                x = self._normalize_coordinate(raw_x)
                if x < 0 or x + length > self.floor_length + _GEOMETRY_TOLERANCE_CM:
                    continue
                for raw_y in y_values:
                    y = self._normalize_coordinate(raw_y)
                    if y < 0 or y + width > self.floor_width + _GEOMETRY_TOLERANCE_CM:
                        continue
                    if any(
                        self.is_overlap(
                            x,
                            y,
                            length,
                            width,
                            other.x,
                            other.y,
                            other.length_cm,
                            other.width_cm,
                        )
                        for other in current_placed
                    ):
                        continue
                    candidate = (x, y, length, width)
                    key = tuple(round(value, 6) for value in candidate)
                    if key in seen:
                        continue
                    seen.add(key)
                    bounding_x = max(current_max_x, x + length)
                    score = (bounding_x, x, y, float(orientation_index))
                    candidates.append((score, candidate))

        candidates.sort(key=lambda entry: entry[0])
        return [candidate for _, candidate in candidates]

    def _layout_respects_unload_order(
        self,
        placed_items: Iterator[PlacedItem],
        unload_step_by_item: Dict[str, int],
        stops_count: int,
    ) -> bool:
        items = list(placed_items)
        default_unload_step = stops_count + 1
        for target in items:
            target_step = unload_step_by_item.get(target.item_id, default_unload_step)
            later_items = [
                blocker
                for blocker in items
                if blocker.item_id != target.item_id
                and unload_step_by_item.get(blocker.item_id, default_unload_step)
                > target_step
            ]
            path_clear, _ = self.is_path_to_door_clear(target, later_items)
            if not path_clear:
                return False
        return True

    def _build_package_access_paths(
        self,
        current_items: Dict[str, PlacedItem],
    ) -> List[PackageAccessPath]:
        access_paths: List[PackageAccessPath] = []
        for item_id in sorted(current_items):
            target = current_items[item_id]
            obstacles = [
                item
                for other_id, item in current_items.items()
                if other_id != item_id
            ]
            path = self._find_translation_path_to_door(target, obstacles)
            direct_blockers = [
                obstacle.item_id
                for obstacle in obstacles
                if self._blocks_straight_path(target, obstacle)
            ]
            access_paths.append(
                PackageAccessPath(
                    item_id=item_id,
                    is_clear=path is not None,
                    points=(
                        [MovementPoint(x=x, y=y) for x, y in path]
                        if path is not None
                        else []
                    ),
                    blocker_item_ids=direct_blockers if path is None else [],
                )
            )
        return access_paths

    def _blocks_straight_path(
        self,
        target_item: PlacedItem,
        obstacle: PlacedItem,
    ) -> bool:
        path_x_start = target_item.x + target_item.length_cm
        path_length = self.floor_length - path_x_start
        return path_length > _GEOMETRY_TOLERANCE_CM and self.is_overlap(
            path_x_start,
            target_item.y,
            path_length,
            target_item.width_cm,
            obstacle.x,
            obstacle.y,
            obstacle.length_cm,
            obstacle.width_cm,
        )

    def _record_no_candidate_failure(
        self,
        item: CargoItem,
        current_items: Dict[str, PlacedItem],
        stop_index: int,
        item_index: int,
        step_states: List[FloorState],
        max_weight: float,
        max_area: float,
        context: _SearchContext,
    ) -> None:
        occupied_area = sum(
            placed.length_cm * placed.width_cm for placed in current_items.values()
        )
        free_area = self.total_floor_area - occupied_area
        item_area = item.length_cm * item.width_cm
        if item_area > free_area + _GEOMETRY_TOLERANCE_CM:
            code = "STACKING_FORBIDDEN"
            scenario = "T22"
            message = (
                f"Vi phạm T22: Diện tích sàn còn lại không đủ cho kiện [{item.id}]; "
                "kiện chỉ có thể vừa nếu xếp chồng (CẤM XẾP CHỒNG)."
            )
        elif not self._has_dimensionally_valid_orientation(item):
            code = "ITEM_EXCEEDS_VEHICLE_DIMENSIONS"
            scenario = "T21"
            message = f"Kiện [{item.id}] không vừa kích thước lọt lòng của thùng xe."
        else:
            code = "DISCONNECTED_FREE_SPACE"
            scenario = "T25"
            message = (
                f"Vi phạm T25: Tổng diện tích sàn còn trống ({free_area / 10000:.2f} m²) "
                f"đủ cho kiện [{item.id}] ({item_area / 10000:.2f} m²), nhưng không có "
                "một vùng trống liên tục phù hợp do không gian bị chia cắt rời rạc; "
                "không được ghép giả các vùng trống."
            )
        self._record_failure(
            context,
            stop_index,
            item_index,
            code,
            scenario,
            message,
            step_states,
            max_weight,
            max_area,
        )

    def _record_failure(
        self,
        context: _SearchContext,
        stop_index: int,
        item_index: int,
        violation_code: str,
        violation_scenario: Optional[str],
        error_message: str,
        step_states: List[FloorState],
        max_weight: float,
        max_area: float,
    ) -> None:
        context.record_failure(
            _SearchFailure(
                depth=(stop_index, item_index),
                violation_code=violation_code,
                violation_scenario=violation_scenario,
                error_message=error_message,
                max_weight_kg=max_weight,
                max_area_cm2=max_area,
                step_states=step_states,
            )
        )

    def _to_placed_item(
        self,
        item: CargoItem,
        candidate: Tuple[float, float, float, float],
    ) -> PlacedItem:
        x, y, length, width = candidate
        return PlacedItem(
            item_id=item.id,
            order_id=item.order_id,
            x=x,
            y=y,
            length_cm=length,
            width_cm=width,
            height_cm=item.height_cm,
            weight_kg=item.weight_kg,
        )

    def _layout_key(
        self, placed_items: Iterable[PlacedItem]
    ) -> Tuple[Tuple[object, ...], ...]:
        return tuple(
            sorted(
                (
                    item.item_id,
                    round(item.x, 6),
                    round(item.y, 6),
                    round(item.length_cm, 6),
                    round(item.width_cm, 6),
                )
                for item in placed_items
            )
        )

    def _normalize_coordinate(self, value: float) -> float:
        if abs(value) <= _GEOMETRY_TOLERANCE_CM:
            return 0.0
        return value

    def _has_dimensionally_valid_orientation(self, item: CargoItem) -> bool:
        fits_declared_orientation = (
            item.length_cm <= self.floor_length + _GEOMETRY_TOLERANCE_CM
            and item.width_cm <= self.floor_width + _GEOMETRY_TOLERANCE_CM
        )
        fits_rotated_orientation = (
            item.can_rotate
            and item.width_cm <= self.floor_length + _GEOMETRY_TOLERANCE_CM
            and item.length_cm <= self.floor_width + _GEOMETRY_TOLERANCE_CM
        )
        return fits_declared_orientation or fits_rotated_orientation
