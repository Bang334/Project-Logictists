"""Unequal-footprint 3D tree stacking support for DemoStacks.

Allows smaller upper-tier cargo items to sit anywhere completely inside the top
deck of larger supporting items, with multiple upper items sharing one support
package up to policy tier, height/clearance, customer-ownership, and cumulative
subtree weight/top-load limits, while enforcing strict 3D non-overlap and
rear-door handling corridors.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

from .models import (
    CargoItem,
    DemoStackingPolicy,
    FloorState,
    MovementPoint,
    PackageAccessPath,
    PlacedItem,
    SpatialValidationResult,
    StopAction,
    VehicleFloor,
)
from .packing_rules import (
    build_floor_balance_context,
    build_weight_balance_metrics,
    exceeds_top_load_limit,
    is_floor_rotation_locked,
    resolve_can_rotate,
    score_candidate_balance_and_fragility,
    score_candidate_balance_and_fragility_ctx,
)
from .spatial_validator import SpatialValidator

_EPS = 0.01
_MAX_BRANCH_CANDIDATES_PER_ITEM = 20
_MAX_DECK_POINTS_PER_BASE = 8
_MAX_LAYOUTS_PER_STOP = 24


def _same_customer(layer: Any, item: Any) -> bool:
    if layer.order_id == item.order_id:
        return True
    layer_customer = getattr(layer, "customer_id", None)
    item_customer = getattr(item, "customer_id", None)
    return bool(layer_customer) and layer_customer == item_customer


def _boxes_overlap_2d(
    x1: float, y1: float, l1: float, w1: float,
    x2: float, y2: float, l2: float, w2: float,
) -> bool:
    return not (
        x1 + l1 <= x2 + _EPS
        or x2 + l2 <= x1 + _EPS
        or y1 + w1 <= y2 + _EPS
        or y2 + w2 <= y1 + _EPS
    )


def _boxes_overlap_3d(
    x1: float, y1: float, z1: float, l1: float, w1: float, h1: float,
    x2: float, y2: float, z2: float, l2: float, w2: float, h2: float,
) -> bool:
    if not _boxes_overlap_2d(x1, y1, l1, w1, x2, y2, l2, w2):
        return False
    return not (z1 + h1 <= z2 + _EPS or z2 + h2 <= z1 + _EPS)


def _col_corridor_clear(
    x: float, y: float, l_dim: float, w_dim: float,
    bed_l: float, obstacles: Sequence[Tuple[float, float, float, float]],
) -> bool:
    path_x = x + l_dim
    path_len = bed_l - path_x
    if path_len <= _EPS:
        return True
    return not any(
        _boxes_overlap_2d(path_x, y, path_len, w_dim, ox, oy, ol, ow)
        for ox, oy, ol, ow in obstacles
    )


def _permitted_orientations(item: Any, vehicle: Any) -> List[Tuple[float, float]]:
    door_w = getattr(vehicle, "door_width_cm", None)
    bed_l = float(vehicle.length_cm)
    bed_w = float(vehicle.width_cm)
    l0 = float(item.length_cm)
    w0 = float(item.width_cm)
    candidates = [(l0, w0)]
    if resolve_can_rotate(item) and abs(l0 - w0) > _EPS:
        candidates.append((w0, l0))
    valid: List[Tuple[float, float]] = []
    for l_dim, w_dim in candidates:
        if l_dim > bed_l + _EPS or w_dim > bed_w + _EPS:
            continue
        if door_w is not None and w_dim > float(door_w) + _EPS:
            continue
        valid.append((l_dim, w_dim))
    return valid


def _snap_inside_span(val: float, low: float, high: float) -> Optional[float]:
    if high < low - _EPS:
        return None
    clamped = min(max(val, low), max(low, high))
    # Snap to 0.1 mm precision inside [low, high] to match backend mm rounding cleanly.
    snapped = round(clamped, 2)
    if snapped < low:
        snapped = round(low + 0.005, 2) if round(low + 0.005, 2) <= high + 1e-6 else low
    if snapped > high:
        snapped = round(high - 0.005, 2) if round(high - 0.005, 2) >= low - 1e-6 else high
    return snapped


def _collect_intervals(stops: Sequence[Any]) -> Optional[Tuple[Dict[str, int], Dict[str, int], Dict[str, Any]]]:
    pickups: Dict[str, int] = {}
    deliveries: Dict[str, int] = {}
    items_by_id: Dict[str, Any] = {}
    for idx, stop in enumerate(stops):
        loads = getattr(stop, "items_to_load", None)
        if loads is not None:
            for item in loads:
                if item.id in pickups:
                    return None
                pickups[item.id] = idx
                items_by_id[item.id] = item
            for iid in getattr(stop, "items_to_unload", ()):
                if iid in deliveries:
                    return None
                deliveries[iid] = idx
        else:
            for iid in getattr(stop, "items_loaded", ()):
                if iid in pickups:
                    return None
                pickups[iid] = idx
            for iid in getattr(stop, "items_unloaded", ()):
                if iid in deliveries:
                    return None
                deliveries[iid] = idx
    if pickups.keys() != deliveries.keys():
        return None
    for iid, p_idx in pickups.items():
        if deliveries[iid] <= p_idx:
            return None
    return pickups, deliveries, items_by_id


def has_unequal_stack_potential(
    policy: Optional[DemoStackingPolicy],
    vehicle: Any,
    stops: Sequence[StopAction],
) -> bool:
    """Return True when at least one upper item can potentially sit inside a larger support item."""
    if policy is None or policy.max_tiers < 2:
        return False
    parsed = _collect_intervals(stops)
    if parsed is None:
        return False
    pickups, deliveries, items_by_id = parsed
    if len(items_by_id) < 2:
        return False
    bed_h = float(vehicle.height_cm)
    all_items = list(items_by_id.values())
    orients_by_id = {it.id: _permitted_orientations(it, vehicle) for it in all_items}

    for upper in all_items:
        if not bool(getattr(upper, "allow_upper_tier", False)) or getattr(upper, "cargo_kind", "UNCLASSIFIED") != "STANDARD":
            continue
        u_orients = orients_by_id[upper.id]
        if not u_orients:
            continue
        u_pair = tuple(sorted((round(float(upper.length_cm), 2), round(float(upper.width_cm), 2))))
        u_weight = Decimal(str(upper.weight_kg))
        u_p, u_d = pickups[upper.id], deliveries[upper.id]

        for base in all_items:
            if base.id == upper.id:
                continue
            if (
                getattr(base, "cargo_kind", "UNCLASSIFIED") != "STANDARD"
                or bool(getattr(base, "no_top_load_requested", False))
                or (policy.owner_mode == "SAME_CUSTOMER" and not _same_customer(base, upper))
                or pickups[base.id] > u_p
                or deliveries[base.id] < u_d
            ):
                continue
            b_pair = tuple(sorted((round(float(base.length_cm), 2), round(float(base.width_cm), 2))))
            if abs(u_pair[0] - b_pair[0]) <= _EPS and abs(u_pair[1] - b_pair[1]) <= _EPS:
                continue
            if exceeds_top_load_limit(
                u_weight,
                base.weight_kg,
                getattr(base, "max_top_load_g", None),
                getattr(policy, "max_top_load_percent", 30),
            ):
                continue
            if float(base.height_cm) + float(upper.height_cm) + policy.lift_clearance_cm > bed_h + _EPS:
                continue
            b_orients = orients_by_id[base.id]
            if any(ul <= bl + _EPS and uw <= bw + _EPS for ul, uw in u_orients for bl, bw in b_orients):
                return True
    return False


@dataclass(frozen=True)
class _PlacedNode:
    placed: PlacedItem
    item: CargoItem
    tier: int
    ancestors: Tuple[str, ...]


@dataclass
class _SearchBudget:
    max_nodes: int
    max_time_seconds: float
    start_time: float = field(default_factory=time.monotonic)
    visited: int = 0
    limit_reached: bool = False
    branch_cap_reached: bool = False

    def has_time(self) -> bool:
        if self.limit_reached:
            return False
        if time.monotonic() - self.start_time >= self.max_time_seconds:
            self.limit_reached = True
            return False
        return True

    def consume(self) -> bool:
        if self.limit_reached or self.visited >= self.max_nodes:
            self.limit_reached = True
            return False
        if self.visited & 7 == 0 and not self.has_time():
            return False
        self.visited += 1
        return True


def _ancestors_can_support(
    base_node: _PlacedNode,
    item: CargoItem,
    onboard: Mapping[str, _PlacedNode],
    above_weight: Mapping[str, Decimal],
    unload_step: Mapping[str, int],
    policy: DemoStackingPolicy,
    bed_h: float,
) -> bool:
    if not item.allow_upper_tier or item.cargo_kind != "STANDARD":
        return False
    if base_node.tier + 1 > policy.max_tiers:
        return False
    u_z = base_node.placed.z + base_node.placed.height_cm
    if u_z + item.height_cm + policy.lift_clearance_cm > bed_h + _EPS:
        return False
    item_deliv = unload_step.get(item.id, 999_999)
    base_deliv = unload_step.get(base_node.placed.item_id, 999_999)
    if item_deliv > base_deliv:
        return False

    item_w = Decimal(str(item.weight_kg))
    for anc_id in (base_node.placed.item_id, *base_node.ancestors):
        anc_node = onboard[anc_id]
        anc_item = anc_node.item
        if (
            anc_item.cargo_kind != "STANDARD"
            or anc_item.no_top_load_requested
            or (policy.owner_mode == "SAME_CUSTOMER" and not _same_customer(anc_item, item))
        ):
            return False
        new_above = above_weight.get(anc_id, Decimal("0")) + item_w
        if exceeds_top_load_limit(
            new_above,
            anc_item.weight_kg,
            anc_item.max_top_load_g,
            getattr(policy, "max_top_load_percent", 30),
        ):
            return False
    return True


def _deck_candidates_on_base(
    item: CargoItem,
    base_node: _PlacedNode,
    onboard: Mapping[str, _PlacedNode],
    vehicle: VehicleFloor,
    prefer_door: bool,
    has_time: Optional[Callable[[], bool]] = None,
) -> List[Tuple[float, float, float, float, float]]:
    base_p = base_node.placed
    u_z = round(base_p.z + base_p.height_cm, 4)
    u_h = float(item.height_cm)
    orients = _permitted_orientations(item, vehicle)
    if not orients:
        return []

    z_conflicts = [
        node.placed
        for node in onboard.values()
        if not (node.placed.z + node.placed.height_cm <= u_z + _EPS or u_z + u_h <= node.placed.z + _EPS)
    ]

    scored: List[Tuple[Tuple[float, ...], Tuple[float, float, float, float, float]]] = []
    seen: Set[Tuple[float, float, float, float, float]] = set()
    kept_per_orient: Dict[int, int] = {}

    for o_idx, (l_dim, w_dim) in enumerate(orients):
        if l_dim > base_p.length_cm + _EPS or w_dim > base_p.width_cm + _EPS:
            continue
        min_x = base_p.x
        max_x = base_p.x + base_p.length_cm - l_dim
        min_y = base_p.y
        max_y = base_p.y + base_p.width_cm - w_dim

        x_raw = [min_x, max_x]
        y_raw = [min_y, max_y, (min_y + max_y) / 2.0]
        for occ in z_conflicts:
            if not _boxes_overlap_2d(base_p.x, base_p.y, base_p.length_cm, base_p.width_cm, occ.x, occ.y, occ.length_cm, occ.width_cm):
                continue
            x_raw.extend((occ.x + occ.length_cm, occ.x - l_dim))
            y_raw.extend((occ.y + occ.width_cm, occ.y - w_dim))

        x_vals: List[float] = []
        for rx in x_raw:
            sx = _snap_inside_span(rx, min_x, max_x)
            if sx is not None and sx not in x_vals:
                x_vals.append(sx)
        y_vals: List[float] = []
        for ry in y_raw:
            sy = _snap_inside_span(ry, min_y, max_y)
            if sy is not None and sy not in y_vals:
                y_vals.append(sy)

        for x in x_vals:
            for y in y_vals:
                if has_time is not None and not has_time():
                    return []
                if any(_boxes_overlap_2d(x, y, l_dim, w_dim, occ.x, occ.y, occ.length_cm, occ.width_cm) for occ in z_conflicts):
                    continue
                cand = (x, y, u_z, l_dim, w_dim)
                if cand in seen:
                    continue
                seen.add(cand)
                wall_gap = min(abs(y - min_y), abs(max_y - y))
                edge_gap = abs(max_x - x) if prefer_door else abs(x - min_x)
                score = (edge_gap, wall_gap, x, y, float(o_idx))
                scored.append((score, cand))

    scored.sort(key=lambda pair: pair[0])
    chosen: List[Tuple[float, float, float, float, float]] = []
    # Keep diversity across orientations when multiple orientations fit.
    for _, cand in scored:
        o_key = 0 if abs(cand[3] - item.length_cm) <= _EPS else 1
        if kept_per_orient.get(o_key, 0) < max(2, _MAX_DECK_POINTS_PER_BASE // 2):
            chosen.append(cand)
            kept_per_orient[o_key] = kept_per_orient.get(o_key, 0) + 1
        if len(chosen) >= _MAX_DECK_POINTS_PER_BASE:
            break
    return chosen


def _compute_children_and_above(onboard: Mapping[str, _PlacedNode]) -> Tuple[Dict[str, int], Dict[str, Decimal]]:
    children_count: Dict[str, int] = {iid: 0 for iid in onboard}
    above_weight: Dict[str, Decimal] = {iid: Decimal("0") for iid in onboard}
    for node in onboard.values():
        sup_id = node.placed.support_item_id
        if sup_id and sup_id in children_count:
            children_count[sup_id] += 1
        w = Decimal(str(node.item.weight_kg))
        for anc_id in node.ancestors:
            if anc_id in above_weight:
                above_weight[anc_id] += w
    return children_count, above_weight


class _UnequalCycleSolver:
    """Bounded backtracking 3D tree-stacking solver for one empty-to-empty load cycle."""

    def __init__(
        self,
        policy: DemoStackingPolicy,
        vehicle: VehicleFloor,
        stops: List[StopAction],
        validator: SpatialValidator,
        budget: _SearchBudget,
    ):
        self.policy = policy
        self.vehicle = vehicle
        self.stops = stops
        self.validator = validator
        self.budget = budget
        self.unload_step = self._build_unload_steps(stops)
        self.item_class = self._build_item_classes(stops)
        self.failed_states: Set[Tuple[int, Tuple[Tuple[object, ...], ...]]] = set()

    @staticmethod
    def _build_unload_steps(stops: Sequence[StopAction]) -> Dict[str, int]:
        steps: Dict[str, int] = {}
        for idx, stop in enumerate(stops):
            for iid in stop.items_to_unload:
                steps.setdefault(iid, idx)
        return steps

    def _build_item_classes(self, stops: Sequence[StopAction]) -> Dict[str, Tuple[object, ...]]:
        classes: Dict[str, Tuple[object, ...]] = {}
        for stop in stops:
            for it in stop.items_to_load:
                classes[it.id] = (
                    it.order_id,
                    it.customer_id or "",
                    round(it.length_cm, 4),
                    round(it.width_cm, 4),
                    round(it.height_cm, 4),
                    round(it.weight_kg, 4),
                    resolve_can_rotate(it),
                    it.cargo_kind,
                    it.allow_upper_tier,
                    it.no_top_load_requested,
                    it.max_top_load_g or 0,
                    self.unload_step.get(it.id, -1),
                )
        return classes

    @staticmethod
    def _obstacles_for(target_id: str, ancestors: Tuple[str, ...], onboard: Mapping[str, _PlacedNode]) -> List[PlacedItem]:
        ignored = {target_id, *ancestors}
        return [node.placed for oid, node in onboard.items() if oid not in ignored]

    def _state_key(self, stop_index: int, onboard: Mapping[str, _PlacedNode]) -> Tuple[int, Tuple[Tuple[object, ...], ...]]:
        sig = tuple(
            sorted(
                (
                    self.item_class.get(iid, (iid,)),
                    round(node.placed.x, 3),
                    round(node.placed.y, 3),
                    round(node.placed.z, 3),
                    round(node.placed.length_cm, 3),
                    round(node.placed.width_cm, 3),
                    self.item_class.get(node.placed.support_item_id, ()) if node.placed.support_item_id else (),
                )
                for iid, node in onboard.items()
            )
        )
        return stop_index, sig

    def _find_unload_sequence(
        self, onboard: Mapping[str, _PlacedNode], unload_ids: List[str]
    ) -> Optional[List[str]]:
        if not unload_ids:
            return []
        failed_rem: Set[Tuple[str, ...]] = set()

        def search(cur: Dict[str, _PlacedNode], remaining: Tuple[str, ...]) -> Optional[List[str]]:
            if not remaining:
                return []
            if not self.budget.consume():
                return None
            rkey = tuple(sorted(remaining))
            if rkey in failed_rem:
                return None

            children_count, _ = _compute_children_and_above(cur)
            candidates = sorted(
                (iid for iid in remaining if children_count.get(iid, 0) == 0),
                key=lambda iid: (cur[iid].tier, cur[iid].placed.x + cur[iid].placed.length_cm, iid),
                reverse=True,
            )
            for iid in candidates:
                if not self.budget.has_time():
                    return None
                node = cur[iid]
                obstacles = self._obstacles_for(iid, node.ancestors, cur)
                if not self.validator.is_path_to_door_clear(node.placed, obstacles)[0]:
                    continue
                nxt = dict(cur)
                del nxt[iid]
                suffix = search(nxt, tuple(x for x in remaining if x != iid))
                if suffix is not None:
                    return [iid] + suffix
            failed_rem.add(rkey)
            return None

        return search(dict(onboard), tuple(unload_ids))

    def _is_unload_safe(
        self,
        cand_placed: PlacedItem,
        cand_ancestors: Tuple[str, ...],
        onboard: Mapping[str, _PlacedNode],
    ) -> bool:
        default_step = len(self.stops) + 1
        cand_step = self.unload_step.get(cand_placed.item_id, default_step)
        ignored_for_cand = set(cand_ancestors)

        later_obstacles = [
            node.placed
            for oid, node in onboard.items()
            if oid not in ignored_for_cand
            and self.unload_step.get(oid, default_step) > cand_step
        ]
        if later_obstacles and not self.validator.is_path_to_door_clear(cand_placed, later_obstacles)[0]:
            return False

        for oid, earlier in onboard.items():
            earlier_step = self.unload_step.get(oid, default_step)
            if earlier_step < cand_step:
                if oid in ignored_for_cand:
                    return False
                earlier_ignored = {oid, *earlier.ancestors}
                blockers = [
                    node.placed
                    for bid, node in onboard.items()
                    if bid not in earlier_ignored
                    and self.unload_step.get(bid, default_step) > earlier_step
                ] + [cand_placed]
                if not self.validator.is_path_to_door_clear(earlier.placed, blockers)[0]:
                    return False
        return True

    def solve(self) -> Optional[Tuple[List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]], float, float]]:
        cargo_by_id: Dict[str, CargoItem] = {}
        for stop in self.stops:
            for it in stop.items_to_load:
                cargo_by_id[it.id] = it
        collected = _collect_intervals(self.stops)
        if collected is not None and len(self.stops) > 2 and self.budget.has_time():
            pickup_stop, delivery_stop, _ = collected
            ok, _, greedy_res = _solve_cycle_greedy(
                vehicle=self.vehicle,
                stops=self.stops,
                cargo_by_id=cargo_by_id,
                policy=self.policy,
                pickup_stop=pickup_stop,
                delivery_stop=delivery_stop,
                collect_snapshots=True,
                has_time=self.budget.has_time,
            )
            if ok and greedy_res is not None:
                return greedy_res
        return self._search_stops(0, {}, [], 0.0, 0.0)

    def _search_stops(
        self,
        stop_index: int,
        onboard: Dict[str, _PlacedNode],
        snapshots: List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]],
        max_weight: float,
        max_area: float,
    ) -> Optional[Tuple[List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]], float, float]]:
        if not self.budget.consume():
            return None
        if stop_index >= len(self.stops):
            return snapshots, max_weight, max_area

        skey = self._state_key(stop_index, onboard)
        if skey in self.failed_states:
            return None

        stop = self.stops[stop_index]
        unload_ids = list(stop.items_to_unload)
        if len(unload_ids) != len(set(unload_ids)) or any(iid not in onboard for iid in unload_ids):
            self.failed_states.add(skey)
            return None

        unload_seq = self._find_unload_sequence(onboard, unload_ids)
        if unload_seq is None:
            if not self.budget.limit_reached:
                self.failed_states.add(skey)
            return None

        after_unload = dict(onboard)
        for iid in unload_seq:
            del after_unload[iid]

        load_items = list(stop.items_to_load)
        post_w = sum(n.placed.weight_kg for n in after_unload.values()) + sum(it.weight_kg for it in load_items)
        if post_w > self.vehicle.payload_limit_kg + _EPS:
            self.failed_states.add(skey)
            return None
        floor_area_cap = float(self.vehicle.length_cm) * float(self.vehicle.width_cm)
        must_floor_area = sum(
            n.placed.length_cm * n.placed.width_cm for n in after_unload.values() if n.tier == 1
        ) + sum(
            it.length_cm * it.width_cm
            for it in load_items
            if not it.allow_upper_tier or it.cargo_kind != "STANDARD"
        )
        if must_floor_area > floor_area_cap + _EPS:
            self.failed_states.add(skey)
            return None

        ordered_loads = sorted(
            load_items,
            key=lambda it: (
                -self.unload_step.get(it.id, len(self.stops) + 1),
                1 if it.cargo_kind == "FRAGILE" else 0,
                1 if it.allow_upper_tier else 0,
                -it.weight_kg,
                -(it.length_cm * it.width_cm),
                it.id,
            ),
        )

        explored: Set[Tuple[Tuple[object, ...], ...]] = set()
        for loaded_map in self._search_loads(ordered_loads, 0, after_unload, stop_index):
            _, lsig = self._state_key(stop_index, loaded_map)
            if lsig in explored:
                continue
            explored.add(lsig)
            if len(explored) > _MAX_LAYOUTS_PER_STOP:
                self.budget.branch_cap_reached = True
                break
            cur_w = sum(n.placed.weight_kg for n in loaded_map.values())
            floor_area = sum(n.placed.length_cm * n.placed.width_cm for n in loaded_map.values() if n.tier == 1)
            nxt_snaps = snapshots + [(stop_index, tuple(loaded_map.values()), tuple(unload_seq))]
            sol = self._search_stops(
                stop_index + 1, loaded_map, nxt_snaps, max(max_weight, cur_w), max(max_area, floor_area)
            )
            if sol is not None:
                return sol
            if self.budget.limit_reached:
                return None

        if not self.budget.limit_reached:
            self.failed_states.add(skey)
        return None

    def _search_loads(
        self,
        items: List[CargoItem],
        idx: int,
        onboard: Dict[str, _PlacedNode],
        stop_index: int,
    ):
        if not self.budget.has_time():
            return
        if idx >= len(items):
            yield onboard
            return

        item = items[idx]
        if item.id in onboard or self.unload_step.get(item.id, len(self.stops) + 1) <= stop_index:
            return
        if item.height_cm > self.vehicle.height_cm + _EPS:
            return

        _, above_weight = _compute_children_and_above(onboard)
        max_future_unload = max(
            (
                self.unload_step.get(it.id, 0)
                for s in self.stops[stop_index + 1 :]
                for it in s.items_to_load
            ),
            default=None,
        )
        item_step = self.unload_step.get(item.id, len(self.stops) + 1)
        prefer_door = max_future_unload is not None and item_step < max_future_unload

        options: List[Tuple[Optional[str], Tuple[float, ...], float, float, float, float, float]] = []
        if item.allow_upper_tier and item.cargo_kind == "STANDARD":
            bases = sorted(
                onboard.values(),
                key=lambda bn: (
                    0 if (
                        tuple(sorted((round(bn.item.length_cm, 2), round(bn.item.width_cm, 2))))
                        == tuple(sorted((round(item.length_cm, 2), round(item.width_cm, 2))))
                    ) else 1,
                    self.unload_step.get(bn.placed.item_id, 999_999) - item_step,
                    bn.placed.length_cm * bn.placed.width_cm - item.length_cm * item.width_cm,
                    bn.tier,
                    bn.placed.x,
                    bn.placed.item_id,
                ),
            )
            for bn in bases:
                if not self.budget.has_time():
                    return
                if not _ancestors_can_support(
                    bn, item, onboard, above_weight, self.unload_step, self.policy, self.vehicle.height_cm
                ):
                    continue
                for cx, cy, cz, cl, cw in _deck_candidates_on_base(
                    item, bn, onboard, self.vehicle, prefer_door, self.budget.has_time,
                ):
                    options.append((bn.placed.item_id, bn.ancestors, cx, cy, cz, cl, cw))

        floor_items = [n.placed for n in onboard.values() if n.tier == 1]
        floor_cands = self.validator._candidate_placements(
            item,
            floor_items,
            unload_step=item_step,
            max_unload_step=max_future_unload,
            allow_door_placement=bool(prefer_door and len(items) <= 4),
            cargo_kind_by_id={nid: n.item.cargo_kind for nid, n in onboard.items()},
            has_remaining_cargo=(idx + 1 < len(items)) or any(s.items_to_load for s in self.stops[stop_index + 1 :]),
            has_time=self.budget.has_time,
        )
        if self.budget.limit_reached:
            return
        door_w = self.vehicle.door_width_cm
        orient_picked: Dict[int, int] = {}
        for fx, fy, fl, fw in floor_cands:
            if door_w is not None and fw > door_w + _EPS:
                continue
            o_key = 0 if abs(fl - item.length_cm) <= _EPS else 1
            if orient_picked.get(o_key, 0) >= max(4, _MAX_BRANCH_CANDIDATES_PER_ITEM // 2):
                continue
            orient_picked[o_key] = orient_picked.get(o_key, 0) + 1
            options.append((None, (), fx, fy, 0.0, fl, fw))

        identical_preds: List[Tuple[float, float, float, float, float]] = []
        my_class = self.item_class.get(item.id)
        for pred in items[:idx]:
            if pred.id in onboard and self.item_class.get(pred.id) == my_class:
                pp = onboard[pred.id].placed
                identical_preds.append((round(pp.z, 3), round(pp.x, 3), round(pp.y, 3), round(pp.length_cm, 3), round(pp.width_cm, 3)))
        min_sym = max(identical_preds, default=None)

        tried = 0
        for sup_id, sup_ancs, cx, cy, cz, cl, cw in options:
            if not self.budget.consume():
                return
            sym_key = (round(cz, 3), round(cx, 3), round(cy, 3), round(cl, 3), round(cw, 3))
            if min_sym is not None and sym_key < min_sym:
                continue
            placed_item = PlacedItem(
                item_id=item.id,
                order_id=item.order_id,
                x=cx,
                y=cy,
                z=cz,
                length_cm=cl,
                width_cm=cw,
                height_cm=item.height_cm,
                weight_kg=item.weight_kg,
                support_item_id=sup_id,
                cargo_kind=item.cargo_kind,
                no_top_load_requested=item.no_top_load_requested,
                floor_rotation_locked=is_floor_rotation_locked(item),
            )
            ancs = ((sup_id, *sup_ancs) if sup_id else ())
            obstacles = self._obstacles_for(item.id, ancs, onboard)
            if not self.validator.is_path_to_door_clear(placed_item, obstacles)[0]:
                continue
            if not self._is_unload_safe(placed_item, ancs, onboard):
                continue

            tried += 1
            nxt = dict(onboard)
            nxt[item.id] = _PlacedNode(
                placed=placed_item,
                item=item,
                tier=(onboard[sup_id].tier + 1 if sup_id else 1),
                ancestors=ancs,
            )
            yield from self._search_loads(items, idx + 1, nxt, stop_index)
            if self.budget.limit_reached or tried >= _MAX_BRANCH_CANDIDATES_PER_ITEM:
                return


def _build_unequal_floor_states(
    policy: DemoStackingPolicy,
    vehicle: VehicleFloor,
    validator: SpatialValidator,
    stops: List[StopAction],
    snapshots: List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]],
    step_offset: int,
) -> List[FloorState]:
    floor_area = vehicle.length_cm * vehicle.width_cm
    states: List[FloorState] = []
    for stop_index, nodes, unload_seq in snapshots:
        stop = stops[stop_index]
        by_id = {n.placed.item_id: n for n in nodes}
        placed_sorted = sorted((n.placed for n in nodes), key=lambda p: p.item_id)
        cur_weight = sum(p.weight_kg for p in placed_sorted)
        floor_occupied = sum(n.placed.length_cm * n.placed.width_cm for n in nodes if n.tier == 1)

        descendants: Dict[str, List[str]] = {iid: [] for iid in by_id}
        for iid, node in by_id.items():
            for anc_id in node.ancestors:
                if anc_id in descendants:
                    descendants[anc_id].append(iid)

        paths: List[PackageAccessPath] = []
        for p in placed_sorted:
            node = by_id[p.item_id]
            above = sorted(descendants[p.item_id], key=lambda did: (-by_id[did].tier, did))
            ignored = {p.item_id, *node.ancestors}
            obstacles = [n.placed for oid, n in by_id.items() if oid not in ignored]
            if above:
                outer_blockers = [obs.item_id for obs in obstacles if obs.item_id not in above and validator._blocks_straight_path(p, obs)]
                paths.append(PackageAccessPath(item_id=p.item_id, is_clear=False, points=[], blocker_item_ids=above + outer_blockers))
                continue
            raw_path = validator._find_translation_path_to_door(p, obstacles)
            if raw_path is None:
                direct = [obs.item_id for obs in obstacles if validator._blocks_straight_path(p, obs)]
                paths.append(PackageAccessPath(item_id=p.item_id, is_clear=False, points=[], blocker_item_ids=direct))
            else:
                if p.z > _EPS and raw_path:
                    pts = [MovementPoint(x=raw_path[0][0], y=raw_path[0][1], z=p.z)]
                    pts.extend(MovementPoint(x=px, y=py, z=p.z + policy.lift_clearance_cm) for px, py in raw_path)
                else:
                    pts = [MovementPoint(x=px, y=py, z=0.0) for px, py in raw_path]
                paths.append(PackageAccessPath(item_id=p.item_id, is_clear=True, points=pts, blocker_item_ids=[]))

        states.append(
            FloorState(
                step_index=step_offset + stop_index + 1,
                stop_id=stop.stop_id,
                stop_type=stop.stop_type,
                action_description=f"Stop {stop.sequence} ({stop.stop_type}) - {stop.address}",
                placed_items=placed_sorted,
                current_weight_kg=round(cur_weight, 3),
                current_occupied_area_cm2=round(floor_occupied, 1),
                floor_area_cm2=floor_area,
                weight_utilization_percent=round((cur_weight / vehicle.payload_limit_kg) * 100.0, 1),
                area_utilization_percent=round((floor_occupied / floor_area) * 100.0, 1) if floor_area > 0 else 0.0,
                is_valid=True,
                unload_sequence=list(unload_seq),
                package_access_paths=paths,
                weight_balance=build_weight_balance_metrics(placed_sorted, vehicle.length_cm, vehicle.width_cm),
            )
        )
    return states


def validate_unequal_stacked_stops(
    policy: DemoStackingPolicy,
    vehicle: VehicleFloor,
    stops: List[StopAction],
    validator: SpatialValidator,
    *,
    max_search_nodes: Optional[int] = None,
    max_time_seconds: Optional[float] = None,
) -> SpatialValidationResult:
    """Validate StopAction sequence supporting unequal-footprint multi-child 3D tree stacking."""
    started = time.monotonic()
    time_limit = float(validator.max_time_seconds if max_time_seconds is None else max_time_seconds)
    node_limit = int(validator.max_search_nodes if max_search_nodes is None else max_search_nodes)

    cycles = validator._split_independent_load_cycles(stops)
    states: List[FloorState] = []
    max_weight = 0.0
    max_area = 0.0
    step_offset = 0

    for cycle in cycles:
        remaining = max(0.0, time_limit - (time.monotonic() - started))
        budget = _SearchBudget(max_nodes=node_limit, max_time_seconds=remaining)
        sol = _UnequalCycleSolver(policy, vehicle, cycle, validator, budget).solve()
        if sol is None:
            code = "PLACEMENT_SEARCH_LIMIT_REACHED" if (budget.limit_reached or budget.branch_cap_reached) else "NO_FEASIBLE_LAYOUT"
            return SpatialValidationResult(
                is_valid=False,
                violation_code=code,
                error_message="Không tìm được bố trí xếp chồng 3D hợp lệ cho chuỗi điểm dừng.",
                max_weight_kg=round(max_weight, 3),
                max_area_cm2=max_area,
                step_states=states,
                demo_stacking=policy,
            )
        snaps, c_weight, c_area = sol
        max_weight = max(max_weight, c_weight)
        max_area = max(max_area, c_area)
        states.extend(_build_unequal_floor_states(policy, vehicle, validator, cycle, snaps, step_offset))
        step_offset += len(cycle)

    max_lat_imb = max(
        (s.weight_balance.lateral_imbalance_percent for s in states if s.weight_balance is not None and s.weight_balance.status != "EMPTY"),
        default=0.0,
    )
    return SpatialValidationResult(
        is_valid=True,
        max_weight_kg=round(max_weight, 3),
        max_area_cm2=max_area,
        max_lateral_imbalance_percent=round(max_lat_imb, 1),
        step_states=states,
        demo_stacking=policy,
    )


_FAST_CYCLE_CACHE: "OrderedDict[Tuple[Any, ...], Tuple[bool, str]]" = OrderedDict()
_FAST_CYCLE_CACHE_MAX = 4096


def _fast_cycle_cache_key(
    vehicle: Any,
    cycle_stops: Sequence[Any],
    cargo_by_id: Mapping[str, Any],
    policy: DemoStackingPolicy,
    allow_layout_search: bool,
    has_fallback: bool,
) -> Tuple[Any, ...]:
    veh_key = (
        round(float(vehicle.length_cm), 4),
        round(float(vehicle.width_cm), 4),
        round(float(vehicle.height_cm), 4),
        round(float(vehicle.payload_limit_kg), 4),
        getattr(vehicle, "door_width_cm", None),
        getattr(vehicle, "door_position", "REAR"),
    )
    pol_key = (
        int(policy.max_tiers),
        float(policy.lift_clearance_cm),
        str(policy.owner_mode),
        int(getattr(policy, "max_top_load_percent", 30)),
    )
    stops_key = tuple(
        (
            stop.stop_type,
            tuple(
                (
                    iid,
                    it.order_id,
                    getattr(it, "customer_id", None),
                    round(float(it.length_cm), 4),
                    round(float(it.width_cm), 4),
                    round(float(it.height_cm), 4),
                    round(float(it.weight_kg), 4),
                    bool(resolve_can_rotate(it)),
                    tuple(getattr(it, "allowed_orientations", None) or ()),
                    getattr(it, "cargo_kind", "UNCLASSIFIED"),
                    bool(getattr(it, "allow_upper_tier", False)),
                    bool(getattr(it, "no_top_load_requested", False)),
                    getattr(it, "max_top_load_g", None),
                )
                for iid in stop.items_loaded
                for it in (cargo_by_id[iid],)
            ),
            tuple(stop.items_unloaded),
        )
        for stop in cycle_stops
    )
    return veh_key, pol_key, bool(allow_layout_search), bool(has_fallback), stops_key


def fast_validate_unequal_stacked_route(
    vehicle: Any,
    stops: Sequence[Any],
    cargo_by_id: Mapping[str, Any],
    policy: DemoStackingPolicy,
    *,
    allow_layout_search: bool = True,
    validate_fallback: Optional[Callable[..., SpatialValidationResult]] = None,
) -> Tuple[bool, str]:
    """Fast O(N*K) LIFO + unequal-footprint tree stacking pre-check matching 3D rules."""
    if not stops:
        return True, "Hợp lệ"
    pickup_stop: Dict[str, int] = {}
    delivery_stop: Dict[str, int] = {}
    for idx, stop in enumerate(stops):
        for iid in stop.items_loaded:
            if iid in pickup_stop:
                return False, "Kiện bị bốc lên nhiều lần"
            pickup_stop[iid] = idx
        for iid in stop.items_unloaded:
            if iid in delivery_stop:
                return False, "Kiện bị dỡ nhiều lần"
            delivery_stop[iid] = idx
    if pickup_stop.keys() != delivery_stop.keys():
        return False, "Thiếu cặp nhận/giao kiện"
    for iid in pickup_stop:
        if delivery_stop[iid] <= pickup_stop[iid] or iid not in cargo_by_id:
            return False, "Thứ tự nhận/giao kiện không hợp lệ"

    # Empty-to-empty cycles are physically independent; validate & memoize each cycle once.
    cycle_slices: List[Sequence[Any]] = []
    onboard_cycle: Set[str] = set()
    start_idx = 0
    for idx, stop in enumerate(stops):
        for iid in stop.items_unloaded:
            onboard_cycle.discard(iid)
        for iid in stop.items_loaded:
            onboard_cycle.add(iid)
        if not onboard_cycle and idx + 1 < len(stops):
            cycle_slices.append(stops[start_idx : idx + 1])
            start_idx = idx + 1
    cycle_slices.append(stops[start_idx:])

    if len(cycle_slices) > 1:
        for cycle in cycle_slices:
            ok, msg = _fast_validate_unequal_cycle(
                vehicle,
                cycle,
                cargo_by_id,
                policy,
                allow_layout_search=allow_layout_search,
                validate_fallback=validate_fallback,
            )
            if not ok:
                return False, msg
        return True, "Hợp lệ"

    return _fast_validate_unequal_cycle(
        vehicle,
        stops,
        cargo_by_id,
        policy,
        allow_layout_search=allow_layout_search,
        validate_fallback=validate_fallback,
    )


def _fast_validate_unequal_cycle(
    vehicle: Any,
    stops: Sequence[Any],
    cargo_by_id: Mapping[str, Any],
    policy: DemoStackingPolicy,
    *,
    allow_layout_search: bool = True,
    validate_fallback: Optional[Callable[..., SpatialValidationResult]] = None,
) -> Tuple[bool, str]:
    key = _fast_cycle_cache_key(
        vehicle,
        stops,
        cargo_by_id,
        policy,
        allow_layout_search,
        validate_fallback is not None,
    )
    cached = _FAST_CYCLE_CACHE.get(key)
    if cached is not None:
        _FAST_CYCLE_CACHE.move_to_end(key)
        return cached

    res = _fast_validate_unequal_cycle_uncached(
        vehicle,
        stops,
        cargo_by_id,
        policy,
        allow_layout_search=allow_layout_search,
        validate_fallback=validate_fallback,
    )
    if res[0] or not (allow_layout_search and validate_fallback is not None):
        _FAST_CYCLE_CACHE[key] = res
        if len(_FAST_CYCLE_CACHE) > _FAST_CYCLE_CACHE_MAX:
            _FAST_CYCLE_CACHE.popitem(last=False)
    return res


def _solve_cycle_greedy(
    *,
    vehicle: Any,
    stops: Sequence[Any],
    cargo_by_id: Mapping[str, Any],
    policy: DemoStackingPolicy,
    pickup_stop: Mapping[str, int],
    delivery_stop: Mapping[str, int],
    collect_snapshots: bool = False,
    has_time: Optional[Callable[[], bool]] = None,
) -> Tuple[bool, str, Optional[Tuple[List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]], float, float]]]:
    bed_l = float(vehicle.length_cm)
    bed_w = float(vehicle.width_cm)
    bed_h = float(vehicle.height_cm)
    payload_limit = Decimal(str(vehicle.payload_limit_kg))

    def _load_ids(stop: Any) -> List[str]:
        loads = getattr(stop, "items_to_load", None)
        if loads is not None:
            return [it.id for it in loads]
        return list(getattr(stop, "items_loaded", ()))

    def _unload_ids(stop: Any) -> List[str]:
        unloads = getattr(stop, "items_to_unload", None)
        if unloads is not None:
            return list(unloads)
        return list(getattr(stop, "items_unloaded", ()))

    def _run_strategy(
        strategy: str,
    ) -> Tuple[bool, str, Optional[Tuple[List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]], float, float]]]:
        onboard: Dict[str, Dict[str, Any]] = {}
        onboard_weight = Decimal("0")
        snapshots: List[Tuple[int, Tuple[_PlacedNode, ...], Tuple[str, ...]]] = []
        max_weight = 0.0
        max_area = 0.0

        def _deck_place(
            item: Any,
            base: Dict[str, Any],
            item_deliv: int,
            orients: Optional[List[Tuple[float, float]]] = None,
        ) -> Optional[Tuple[float, float, float, float, float]]:
            if orients is None:
                orients = _permitted_orientations(item, vehicle)
            base_l = base["l"]
            base_w = base["w"]
            fitting_orients = [(l_d, w_d) for l_d, w_d in orients if l_d <= base_l + _EPS and w_d <= base_w + _EPS]
            if not fitting_orients:
                return None
            u_z = base["z"] + base["h"]
            u_h = float(item.height_cm)
            z_conflicts = [
                (e["x"], e["y"], e["x"] + e["l"], e["y"] + e["w"], e)
                for e in onboard.values()
                if not (e["z"] + e["h"] <= u_z + _EPS or u_z + u_h <= e["z"] + _EPS)
            ]
            ignored = {base["id"], *base["ancestors"]}
            other_obs = [
                (e["x"], e["y"], e["x"] + e["l"], e["y"] + e["w"])
                for oid, e in onboard.items()
                if oid not in ignored
            ]
            earlier_obs = [
                (e["x"] + e["l"], e["y"], e["y"] + e["w"])
                for oid, e in onboard.items()
                if oid not in ignored and e["delivery_idx"] < item_deliv
            ]
            cand_best: Optional[Tuple[float, float, float, float, float]] = None
            cand_score = float("inf")
            base_x = base["x"]
            base_y = base["y"]
            base_x_end = base_x + base_l
            base_y_end = base_y + base_w

            for l_dim, w_dim in fitting_orients:
                min_x, max_x = base_x, base_x_end - l_dim
                min_y, max_y = base_y, base_y_end - w_dim
                x_raw = [min_x, max_x]
                y_raw = [min_y, max_y]
                for ox, oy, ox_end, oy_end, _ in z_conflicts:
                    if (
                        base_x_end > ox + _EPS
                        and ox_end > base_x + _EPS
                        and base_y_end > oy + _EPS
                        and oy_end > base_y + _EPS
                    ):
                        x_raw.extend((ox_end, ox - l_dim))
                        y_raw.extend((oy_end, oy - w_dim))
                x_vals = [sx for rx in x_raw if (sx := _snap_inside_span(rx, min_x, max_x)) is not None]
                y_vals = [sy for ry in y_raw if (sy := _snap_inside_span(ry, min_y, max_y)) is not None]
                y_sorted = sorted(set(y_vals))
                for xc in sorted(set(x_vals)):
                    x_term = (xc - min_x) * 1000.0
                    if x_term >= cand_score:
                        break
                    xc_end = xc + l_dim
                    xc_p = xc + _EPS
                    xc_end_p = xc_end + _EPS
                    check_corr = bed_l - xc_end > _EPS
                    for yc in y_sorted:
                        score = x_term + min(abs(yc - min_y), abs(max_y - yc)) * 10.0 + yc * 0.05
                        if score >= cand_score:
                            continue
                        yc_end = yc + w_dim
                        yc_p = yc + _EPS
                        blocked = False
                        for ox, oy, ox_end, oy_end, _ in z_conflicts:
                            if xc_end > ox + _EPS and ox_end > xc_p and yc_end > oy + _EPS and oy_end > yc_p:
                                blocked = True
                                break
                        if blocked:
                            continue
                        if check_corr:
                            for ox, oy, ox_end, oy_end in other_obs:
                                if bed_l > ox + _EPS and ox_end > xc_end_p and yc_end > oy + _EPS and oy_end > yc_p:
                                    blocked = True
                                    break
                            if blocked:
                                continue
                        if earlier_obs:
                            for ex_end, ey, ey_end in earlier_obs:
                                if xc > ex_end - _EPS and yc_end > ey + _EPS and ey_end > yc_p:
                                    blocked = True
                                    break
                            if blocked:
                                continue
                        cand_score = score
                        cand_best = (xc, yc, u_z, l_dim, w_dim)
            return cand_best

        def _try_stack_existing(item: Any, item_deliv: int) -> bool:
            if not bool(getattr(item, "allow_upper_tier", False)) or getattr(item, "cargo_kind", "UNCLASSIFIED") != "STANDARD":
                return False
            orients = _permitted_orientations(item, vehicle)
            if not orients:
                return False
            item_w = Decimal(str(item.weight_kg))
            u_pair = tuple(sorted((round(float(item.length_cm), 2), round(float(item.width_cm), 2))))
            bases = sorted(
                onboard.values(),
                key=lambda b: (
                    0 if tuple(sorted((round(float(b["item"].length_cm), 2), round(float(b["item"].width_cm), 2)))) == u_pair else 1,
                    b["delivery_idx"] - item_deliv,
                    b["l"] * b["w"],
                    b["tier"],
                    b["id"],
                ),
            )
            max_top_pct = getattr(policy, "max_top_load_percent", 30)
            item_h = float(item.height_cm)
            for base in bases:
                if base["tier"] + 1 > policy.max_tiers or base["delivery_idx"] < item_deliv:
                    continue
                if base["z"] + base["h"] + item_h + policy.lift_clearance_cm > bed_h + _EPS:
                    continue
                b_l = base["l"] + _EPS
                b_w = base["w"] + _EPS
                if not any(l_d <= b_l and w_d <= b_w for l_d, w_d in orients):
                    continue
                anc_ids = (base["id"], *base["ancestors"])
                ok_anc = True
                for anc_id in anc_ids:
                    anc = onboard[anc_id]
                    anc_it = anc["item"]
                    max_top = getattr(anc_it, "max_top_load_g", None)
                    if (
                        getattr(anc_it, "cargo_kind", "UNCLASSIFIED") != "STANDARD"
                        or bool(getattr(anc_it, "no_top_load_requested", False))
                        or (policy.owner_mode == "SAME_CUSTOMER" and not _same_customer(anc_it, item))
                        or exceeds_top_load_limit(
                            anc["above_weight"] + item_w,
                            anc_it.weight_kg,
                            max_top,
                            max_top_pct,
                        )
                    ):
                        ok_anc = False
                        break
                if not ok_anc:
                    continue
                placement = _deck_place(item, base, item_deliv, orients)
                if placement is None:
                    continue
                xc, yc, zc, lc, wc = placement
                for anc_id in anc_ids:
                    onboard[anc_id]["above_weight"] += item_w
                base["children"] += 1
                onboard[item.id] = {
                    "id": item.id, "item": item, "x": xc, "y": yc, "z": zc,
                    "l": lc, "w": wc, "h": item_h,
                    "delivery_idx": item_deliv, "tier": base["tier"] + 1,
                    "support_id": base["id"], "ancestors": anc_ids,
                    "above_weight": Decimal("0"), "children": 0,
                }
                return True
            return False

        def _try_place_floor(item: Any, item_deliv: int) -> bool:
            orients = _permitted_orientations(item, vehicle)
            if not orients:
                return False
            floor_entries = [e for e in onboard.values() if e["tier"] == 1]
            floor_rects = [(e["x"], e["y"], e["x"] + e["l"], e["y"] + e["w"]) for e in floor_entries]
            pts = {(0.0, 0.0)}
            for e in floor_entries:
                ex_end = e["x"] + e["l"]
                ey_end = e["y"] + e["w"]
                if ex_end <= bed_l:
                    pts.add((ex_end, e["y"]))
                    pts.add((ex_end, 0.0))
                    pts.add((ex_end, ey_end))
                if ey_end <= bed_w:
                    pts.add((e["x"], ey_end))
                    pts.add((0.0, ey_end))
            for _, w_dim in orients:
                if w_dim <= bed_w:
                    yw = bed_w - w_dim
                    pts.add((0.0, yw))
                    for e in floor_entries:
                        ex_end = e["x"] + e["l"]
                        if ex_end <= bed_l:
                            pts.add((ex_end, yw))

            diff_obs = [
                (e["y"], e["y"] + e["w"])
                for e in floor_entries
                if e["delivery_idx"] != item_deliv
            ] if strategy != "default" else []
            earlier_obs = [
                (e["x"] + e["l"], e["y"], e["y"] + e["w"])
                for e in onboard.values()
                if e["delivery_idx"] < item_deliv
            ]
            bal_ctx = build_floor_balance_context(
                [
                    (
                        e["x"],
                        e["y"],
                        e["l"],
                        e["w"],
                        float(e["item"].weight_kg),
                        getattr(e["item"], "cargo_kind", "UNCLASSIFIED"),
                    )
                    for e in floor_entries
                ],
                bed_w,
            )
            item_kind = getattr(item, "cargo_kind", "UNCLASSIFIED")
            item_w = max(0.0, float(item.weight_kg))
            sorted_pts = sorted(pts)

            best_cand: Optional[Tuple[float, float, float, float]] = None
            best_score = float("inf")
            is_default_strategy = strategy == "default"
            is_lane_left = strategy == "lane_y_left"
            for l_dim, w_dim in orients:
                diff_y_cache: Dict[float, bool] = {}
                max_x_allowed = bed_l - l_dim + _EPS
                max_y_allowed = bed_w - w_dim + _EPS
                for xc, yc in sorted_pts:
                    if is_default_strategy and xc * 1000.0 >= best_score:
                        break
                    if xc > max_x_allowed or yc > max_y_allowed:
                        continue
                    yc_end = yc + w_dim
                    if is_default_strategy:
                        corridor_pen = 150.0 if (yc > _EPS and yc_end < bed_w - _EPS) else 0.0
                        lb = xc * 1000.0 + corridor_pen + yc * 0.05
                    else:
                        y_pref = yc_end if is_lane_left else (bed_w - yc)
                        base_lb = y_pref * 1000.0 + xc * 10.0
                        if base_lb >= best_score:
                            continue
                        diff_y = diff_y_cache.get(yc)
                        if diff_y is None:
                            yc_p_chk = yc + _EPS
                            diff_y = False
                            for ey, ey_end in diff_obs:
                                if yc_end > ey + _EPS and ey_end > yc_p_chk:
                                    diff_y = True
                                    break
                            diff_y_cache[yc] = diff_y
                        lb = (1_000_000.0 if diff_y else 0.0) + base_lb
                    if lb >= best_score:
                        continue
                    xc_end = xc + l_dim
                    xc_p = xc + _EPS
                    xc_end_p = xc_end + _EPS
                    yc_p = yc + _EPS
                    check_corr = bed_l - xc_end > _EPS
                    blocked = False
                    for ox, oy, ox_end, oy_end in floor_rects:
                        if yc_end > oy + _EPS and oy_end > yc_p:
                            if xc_end > ox + _EPS and ox_end > xc_p:
                                blocked = True
                                break
                            if check_corr and bed_l > ox + _EPS and ox_end > xc_end_p:
                                blocked = True
                                break
                    if blocked:
                        continue
                    if earlier_obs:
                        for ex_end, ey, ey_end in earlier_obs:
                            if xc > ex_end - _EPS and yc_end > ey + _EPS and ey_end > yc_p:
                                blocked = True
                                break
                        if blocked:
                            continue
                    lat_imb, fragile_adj = score_candidate_balance_and_fragility_ctx(
                        bal_ctx,
                        cand_x=xc,
                        cand_y=yc,
                        cand_l=l_dim,
                        cand_w=w_dim,
                        cand_weight_kg=item_w,
                        cand_cargo_kind=item_kind,
                        floor_width_cm=bed_w,
                    )
                    extra = (lat_imb * 120.0 + fragile_adj * 140.0) if is_default_strategy else (lat_imb * 20.0 + fragile_adj * 25.0)
                    score = lb + extra
                    if score < best_score:
                        best_score = score
                        best_cand = (xc, yc, l_dim, w_dim)
            if best_cand is None:
                return False
            xc, yc, lc, wc = best_cand
            onboard[item.id] = {
                "id": item.id, "item": item, "x": xc, "y": yc, "z": 0.0,
                "l": lc, "w": wc, "h": float(item.height_cm),
                "delivery_idx": item_deliv, "tier": 1,
                "support_id": None, "ancestors": (),
                "above_weight": Decimal("0"), "children": 0,
            }
            return True

        for stop_index, stop in enumerate(stops):
            if has_time is not None and not has_time():
                return False, "Hết thời gian kiểm tra bố trí", None
            pending = _unload_ids(stop)
            unload_seq: List[str] = []
            if pending:
                if len(pending) != len(set(pending)) or any(iid not in onboard for iid in pending):
                    return False, "Dỡ kiện chưa có trên xe", None
                while pending:
                    ready = sorted(
                        (iid for iid in pending if onboard[iid]["children"] == 0),
                        key=lambda iid: (onboard[iid]["tier"], onboard[iid]["x"] + onboard[iid]["l"], iid),
                        reverse=True,
                    )
                    popped_id: Optional[str] = None
                    for iid in ready:
                        entry = onboard[iid]
                        ignored = {iid, *entry["ancestors"]}
                        other_obs = [(e["x"], e["y"], e["l"], e["w"]) for oid, e in onboard.items() if oid not in ignored]
                        if _col_corridor_clear(entry["x"], entry["y"], entry["l"], entry["w"], bed_l, other_obs):
                            popped_id = iid
                            break
                    if popped_id is None:
                        if any(onboard[iid]["children"] > 0 for iid in pending):
                            return False, "Bị kiện phía trên chặn khi dỡ", None
                        return False, "Bị hàng khác chặn lối ra cửa đuôi", None
                    popped = onboard.pop(popped_id)
                    pop_w = Decimal(str(popped["item"].weight_kg))
                    for anc_id in popped["ancestors"]:
                        if anc_id in onboard:
                            onboard[anc_id]["above_weight"] = max(Decimal("0"), onboard[anc_id]["above_weight"] - pop_w)
                    if popped["support_id"] and popped["support_id"] in onboard:
                        onboard[popped["support_id"]]["children"] = max(0, onboard[popped["support_id"]]["children"] - 1)
                    onboard_weight = max(Decimal("0"), onboard_weight - pop_w)
                    pending.remove(popped_id)
                    unload_seq.append(popped_id)

            loads = _load_ids(stop)
            if loads:
                ordered_load_ids = sorted(
                    loads,
                    key=lambda iid: (
                        delivery_stop[iid],
                        0 if getattr(cargo_by_id[iid], "cargo_kind", "UNCLASSIFIED") == "FRAGILE" else 1,
                        0 if getattr(cargo_by_id[iid], "allow_upper_tier", False) else 1,
                        float(cargo_by_id[iid].weight_kg),
                        float(cargo_by_id[iid].length_cm) * float(cargo_by_id[iid].width_cm),
                        getattr(cargo_by_id[iid], "max_top_load_g", None) or 0,
                        iid,
                    ),
                    reverse=True,
                )
                for iid in ordered_load_ids:
                    item = cargo_by_id[iid]
                    if float(item.height_cm) > bed_h + _EPS:
                        return False, "Kiện vượt chiều cao thùng xe", None
                    onboard_weight += Decimal(str(item.weight_kg))
                    if onboard_weight > payload_limit + Decimal("0.01"):
                        return False, "Vượt tải trọng xe", None
                    item_deliv = delivery_stop[iid]
                    if not (_try_stack_existing(item, item_deliv) or _try_place_floor(item, item_deliv)):
                        return False, "Không đủ chỗ xếp chồng hoặc diện tích sàn", None

            if stop.stop_type not in ("PICKUP", "DELIVERY"):
                return False, f"Loại điểm dừng không hợp lệ: {stop.stop_type}", None

            if collect_snapshots:
                cur_w = float(onboard_weight)
                floor_area = sum(e["l"] * e["w"] for e in onboard.values() if e["tier"] == 1)
                max_weight = max(max_weight, cur_w)
                max_area = max(max_area, floor_area)
                nodes = tuple(
                    _PlacedNode(
                        placed=PlacedItem(
                            item_id=e["id"],
                            order_id=e["item"].order_id,
                            x=e["x"],
                            y=e["y"],
                            z=e["z"],
                            length_cm=e["l"],
                            width_cm=e["w"],
                            height_cm=e["h"],
                            weight_kg=float(e["item"].weight_kg),
                            support_item_id=e["support_id"],
                            cargo_kind=getattr(e["item"], "cargo_kind", "UNCLASSIFIED"),
                            no_top_load_requested=bool(getattr(e["item"], "no_top_load_requested", False)),
                            floor_rotation_locked=is_floor_rotation_locked(e["item"]),
                        ),
                        item=e["item"],
                        tier=e["tier"],
                        ancestors=e["ancestors"],
                    )
                    for e in onboard.values()
                )
                snapshots.append((stop_index, nodes, tuple(unload_seq)))

        if onboard:
            return False, "Còn hàng chưa dỡ", None
        return True, "Hợp lệ", (snapshots, max_weight, max_area) if collect_snapshots else None

    res = _run_strategy("default")
    if res[0]:
        return res
    if len(set(delivery_stop.values())) > 1 and res[1] in (
        "Không đủ chỗ xếp chồng hoặc diện tích sàn",
        "Bị hàng khác chặn lối ra cửa đuôi",
        "Bị kiện phía trên chặn khi dỡ",
    ):
        for strategy in ("lane_y_left", "lane_y_right"):
            if has_time is not None and not has_time():
                break
            alt = _run_strategy(strategy)
            if alt[0]:
                return alt
    return res


def _fast_validate_unequal_cycle_uncached(
    vehicle: Any,
    stops: Sequence[Any],
    cargo_by_id: Mapping[str, Any],
    policy: DemoStackingPolicy,
    *,
    allow_layout_search: bool = True,
    validate_fallback: Optional[Callable[..., SpatialValidationResult]] = None,
) -> Tuple[bool, str]:
    pickup_stop: Dict[str, int] = {}
    delivery_stop: Dict[str, int] = {}
    for idx, stop in enumerate(stops):
        for iid in stop.items_loaded:
            if iid in pickup_stop:
                return False, "Kiện bị bốc lên nhiều lần"
            pickup_stop[iid] = idx
        for iid in stop.items_unloaded:
            if iid in delivery_stop:
                return False, "Kiện bị dỡ nhiều lần"
            delivery_stop[iid] = idx
    if pickup_stop.keys() != delivery_stop.keys():
        return False, "Thiếu cặp nhận/giao kiện"
    for iid in pickup_stop:
        if delivery_stop[iid] <= pickup_stop[iid] or iid not in cargo_by_id:
            return False, "Thứ tự nhận/giao kiện không hợp lệ"

    def _try_fallback_search() -> Optional[Tuple[bool, str]]:
        if not (allow_layout_search and validate_fallback is not None and len(pickup_stop) <= 12 and len(stops) <= 24):
            return None
        actions = [
            StopAction(
                stop_id=f"{i}:{s.location_id}",
                sequence=i + 1,
                stop_type=s.stop_type,
                items_to_load=[
                    CargoItem(
                        id=cargo_by_id[cid].id,
                        order_id=cargo_by_id[cid].order_id,
                        customer_id=getattr(cargo_by_id[cid], "customer_id", None),
                        description=getattr(cargo_by_id[cid], "description", ""),
                        length_cm=cargo_by_id[cid].length_cm,
                        width_cm=cargo_by_id[cid].width_cm,
                        height_cm=cargo_by_id[cid].height_cm,
                        weight_kg=cargo_by_id[cid].weight_kg,
                        can_rotate=resolve_can_rotate(cargo_by_id[cid]),
                        allowed_orientations=getattr(cargo_by_id[cid], "allowed_orientations", None),
                        cargo_kind=getattr(cargo_by_id[cid], "cargo_kind", "UNCLASSIFIED"),
                        allow_upper_tier=bool(getattr(cargo_by_id[cid], "allow_upper_tier", False)),
                        no_top_load_requested=bool(getattr(cargo_by_id[cid], "no_top_load_requested", False)),
                        max_top_load_g=getattr(cargo_by_id[cid], "max_top_load_g", None),
                    )
                    for cid in s.items_loaded
                ],
                items_to_unload=list(s.items_unloaded),
            )
            for i, s in enumerate(stops)
        ]
        res = validate_fallback(policy, vehicle, actions, max_search_nodes=300, max_time_seconds=0.02)
        if res.is_valid:
            return True, "Hợp lệ sau tìm kiếm xếp chồng"
        return None

    ok, msg, _ = _solve_cycle_greedy(
        vehicle=vehicle,
        stops=stops,
        cargo_by_id=cargo_by_id,
        policy=policy,
        pickup_stop=pickup_stop,
        delivery_stop=delivery_stop,
        collect_snapshots=False,
    )
    if ok:
        return True, msg
    fb = _try_fallback_search()
    if fb is not None:
        return fb
    return False, msg
