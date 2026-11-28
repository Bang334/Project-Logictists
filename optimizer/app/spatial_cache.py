"""Scoped, lossless LRU cache for spatial 3D/2D validation within a solver run."""

from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterator, Optional, Sequence, Set, Tuple

from .models import DemoStackingPolicy, SpatialValidationResult, StopAction


_SEARCH_LIMIT_CODES = frozenset({"PLACEMENT_SEARCH_LIMIT_REACHED"})
_DEFAULT_MAX_SEARCH_NODES = 20_000


def split_independent_stop_cycles(stops: Sequence[StopAction]) -> list[list[StopAction]]:
    """Split stops only at proven empty-vehicle boundaries.

    Routes with contract errors (unloading an item not on board, duplicate unload,
    or duplicate load while on board) stay unsplit so validation reports the
    exact contract violation.
    """
    stop_list = list(stops)
    if not stop_list:
        return [stop_list]

    onboard_ids: Set[str] = set()
    cycle_start = 0
    cycles: list[list[StopAction]] = []
    for stop_index, stop in enumerate(stop_list):
        unload_ids = list(stop.items_to_unload)
        if (
            len(unload_ids) != len(set(unload_ids))
            or any(item_id not in onboard_ids for item_id in unload_ids)
        ):
            return [stop_list]
        onboard_ids.difference_update(unload_ids)

        load_ids = [item.id for item in stop.items_to_load]
        if (
            len(load_ids) != len(set(load_ids))
            or any(item_id in onboard_ids for item_id in load_ids)
        ):
            return [stop_list]
        onboard_ids.update(load_ids)

        if not onboard_ids and stop_index + 1 < len(stop_list):
            cycles.append(stop_list[cycle_start : stop_index + 1])
            cycle_start = stop_index + 1

    cycles.append(stop_list[cycle_start:])
    return cycles


@dataclass(frozen=True)
class _CacheEntry:
    result: SpatialValidationResult
    max_search_nodes: int
    max_time_seconds: float
    stop_metadata: Optional[Tuple[Tuple[str, int, str], ...]] = None


class SpatialValidationCache:
    """In-run LRU cache keyed by exact vehicle geometry, stacking policy, and StopActions."""

    def __init__(self, max_entries: int = 2048) -> None:
        self.max_entries = max(1, int(max_entries))
        self._entries: OrderedDict[Tuple[Any, ...], _CacheEntry] = OrderedDict()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def build_key(
        policy: Optional[DemoStackingPolicy],
        vehicle: Any,
        actions: Sequence[StopAction],
    ) -> Tuple[Any, ...]:
        policy_key = (
            (
                int(policy.max_tiers),
                float(policy.lift_clearance_cm),
                policy.owner_mode,
                int(policy.max_top_load_percent),
                bool(getattr(policy, "enforce_weight_balance", False)),
                getattr(policy, "max_lateral_imbalance_percent", None),
                getattr(policy, "max_longitudinal_imbalance_percent", None),
            )
            if policy is not None
            else None
        )
        door_w = getattr(vehicle, "door_width_cm", None)
        floor_key = (
            float(vehicle.length_cm),
            float(vehicle.width_cm),
            float(vehicle.height_cm),
            float(vehicle.payload_limit_kg),
            getattr(vehicle, "door_position", "REAR"),
            float(door_w) if door_w is not None else None,
        )
        actions_key = tuple(
            (
                stop.stop_type,
                tuple(
                    (
                        item.id,
                        item.order_id,
                        item.customer_id,
                        float(item.length_cm),
                        float(item.width_cm),
                        float(item.height_cm),
                        float(item.weight_kg),
                        bool(item.can_rotate),
                        tuple(item.allowed_orientations) if item.allowed_orientations is not None else None,
                        item.cargo_kind,
                        bool(item.allow_upper_tier),
                        bool(item.no_top_load_requested),
                        item.max_top_load_g,
                    )
                    for item in stop.items_to_load
                ),
                tuple(stop.items_to_unload),
            )
            for stop in actions
        )
        return (policy_key, floor_key, actions_key)

    @staticmethod
    def _stop_metadata(actions: Sequence[StopAction]) -> Tuple[Tuple[str, int, str], ...]:
        return tuple((stop.stop_id, int(stop.sequence), stop.address) for stop in actions)

    def get(
        self,
        key: Tuple[Any, ...],
        actions: Sequence[StopAction],
        *,
        max_search_nodes: Optional[int],
        max_time_seconds: Optional[float],
    ) -> Optional[SpatialValidationResult]:
        entry = self._entries.get(key)
        if entry is None:
            self.misses += 1
            return None

        req_nodes = _DEFAULT_MAX_SEARCH_NODES if max_search_nodes is None else int(max_search_nodes)
        req_time = 6.0 if max_time_seconds is None else float(max_time_seconds)
        if not entry.result.is_valid:
            # Never reuse a search-limit/timeout failure, tighter-bound failure, or
            # error metadata built for different stop numbers/addresses.
            if entry.result.violation_code in _SEARCH_LIMIT_CODES:
                self.misses += 1
                return None
            if entry.max_search_nodes < req_nodes or entry.max_time_seconds + 1e-6 < req_time:
                self.misses += 1
                return None
            if (
                entry.stop_metadata is not None
                and entry.stop_metadata != self._stop_metadata(actions)
            ):
                self.misses += 1
                return None

        self._entries.move_to_end(key)
        self.hits += 1
        cloned = entry.result.model_copy(deep=True)
        for state, stop in zip(cloned.step_states, actions):
            state.stop_id = stop.stop_id
            state.action_description = f"Stop {stop.sequence} ({stop.stop_type}) - {stop.address}"
        return cloned

    def put(
        self,
        key: Tuple[Any, ...],
        result: SpatialValidationResult,
        *,
        max_search_nodes: Optional[int],
        max_time_seconds: Optional[float],
        actions: Optional[Sequence[StopAction]] = None,
    ) -> None:
        if not result.is_valid and result.violation_code in _SEARCH_LIMIT_CODES:
            return
        req_nodes = _DEFAULT_MAX_SEARCH_NODES if max_search_nodes is None else int(max_search_nodes)
        req_time = 6.0 if max_time_seconds is None else float(max_time_seconds)
        self._entries[key] = _CacheEntry(
            result=result.model_copy(deep=True),
            max_search_nodes=req_nodes,
            max_time_seconds=req_time,
            stop_metadata=(
                None
                if result.is_valid or actions is None
                else self._stop_metadata(actions)
            ),
        )
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)


_ACTIVE_SPATIAL_CACHE: ContextVar[Optional[SpatialValidationCache]] = ContextVar(
    "_ACTIVE_SPATIAL_CACHE",
    default=None,
)


def get_active_spatial_cache() -> Optional[SpatialValidationCache]:
    """Return the active solve-scoped spatial cache, if any."""
    return _ACTIVE_SPATIAL_CACHE.get()


@contextmanager
def scoped_spatial_cache(max_entries: int = 2048) -> Iterator[SpatialValidationCache]:
    """Activate a fresh solve-scoped cache if an outer scope is not already open."""
    existing = _ACTIVE_SPATIAL_CACHE.get()
    if existing is not None:
        yield existing
        return
    cache = SpatialValidationCache(max_entries=max_entries)
    token = _ACTIVE_SPATIAL_CACHE.set(cache)
    try:
        yield cache
    finally:
        _ACTIVE_SPATIAL_CACHE.reset(token)
