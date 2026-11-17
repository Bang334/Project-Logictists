"""Reuse certified load cycles across overlapping route candidates."""

from time import perf_counter
from typing import Optional
from unittest.mock import patch

from app import spatial_validator
from app.models import CargoItem, PlacedItem, SpatialValidationResult, StopAction, VehicleFloor
from app.spatial_validator import (
    SpatialValidator, _DEFAULT_MAX_SEARCH_NODES, _GEOMETRY_TOLERANCE_CM,
)
from benchmarks.savings_warm_start.uniform_load_cycle import try_uniform_load_cycle


class _CycleDeadlineElapsed(Exception):
    pass


class CycleCachingSpatialValidator(SpatialValidator):
    """Keep successful layouts for the same cargo and empty-vehicle interval."""

    def __init__(
        self,
        vehicle: VehicleFloor,
        max_search_nodes: int = _DEFAULT_MAX_SEARCH_NODES,
        max_time_seconds: float = 6.0,
        *,
        use_uniform_layout: bool = False,
    ) -> None:
        super().__init__(vehicle, max_search_nodes, max_time_seconds)
        self._use_uniform_layout = use_uniform_layout
        self._cycle_deadline: float | None = None
        self._norm_calls = 0
        self._certified_cycles: dict[tuple[str, ...], SpatialValidationResult] = {}
        self.cache_hits = 0
        self.exact_searches = 0
        self.exact_search_seconds = 0.0
        self.uniform_certificates = 0

    def _normalize_coordinate(self, value: float) -> float:
        self._norm_calls += 1
        if (self._norm_calls & 31) == 0:
            self._check_cycle_deadline()
        return super()._normalize_coordinate(value)

    def _candidate_placements(
        self,
        item: CargoItem,
        current_placed: list[PlacedItem],
        unload_step: Optional[int] = None,
        max_unload_step: Optional[int] = None,
        allow_door_placement: bool = False,
        cargo_kind_by_id: Optional[dict[str, str]] = None,
        has_remaining_cargo: bool = True,
    ) -> list[tuple[float, float, float, float]]:
        self._check_cycle_deadline()
        args = (
            item, current_placed, unload_step, max_unload_step,
            allow_door_placement, cargo_kind_by_id, has_remaining_cargo,
        )
        if item.cargo_kind == "FRAGILE" or "FRAGILE" in (cargo_kind_by_id or {}).values():
            result = super()._candidate_placements(*args)
            self._check_cycle_deadline()
            return result

        total_weight = 0.0
        moment = 0.0
        for placed in current_placed:
            weight = float(placed.weight_kg or 0.0)
            if weight > 0:
                total_weight += weight
                moment += weight * (placed.y + placed.width_cm / 2.0)
        candidate_weight = max(0.0, float(item.weight_kg or 0.0))
        total_weight += candidate_weight
        half_width = self.floor_width / 2.0 if self.floor_width > 0 else 1.0

        def score(*, cand_y: float, cand_w: float, **_kwargs) -> tuple[float, float]:
            self._check_cycle_deadline()
            center = (
                (moment + candidate_weight * (cand_y + cand_w / 2.0)) / total_weight
                if total_weight > 1e-6 else half_width
            )
            return round(abs(center - half_width) / half_width, 4), 0.0

        with patch.object(spatial_validator, "score_candidate_balance_and_fragility", score):
            result = super()._candidate_placements(*args)
        self._check_cycle_deadline()
        return result

    def _check_cycle_deadline(self) -> None:
        if self._cycle_deadline is not None and perf_counter() >= self._cycle_deadline:
            raise _CycleDeadlineElapsed

    def _first_straight_path_blocker(
        self, target_item: PlacedItem, obstacles: list[PlacedItem],
    ) -> Optional[PlacedItem]:
        path_x = target_item.x + target_item.length_cm
        path_length = self.floor_length - path_x
        if not path_length > _GEOMETRY_TOLERANCE_CM:
            return None
        path_y = target_item.y
        path_width = target_item.width_cm
        for obstacle in obstacles:
            if self.is_overlap(
                path_x, path_y, path_length, path_width,
                obstacle.x, obstacle.y, obstacle.length_cm, obstacle.width_cm,
            ):
                return obstacle
        return None

    def _validate_load_cycle(
        self,
        stops: list[StopAction],
        *,
        max_time_seconds: Optional[float] = None,
    ) -> SpatialValidationResult:
        # Normalize route sequence while retaining all cargo and stop fields.
        key = tuple(
            stop.model_copy(update={"sequence": index}).model_dump_json()
            for index, stop in enumerate(stops, start=1)
        )
        cached = self._certified_cycles.get(key)
        if cached is not None:
            self.cache_hits += 1
            result = cached.model_copy(deep=True)
            for state in result.step_states:
                stop = stops[state.step_index - 1]
                state.action_description = f"Stop {stop.sequence} ({stop.stop_type}) - {stop.address}"
            return result
        result = None
        budget = self.max_time_seconds if max_time_seconds is None else max_time_seconds
        deadline = perf_counter() + budget
        if self._use_uniform_layout:
            result = try_uniform_load_cycle(self, stops, deadline=deadline)
        if result is None:
            self.exact_searches += 1
            started = perf_counter()
            self._cycle_deadline = deadline
            try:
                result = super()._validate_load_cycle(
                    stops, max_time_seconds=max(0.0, deadline - started),
                )
            except _CycleDeadlineElapsed:
                result = SpatialValidationResult(
                    is_valid=False,
                    violation_code="PLACEMENT_SEARCH_LIMIT_REACHED",
                    error_message="Hết ngân sách kiểm chứng bố trí.",
                )
            finally:
                self._cycle_deadline = None
                self.exact_search_seconds += perf_counter() - started
        else:
            self.uniform_certificates += 1
        if result.is_valid:
            if len(self._certified_cycles) >= 32:
                del self._certified_cycles[next(iter(self._certified_cycles))]
            self._certified_cycles[key] = result.model_copy(deep=True)
        return result
