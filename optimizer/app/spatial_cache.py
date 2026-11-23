"""Scoped, lossless LRU cache for spatial 3D/2D validation within a solver run."""

from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterator, Optional, Sequence, Tuple

from .models import DemoStackingPolicy, SpatialValidationResult, StopAction


_SEARCH_LIMIT_CODES = frozenset({"PLACEMENT_SEARCH_LIMIT_REACHED"})
_DEFAULT_MAX_SEARCH_NODES = 20_000


@dataclass(frozen=True)
class _CacheEntry:
    result: SpatialValidationResult
    max_search_nodes: int
    max_time_seconds: float


class SpatialValidationCache:
    """In-run LRU cache keyed by exact vehicle geometry, stacking policy, and StopActions."""

    def __init__(self, max_entries: int = 512) -> None:
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
                round(float(policy.lift_clearance_cm), 4),
                policy.owner_mode,
                int(policy.max_top_load_percent),
            )
            if policy is not None
            else None
        )
        door_w = getattr(vehicle, "door_width_cm", None)
        floor_key = (
            round(float(vehicle.length_cm), 4),
            round(float(vehicle.width_cm), 4),
            round(float(vehicle.height_cm), 4),
            round(float(vehicle.payload_limit_kg), 4),
            getattr(vehicle, "door_position", "REAR"),
            round(float(door_w), 4) if door_w is not None else None,
        )
        actions_key = tuple(
            (
                stop.stop_type,
                tuple(
                    (
                        item.id,
                        item.order_id,
                        item.customer_id,
                        round(float(item.length_cm), 4),
                        round(float(item.width_cm), 4),
                        round(float(item.height_cm), 4),
                        round(float(item.weight_kg), 4),
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
            # Never reuse a search-limit/timeout failure, or an infeasible check run under tighter bounds.
            if entry.result.violation_code in _SEARCH_LIMIT_CODES:
                self.misses += 1
                return None
            if entry.max_search_nodes < req_nodes or entry.max_time_seconds + 1e-6 < req_time:
                self.misses += 1
                return None

        self._entries.move_to_end(key)
        self.hits += 1
        cloned = entry.result.model_copy(deep=True)
        if len(cloned.step_states) == len(actions):
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
    ) -> None:
        if not result.is_valid and result.violation_code in _SEARCH_LIMIT_CODES:
            return
        req_nodes = _DEFAULT_MAX_SEARCH_NODES if max_search_nodes is None else int(max_search_nodes)
        req_time = 6.0 if max_time_seconds is None else float(max_time_seconds)
        self._entries[key] = _CacheEntry(
            result=result.model_copy(deep=True),
            max_search_nodes=req_nodes,
            max_time_seconds=req_time,
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
def scoped_spatial_cache(max_entries: int = 512) -> Iterator[SpatialValidationCache]:
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
