"""In-progress trip continuation evaluator (3D unload obstruction + timing + unpicked release).

Implements A1/A2 warehouse-return guarantees:
- Retained failed-delivery cargo stays physically fixed onboard until warehouse return.
- Remaining onboard deliveries are kept only if on time and unloadable without
  temporarily removing any retained or other pending cargo onto the street.
- Unpicked orders whose pickup/delivery violates time windows, payload/floor/3D capacity,
  or unload clearance alongside retained/remaining cargo are detached so free vehicles
  can be dispatched instead.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

from .models import (
    CargoItem,
    DemoStackingPolicy,
    EvaluatedStopDecision,
    InProgressEvaluationRequest,
    InProgressEvaluationResponse,
    PlacedItem,
    PlacedOnboardItem,
    RemainingRouteStop,
    StopAction,
    VehicleFloor,
)
from .packing_rules import is_floor_rotation_locked
from .spatial_validator import SpatialValidator
from .stacking import DemoStacks
from .stacking_unequal import (
    _PlacedNode,
    _ancestors_can_support,
    _compute_children_and_above,
    _deck_candidates_on_base,
)

_EPS = 0.01


def _outside_time_limit(
    stop: RemainingRouteStop,
    shift_end_epoch_sec: Optional[int],
    return_to_hub_travel_sec: int,
) -> bool:
    if stop.estimated_arrival_epoch_sec is None:
        return False
    if (
        stop.window_end_epoch_sec is not None
        and stop.estimated_arrival_epoch_sec > stop.window_end_epoch_sec
    ):
        return True
    if shift_end_epoch_sec is not None:
        finish_sec = stop.estimated_arrival_epoch_sec + stop.service_duration_sec + return_to_hub_travel_sec
        if finish_sec > shift_end_epoch_sec:
            return True
    return False


def _build_placed_nodes(
    onboard_items: Sequence[PlacedOnboardItem],
) -> Dict[str, _PlacedNode]:
    by_id: Dict[str, PlacedOnboardItem] = {entry.item.id: entry for entry in onboard_items}
    ancestors_cache: Dict[str, Tuple[str, ...]] = {}

    def resolve_ancestors(iid: str, seen: Set[str]) -> Tuple[str, ...]:
        if iid in ancestors_cache:
            return ancestors_cache[iid]
        entry = by_id.get(iid)
        sup_id = entry.support_item_id if entry is not None else None
        if not sup_id or sup_id not in by_id or sup_id in seen:
            ancestors_cache[iid] = ()
            return ()
        chain = (sup_id, *resolve_ancestors(sup_id, seen | {sup_id}))
        ancestors_cache[iid] = chain
        return chain

    nodes: Dict[str, _PlacedNode] = {}
    for entry in onboard_items:
        ancs = resolve_ancestors(entry.item.id, {entry.item.id})
        l_cm = float(entry.placed_length_cm if entry.placed_length_cm is not None else entry.item.length_cm)
        w_cm = float(entry.placed_width_cm if entry.placed_width_cm is not None else entry.item.width_cm)
        h_cm = float(entry.placed_height_cm if entry.placed_height_cm is not None else entry.item.height_cm)
        placed = PlacedItem(
            item_id=entry.item.id,
            order_id=entry.item.order_id,
            x=float(entry.x or 0.0),
            y=float(entry.y or 0.0),
            z=float(entry.z or 0.0),
            length_cm=l_cm,
            width_cm=w_cm,
            height_cm=h_cm,
            weight_kg=float(entry.item.weight_kg),
            support_item_id=entry.support_item_id if entry.support_item_id in by_id else None,
            cargo_kind=entry.item.cargo_kind,
            no_top_load_requested=entry.item.no_top_load_requested,
            floor_rotation_locked=is_floor_rotation_locked(entry.item),
        )
        nodes[entry.item.id] = _PlacedNode(
            placed=placed,
            item=entry.item,
            tier=len(ancs) + 1,
            ancestors=ancs,
        )
    return nodes


def _try_unload_stop_items(
    validator: SpatialValidator,
    onboard: Mapping[str, _PlacedNode],
    unload_ids: Sequence[str],
) -> Tuple[bool, List[str], List[str]]:
    """Verify stop items can leave the truck without unloading any unrelated cargo."""
    unique_ids = list(dict.fromkeys(unload_ids))
    missing = [iid for iid in unique_ids if iid not in onboard]
    if missing:
        return False, [], missing

    def search(cur: Dict[str, _PlacedNode], remaining: Tuple[str, ...]) -> Optional[List[str]]:
        if not remaining:
            return []
        children_count, _ = _compute_children_and_above(cur)
        candidates = sorted(
            (iid for iid in remaining if children_count.get(iid, 0) == 0),
            key=lambda iid: (cur[iid].tier, cur[iid].placed.x + cur[iid].placed.length_cm, iid),
            reverse=True,
        )
        for iid in candidates:
            node = cur[iid]
            ignored = {iid, *node.ancestors}
            obstacles = [n.placed for oid, n in cur.items() if oid not in ignored]
            if not validator.is_path_to_door_clear(node.placed, obstacles)[0]:
                continue
            nxt = dict(cur)
            del nxt[iid]
            suffix = search(nxt, tuple(x for x in remaining if x != iid))
            if suffix is not None:
                return [iid] + suffix
        return None

    sequence = search(dict(onboard), tuple(unique_ids))
    if sequence is not None:
        return True, sequence, []

    _, _ = _compute_children_and_above(onboard)
    descendants: Dict[str, Set[str]] = {iid: set() for iid in onboard}
    for iid, node in onboard.items():
        for anc_id in node.ancestors:
            if anc_id in descendants:
                descendants[anc_id].add(iid)

    unload_set = set(unique_ids)
    blockers: Set[str] = set()
    for iid in unique_ids:
        node = onboard[iid]
        for above_id in descendants.get(iid, set()):
            if above_id not in unload_set:
                blockers.add(above_id)
        ignored = {iid, *node.ancestors}
        obstacles = [n.placed for oid, n in onboard.items() if oid not in ignored]
        for obs in obstacles:
            if obs.item_id not in unload_set and validator._blocks_straight_path(node.placed, obs):
                blockers.add(obs.item_id)
    if not blockers:
        for oid, node in onboard.items():
            if oid not in unload_set:
                blockers.add(oid)
    return False, [], sorted(blockers)


def _is_placement_unload_safe(
    validator: SpatialValidator,
    cand_placed: PlacedItem,
    cand_ancestors: Tuple[str, ...],
    onboard: Mapping[str, _PlacedNode],
    unload_step: Mapping[str, int],
    default_step: int,
) -> bool:
    cand_step = unload_step.get(cand_placed.item_id, default_step)
    ignored_cand = set(cand_ancestors)
    later_obstacles = [
        node.placed
        for oid, node in onboard.items()
        if oid not in ignored_cand and unload_step.get(oid, default_step) > cand_step
    ]
    if later_obstacles and not validator.is_path_to_door_clear(cand_placed, later_obstacles)[0]:
        return False

    for oid, earlier in onboard.items():
        earlier_step = unload_step.get(oid, default_step)
        if earlier_step < cand_step:
            if oid in ignored_cand:
                return False
            earlier_ignored = {oid, *earlier.ancestors}
            blockers = [
                node.placed
                for bid, node in onboard.items()
                if bid not in earlier_ignored and unload_step.get(bid, default_step) > earlier_step
            ] + [cand_placed]
            if not validator.is_path_to_door_clear(earlier.placed, blockers)[0]:
                return False
    return True


def _try_place_unpicked_items(
    validator: SpatialValidator,
    vehicle: VehicleFloor,
    policy: Optional[DemoStackingPolicy],
    onboard: Mapping[str, _PlacedNode],
    items: Sequence[CargoItem],
    unload_step: Mapping[str, int],
    default_step: int,
    max_future_unload: Optional[int],
) -> Optional[Dict[str, _PlacedNode]]:
    ordered = sorted(
        items,
        key=lambda it: (
            -unload_step.get(it.id, default_step),
            -it.weight_kg,
            -(it.length_cm * it.width_cm),
            it.id,
        ),
    )

    def place_rec(idx: int, cur: Dict[str, _PlacedNode]) -> Optional[Dict[str, _PlacedNode]]:
        if idx >= len(ordered):
            return cur
        item = ordered[idx]
        cur_w = sum(n.placed.weight_kg for n in cur.values())
        if cur_w + float(item.weight_kg) > float(vehicle.payload_limit_kg) + _EPS:
            return None

        candidates: List[Tuple[Optional[str], Tuple[str, ...], float, float, float, float, float]] = []
        if policy is not None and policy.max_tiers > 1:
            _, above_weight = _compute_children_and_above(cur)
            for base_node in sorted(cur.values(), key=lambda n: (n.tier, n.placed.z, n.placed.item_id)):
                if not _ancestors_can_support(
                    base_node,
                    item,
                    cur,
                    above_weight,
                    unload_step,
                    policy,
                    float(vehicle.height_cm),
                ):
                    continue
                for cx, cy, cz, cl, cw in _deck_candidates_on_base(
                    item,
                    base_node,
                    cur,
                    vehicle,
                    prefer_door=True,
                ):
                    candidates.append((base_node.placed.item_id, base_node.ancestors, cx, cy, cz, cl, cw))

        floor_items = [n.placed for n in cur.values() if n.tier == 1]
        floor_cands = validator._candidate_placements(
            item,
            floor_items,
            unload_step=unload_step.get(item.id, default_step),
            max_unload_step=max_future_unload,
            allow_door_placement=False,
            cargo_kind_by_id={nid: n.item.cargo_kind for nid, n in cur.items()},
            has_remaining_cargo=idx + 1 < len(ordered),
        )
        for fx, fy, fl, fw in floor_cands:
            if vehicle.door_width_cm is not None and fw > float(vehicle.door_width_cm) + _EPS:
                continue
            candidates.append((None, (), fx, fy, 0.0, fl, fw))

        for sup_id, sup_ancs, cx, cy, cz, cl, cw in candidates:
            placed_item = PlacedItem(
                item_id=item.id,
                order_id=item.order_id,
                x=cx,
                y=cy,
                z=cz,
                length_cm=cl,
                width_cm=cw,
                height_cm=float(item.height_cm),
                weight_kg=float(item.weight_kg),
                support_item_id=sup_id,
                cargo_kind=item.cargo_kind,
                no_top_load_requested=item.no_top_load_requested,
                floor_rotation_locked=is_floor_rotation_locked(item),
            )
            ancs = (sup_id, *sup_ancs) if sup_id else ()
            obstacles = [n.placed for oid, n in cur.items() if oid not in {item.id, *ancs}]
            if not validator.is_path_to_door_clear(placed_item, obstacles)[0]:
                continue
            if not _is_placement_unload_safe(validator, placed_item, ancs, cur, unload_step, default_step):
                continue
            nxt = dict(cur)
            nxt[item.id] = _PlacedNode(
                placed=placed_item,
                item=item,
                tier=(cur[sup_id].tier + 1 if sup_id else 1),
                ancestors=ancs,
            )
            solved = place_rec(idx + 1, nxt)
            if solved is not None:
                return solved
        return None

    return place_rec(0, dict(onboard))


def _evaluate_without_exact_placements(
    request: InProgressEvaluationRequest,
    validator: SpatialValidator,
    stops_sorted: Sequence[RemainingRouteStop],
) -> InProgressEvaluationResponse:
    """Fallback evaluator when a manually created trip has no prior LoadPlan coordinates."""
    onboard_by_id = {entry.item.id: entry for entry in request.onboard_items}
    delivery_by_order: Dict[str, RemainingRouteStop] = {
        s.order_id: s for s in stops_sorted if s.stop_type == "DELIVERY"
    }
    detached_orders: Set[str] = set()
    return_stop_ids: Set[str] = set()
    reason_by_stop: Dict[str, Tuple[str, str]] = {}

    for stop in stops_sorted:
        if _outside_time_limit(stop, request.shift_end_epoch_sec, request.return_to_hub_travel_sec):
            if stop.stop_type == "PICKUP":
                detached_orders.add(stop.order_id)
                reason_by_stop[stop.stop_id] = (
                    "OUTSIDE_SHIFT_WINDOW",
                    "Vượt khung giờ giao/nhận hoặc cuối ca sau khi xử lý đơn gặp sự cố.",
                )
            elif any(iid in onboard_by_id for iid in stop.item_ids):
                return_stop_ids.add(stop.stop_id)
                reason_by_stop[stop.stop_id] = (
                    "OUTSIDE_SHIFT_WINDOW",
                    "Không kịp khung giờ giao hoặc cuối ca; giữ hàng chở về kho.",
                )
            else:
                detached_orders.add(stop.order_id)
                reason_by_stop[stop.stop_id] = (
                    "OUTSIDE_SHIFT_WINDOW",
                    "Đơn chưa lấy vượt khung giờ/cuối ca; tách khỏi chuyến để bố trí xe rảnh.",
                )

    for order_id in list(detached_orders):
        for stop in stops_sorted:
            if stop.order_id == order_id:
                reason_by_stop.setdefault(
                    stop.stop_id,
                    (
                        "OUTSIDE_SHIFT_WINDOW",
                        "Đơn chưa lấy bị tách khỏi chuyến do vượt khung giờ/cuối ca.",
                    ),
                )

    def check_subplan(candidate_detached: Set[str]) -> bool:
        ret_ids = {
            entry.item.id
            for entry in request.onboard_items
            if entry.retained or (entry.unload_stop_id in return_stop_ids)
        }
        onboard_unload_ids: Set[str] = {
            iid
            for stop in stops_sorted
            if stop.stop_type == "DELIVERY"
            and stop.stop_id not in return_stop_ids
            and stop.order_id not in candidate_detached
            for iid in stop.item_ids
            if iid in onboard_by_id
        }
        all_end_unload = [entry.item.id for entry in request.onboard_items if entry.item.id not in onboard_unload_ids]
        synth_stops: List[StopAction] = []
        if request.onboard_items:
            synth_stops.append(
                StopAction(
                    stop_id="ONBOARD_SNAPSHOT",
                    sequence=0,
                    stop_type="PICKUP",
                    address="Hàng đang trên xe",
                    items_to_load=[entry.item for entry in request.onboard_items],
                )
            )
        seq = 1
        for stop in stops_sorted:
            if stop.stop_id in return_stop_ids or stop.order_id in candidate_detached:
                continue
            synth_stops.append(
                StopAction(
                    stop_id=stop.stop_id,
                    sequence=seq,
                    stop_type=stop.stop_type,
                    address=stop.order_number or stop.order_id,
                    items_to_load=list(stop.items_to_load) if stop.stop_type == "PICKUP" else [],
                    items_to_unload=list(stop.item_ids) if stop.stop_type == "DELIVERY" else [],
                )
            )
            seq += 1
        if all_end_unload or ret_ids:
            synth_stops.append(
                StopAction(
                    stop_id="RETURN_DEPOT_SYNTHETIC",
                    sequence=seq,
                    stop_type="DELIVERY",
                    address="Trả về kho",
                    items_to_unload=all_end_unload,
                )
            )
        if not synth_stops:
            return True
        if request.demo_stacking is None:
            res = validator.validate_plan(synth_stops)
        else:
            res = DemoStacks(request.demo_stacking, [request.vehicle]).validate_stops(validator, synth_stops)
        return res.is_valid

    unpicked_orders_rev = [
        s.order_id
        for s in reversed(stops_sorted)
        if s.stop_type == "PICKUP" and s.order_id not in detached_orders
    ]
    for oid in unpicked_orders_rev:
        if check_subplan(detached_orders):
            break
        detached_orders.add(oid)
        for stop in stops_sorted:
            if stop.order_id == oid:
                reason_by_stop[stop.stop_id] = (
                    "INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
                    "Không đủ tải/thể tích hoặc bị hàng hoàn giữ trên xe cản; tách đơn cho xe rảnh.",
                )

    stop_decisions: List[EvaluatedStopDecision] = []
    keep_delivery_stop_ids: List[str] = []
    return_to_hub_stop_ids: List[str] = []
    return_to_hub_item_ids: Set[str] = {
        entry.item.id for entry in request.onboard_items if entry.retained
    }

    for stop in stops_sorted:
        if stop.stop_type == "PICKUP" or stop.order_id in detached_orders:
            if stop.order_id in detached_orders:
                code, msg = reason_by_stop.get(
                    stop.stop_id,
                    (
                        "INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
                        "Tách đơn chưa lấy khỏi chuyến để bố trí xe rảnh.",
                    ),
                )
                stop_decisions.append(
                    EvaluatedStopDecision(
                        stop_id=stop.stop_id,
                        sequence=stop.sequence,
                        stop_type=stop.stop_type,
                        order_id=stop.order_id,
                        decision="DETACH_TO_FREE_VEHICLE",
                        reason_code=code,  # type: ignore[arg-type]
                        reason_message=msg,
                    )
                )
            else:
                stop_decisions.append(
                    EvaluatedStopDecision(
                        stop_id=stop.stop_id,
                        sequence=stop.sequence,
                        stop_type=stop.stop_type,
                        order_id=stop.order_id,
                        decision="KEEP_PICKUP",
                        reason_code="CLEAR",
                    )
                )
            continue

        if stop.stop_id in return_stop_ids:
            return_to_hub_stop_ids.append(stop.stop_id)
            for iid in stop.item_ids:
                return_to_hub_item_ids.add(iid)
            code, msg = reason_by_stop.get(
                stop.stop_id,
                ("OUTSIDE_SHIFT_WINDOW", "Giữ hàng chở về kho."),
            )
            stop_decisions.append(
                EvaluatedStopDecision(
                    stop_id=stop.stop_id,
                    sequence=stop.sequence,
                    stop_type=stop.stop_type,
                    order_id=stop.order_id,
                    decision="RETURN_TO_HUB",
                    reason_code=code,  # type: ignore[arg-type]
                    reason_message=msg,
                )
            )
        else:
            keep_delivery_stop_ids.append(stop.stop_id)
            stop_decisions.append(
                EvaluatedStopDecision(
                    stop_id=stop.stop_id,
                    sequence=stop.sequence,
                    stop_type=stop.stop_type,
                    order_id=stop.order_id,
                    decision="KEEP_DELIVER",
                    reason_code="CLEAR",
                    unload_sequence=list(stop.item_ids),
                )
            )

    diagnostics = [
        "Trip không có bản đồ xếp hàng 3D chi tiết trước đó; đã kiểm tra bằng tái thẩm định tải/thể tích."
    ]
    return InProgressEvaluationResponse(
        trip_id=request.trip_id,
        used_exact_placements=False,
        stop_decisions=stop_decisions,
        keep_delivery_stop_ids=keep_delivery_stop_ids,
        return_to_hub_stop_ids=return_to_hub_stop_ids,
        return_to_hub_item_ids=sorted(return_to_hub_item_ids),
        detached_order_ids=sorted(detached_orders),
        diagnostics=diagnostics,
    )


def evaluate_inprogress_trip(
    request: InProgressEvaluationRequest,
) -> InProgressEvaluationResponse:
    """Evaluate remaining onboard deliveries and unpicked orders under exact A1+A2 3D rules."""
    stops_sorted = sorted(request.remaining_stops, key=lambda s: (s.sequence, s.stop_id))
    validator = SpatialValidator(request.vehicle)

    has_exact = bool(request.onboard_items) and all(
        entry.x is not None
        and entry.y is not None
        and entry.z is not None
        for entry in request.onboard_items
    )
    if request.onboard_items and not has_exact:
        return _evaluate_without_exact_placements(request, validator, stops_sorted)

    retained_ids: Set[str] = {entry.item.id for entry in request.onboard_items if entry.retained}
    initial_onboard_ids: Set[str] = {entry.item.id for entry in request.onboard_items}
    forced_detached_orders: Set[str] = set()
    forced_detach_reasons: Dict[str, Tuple[str, str]] = {}

    def simulate(
        detached_set: Set[str],
    ) -> Tuple[List[EvaluatedStopDecision], List[str], List[str], Set[str], Optional[str]]:
        onboard = _build_placed_nodes(request.onboard_items)
        default_step = len(stops_sorted) + 1
        unload_step: Dict[str, int] = {
            iid: default_step for iid in retained_ids
        }
        stop_index_by_order_deliv: Dict[str, int] = {
            s.order_id: idx for idx, s in enumerate(stops_sorted) if s.stop_type == "DELIVERY"
        }
        for idx, s in enumerate(stops_sorted):
            if s.stop_type == "DELIVERY":
                for iid in s.item_ids:
                    if iid not in retained_ids:
                        unload_step[iid] = idx

        decisions: List[EvaluatedStopDecision] = []
        keep_deliv_ids: List[str] = []
        return_stop_ids: List[str] = []
        return_item_ids: Set[str] = set(retained_ids)
        rollback_order_id: Optional[str] = None

        for idx, stop in enumerate(stops_sorted):
            if stop.stop_type == "PICKUP":
                if stop.order_id in detached_set:
                    rcode, rmsg = forced_detach_reasons.get(
                        stop.order_id,
                        (
                            "INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
                            "Đơn chưa lấy không đủ chỗ/giờ khi còn hàng hoàn trên xe; tách cho xe rảnh.",
                        ),
                    )
                    decisions.append(
                        EvaluatedStopDecision(
                            stop_id=stop.stop_id,
                            sequence=stop.sequence,
                            stop_type="PICKUP",
                            order_id=stop.order_id,
                            decision="DETACH_TO_FREE_VEHICLE",
                            reason_code=rcode,  # type: ignore[arg-type]
                            reason_message=rmsg,
                        )
                    )
                    continue

                deliv_idx = stop_index_by_order_deliv.get(stop.order_id)
                deliv_stop = stops_sorted[deliv_idx] if deliv_idx is not None else None
                pickup_late = _outside_time_limit(
                    stop, request.shift_end_epoch_sec, request.return_to_hub_travel_sec
                )
                deliv_late = (
                    deliv_stop is not None
                    and _outside_time_limit(
                        deliv_stop, request.shift_end_epoch_sec, request.return_to_hub_travel_sec
                    )
                )
                if pickup_late or deliv_late:
                    detached_set.add(stop.order_id)
                    msg = "Đơn chưa lấy không kịp khung giờ hoặc vượt cuối ca làm việc."
                    forced_detach_reasons[stop.order_id] = ("OUTSIDE_SHIFT_WINDOW", msg)
                    decisions.append(
                        EvaluatedStopDecision(
                            stop_id=stop.stop_id,
                            sequence=stop.sequence,
                            stop_type="PICKUP",
                            order_id=stop.order_id,
                            decision="DETACH_TO_FREE_VEHICLE",
                            reason_code="OUTSIDE_SHIFT_WINDOW",
                            reason_message=msg,
                        )
                    )
                    continue

                items_to_load = list(stop.items_to_load)
                if not items_to_load:
                    detached_set.add(stop.order_id)
                    msg = "Thiếu kích thước kiện để kiểm tra xếp 3D cùng hàng hoàn."
                    forced_detach_reasons[stop.order_id] = ("INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO", msg)
                    decisions.append(
                        EvaluatedStopDecision(
                            stop_id=stop.stop_id,
                            sequence=stop.sequence,
                            stop_type="PICKUP",
                            order_id=stop.order_id,
                            decision="DETACH_TO_FREE_VEHICLE",
                            reason_code="INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
                            reason_message=msg,
                        )
                    )
                    continue

                future_steps = [
                    unload_step.get(iid, default_step)
                    for future_s in stops_sorted[idx + 1 :]
                    for iid in future_s.item_ids
                ] + [default_step]
                max_future = max(future_steps, default=default_step)

                placed_nxt = _try_place_unpicked_items(
                    validator=validator,
                    vehicle=request.vehicle,
                    policy=request.demo_stacking,
                    onboard=onboard,
                    items=items_to_load,
                    unload_step=unload_step,
                    default_step=default_step,
                    max_future_unload=max_future,
                )
                if placed_nxt is None:
                    detached_set.add(stop.order_id)
                    msg = "Hàng hoàn giữ trên xe chiếm tải/lối xếp 3D; tách đơn chưa lấy cho xe rảnh."
                    forced_detach_reasons[stop.order_id] = ("INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO", msg)
                    decisions.append(
                        EvaluatedStopDecision(
                            stop_id=stop.stop_id,
                            sequence=stop.sequence,
                            stop_type="PICKUP",
                            order_id=stop.order_id,
                            decision="DETACH_TO_FREE_VEHICLE",
                            reason_code="INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
                            reason_message=msg,
                        )
                    )
                    continue

                onboard = placed_nxt
                decisions.append(
                    EvaluatedStopDecision(
                        stop_id=stop.stop_id,
                        sequence=stop.sequence,
                        stop_type="PICKUP",
                        order_id=stop.order_id,
                        decision="KEEP_PICKUP",
                        reason_code="CLEAR",
                    )
                )
                continue

            # DELIVERY stop
            if stop.order_id in detached_set:
                rcode, rmsg = forced_detach_reasons.get(
                    stop.order_id,
                    (
                        "INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
                        "Đơn chưa lấy đã tách khỏi chuyến.",
                    ),
                )
                decisions.append(
                    EvaluatedStopDecision(
                        stop_id=stop.stop_id,
                        sequence=stop.sequence,
                        stop_type="DELIVERY",
                        order_id=stop.order_id,
                        decision="DETACH_TO_FREE_VEHICLE",
                        reason_code=rcode,  # type: ignore[arg-type]
                        reason_message=rmsg,
                    )
                )
                continue

            belongs_to_initial_onboard = any(iid in initial_onboard_ids for iid in stop.item_ids)
            if _outside_time_limit(
                stop, request.shift_end_epoch_sec, request.return_to_hub_travel_sec
            ):
                if belongs_to_initial_onboard:
                    return_stop_ids.append(stop.stop_id)
                    return_item_ids.update(stop.item_ids)
                    for iid in stop.item_ids:
                        unload_step[iid] = default_step
                    decisions.append(
                        EvaluatedStopDecision(
                            stop_id=stop.stop_id,
                            sequence=stop.sequence,
                            stop_type="DELIVERY",
                            order_id=stop.order_id,
                            decision="RETURN_TO_HUB",
                            reason_code="OUTSIDE_SHIFT_WINDOW",
                            reason_message="Không kịp khung giờ/cuối ca sau sự cố giao hàng; chở về kho.",
                        )
                    )
                    continue
                rollback_order_id = stop.order_id
                forced_detach_reasons[stop.order_id] = (
                    "OUTSIDE_SHIFT_WINDOW",
                    "Giao hàng vượt khung giờ/cuối ca; tách đơn chưa lấy.",
                )
                break

            ok, unload_seq, blockers = _try_unload_stop_items(
                validator=validator,
                onboard=onboard,
                unload_ids=stop.item_ids,
            )
            if not ok:
                if belongs_to_initial_onboard:
                    return_stop_ids.append(stop.stop_id)
                    return_item_ids.update(stop.item_ids)
                    for iid in stop.item_ids:
                        unload_step[iid] = default_step
                    decisions.append(
                        EvaluatedStopDecision(
                            stop_id=stop.stop_id,
                            sequence=stop.sequence,
                            stop_type="DELIVERY",
                            order_id=stop.order_id,
                            decision="RETURN_TO_HUB",
                            reason_code="BLOCKED_BY_RETAINED_CARGO",
                            blocker_item_ids=blockers,
                            reason_message="Bị hàng hoàn giữ trên xe chắn lối/đè tầng trên; không hạ tạm lề đường, chở về kho.",
                        )
                    )
                    continue
                rollback_order_id = stop.order_id
                forced_detach_reasons[stop.order_id] = (
                    "BLOCKED_BY_RETAINED_CARGO",
                    "Đơn chưa lấy sẽ bị hàng hoàn chắn lối dỡ; tách cho xe rảnh.",
                )
                break

            for iid in unload_seq:
                onboard.pop(iid, None)
            keep_deliv_ids.append(stop.stop_id)
            decisions.append(
                EvaluatedStopDecision(
                    stop_id=stop.stop_id,
                    sequence=stop.sequence,
                    stop_type="DELIVERY",
                    order_id=stop.order_id,
                    decision="KEEP_DELIVER",
                    reason_code="CLEAR",
                    unload_sequence=unload_seq,
                )
            )

        return decisions, keep_deliv_ids, return_stop_ids, return_item_ids, rollback_order_id

    max_iters = len(stops_sorted) + 2
    decisions: List[EvaluatedStopDecision] = []
    keep_deliv_ids: List[str] = []
    return_stop_ids: List[str] = []
    return_item_ids: Set[str] = set(retained_ids)

    for _ in range(max_iters):
        decisions, keep_deliv_ids, return_stop_ids, return_item_ids, rollback_order_id = simulate(
            forced_detached_orders
        )
        if rollback_order_id is None:
            break
        forced_detached_orders.add(rollback_order_id)

    detached_order_ids = sorted(
        {
            d.order_id
            for d in decisions
            if d.decision == "DETACH_TO_FREE_VEHICLE"
        }
        | forced_detached_orders
    )
    return InProgressEvaluationResponse(
        trip_id=request.trip_id,
        used_exact_placements=True,
        stop_decisions=decisions,
        keep_delivery_stop_ids=keep_deliv_ids,
        return_to_hub_stop_ids=return_stop_ids,
        return_to_hub_item_ids=sorted(return_item_ids),
        detached_order_ids=detached_order_ids,
        diagnostics=[],
    )
