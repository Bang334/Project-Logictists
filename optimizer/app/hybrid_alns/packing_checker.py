"""Fast conservative 2D packing pre-check ported from algo_lab."""

from typing import Dict, List, Mapping, Optional, Sequence, Tuple, Union
from .models import CargoItem, FleetVehicle, PlacedItem, ScheduledStop
from ..models import CargoItem as ProductionCargo, DemoStackingPolicy, FleetVehicle as ProductionVehicle
from ..models import ScheduledStop as ProductionStop, StopAction, VehicleFloor
from ..packing_rules import resolve_can_rotate, score_candidate_balance_and_fragility
from ..stacking import fast_validate_stacked_route, validate_stop_actions


def bounded_spatial_fallback(
    vehicle: Union[FleetVehicle, ProductionVehicle],
    stops: Sequence[Union[ScheduledStop, ProductionStop]],
    cargo: Mapping[str, Union[CargoItem, ProductionCargo]],
    demo_stacking: Optional[DemoStackingPolicy] = None,
) -> bool:
    """Recover small greedy false negatives without accepting an unchecked plan.

    An orientation chosen for the first box can fragment the floor. A bounded
    layout search tries alternatives; exhausting the budget still rejects it.
    The size limit controls search overhead, not vehicle or customer policy.
    """
    ids = {cid for stop in stops for cid in stop.items_loaded}
    if not ids or len(ids) > 12 or len(stops) > 24 or not ids.issubset(cargo):
        return False
    actions = [StopAction(stop_id=f"{i}:{stop.location_id}", sequence=i+1,
        stop_type=stop.stop_type,
        items_to_load=[ProductionCargo(
            id=cargo[cid].id,
            order_id=cargo[cid].order_id,
            customer_id=getattr(cargo[cid], "customer_id", None),
            description=getattr(cargo[cid], "description", ""),
            length_cm=cargo[cid].length_cm,
            width_cm=cargo[cid].width_cm,
            height_cm=cargo[cid].height_cm,
            weight_kg=cargo[cid].weight_kg,
            can_rotate=resolve_can_rotate(cargo[cid]),
            allowed_orientations=getattr(cargo[cid], "allowed_orientations", None),
            cargo_kind=getattr(cargo[cid], "cargo_kind", "UNCLASSIFIED"),
            allow_upper_tier=bool(getattr(cargo[cid], "allow_upper_tier", False)),
            no_top_load_requested=bool(getattr(cargo[cid], "no_top_load_requested", False)),
            max_top_load_g=getattr(cargo[cid], "max_top_load_g", None),
        ) for cid in stop.items_loaded],
        items_to_unload=list(stop.items_unloaded)) for i,stop in enumerate(stops)]
    return validate_stop_actions(
        demo_stacking,
        vehicle,
        actions,
        max_search_nodes=256,
        max_time_seconds=0.02 if demo_stacking is not None else 0.01,
    ).is_valid


def is_box_overlap(
    x1: float, y1: float, l1: float, w1: float,
    x2: float, y2: float, l2: float, w2: float,
    eps: float = 0.01,
) -> bool:
    """Returns True if two 2D rectangles overlap."""
    if x1 + l1 <= x2 + eps or x2 + l2 <= x1 + eps:
        return False
    if y1 + w1 <= y2 + eps or y2 + w2 <= y1 + eps:
        return False
    return True


def is_path_to_door_clear(
    item: PlacedItem,
    floor_length: float,
    other_items: List[PlacedItem],
) -> Tuple[bool, Optional[str]]:
    """Checks whether the corridor from item's front edge to rear door is unblocked."""
    path_x = item.x + item.length_cm
    path_len = floor_length - path_x
    if path_len <= 0.01:
        return True, None

    for other in other_items:
        if other.item_id == item.item_id:
            continue
        if is_box_overlap(
            path_x, item.y, path_len, item.width_cm,
            other.x, other.y, other.length_cm, other.width_cm,
        ):
            return False, other.item_id
    return True, None


class FastPackingChecker:
    """Evaluates 2D packing feasibility for a sequence of stops on a vehicle."""

    def __init__(
        self,
        vehicle: FleetVehicle,
        *,
        allow_layout_search: bool = True,
        demo_stacking: Optional[DemoStackingPolicy] = None,
    ):
        self.vehicle = vehicle
        self.allow_layout_search = allow_layout_search
        self.demo_stacking = demo_stacking
        self.L = vehicle.length_cm
        self.W = vehicle.width_cm

    def find_placement(
        self,
        item: CargoItem,
        current_placed: List[PlacedItem],
        item_delivery_rank: int,
        delivery_ranks: Dict[str, int],
        strategy: str = "default",
    ) -> Optional[PlacedItem]:
        floor_area = self.L * self.W
        current_area = sum(p.length_cm * p.width_cm for p in current_placed)
        if current_area + (item.length_cm * item.width_cm) > floor_area + 0.01:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if resolve_can_rotate(item) and abs(item.length_cm - item.width_cm) > 0.01:
            orientations.append((item.width_cm, item.length_cm))

        candidate_points = {(0.0, 0.0)}
        for p in current_placed:
            if p.x + p.length_cm <= self.L:
                candidate_points.add((p.x + p.length_cm, p.y))
                candidate_points.add((p.x + p.length_cm, 0.0))
                candidate_points.add((p.x + p.length_cm, p.y + p.width_cm))
            if p.y + p.width_cm <= self.W:
                candidate_points.add((p.x, p.y + p.width_cm))
                candidate_points.add((0.0, p.y + p.width_cm))

        # Add wall-hugging anchor points along the far curb (y = W - w)
        for l, w in orientations:
            if w <= self.W:
                candidate_points.add((0.0, self.W - w))
                for p in current_placed:
                    if p.x + p.length_cm <= self.L:
                        candidate_points.add((p.x + p.length_cm, self.W - w))

        best_candidate: Optional[PlacedItem] = None
        best_score = float("inf")
        cargo_kind_by_id = {
            p.item_id: getattr(p, "cargo_kind", "UNCLASSIFIED") for p in current_placed
        }
        item_kind = getattr(item, "cargo_kind", "UNCLASSIFIED")

        for l, w in orientations:
            if item.height_cm > self.vehicle.height_cm + 0.01:
                continue
            for x, y in candidate_points:
                if x + l > self.L + 0.01 or y + w > self.W + 0.01:
                    continue

                overlap = any(
                    is_box_overlap(x, y, l, w, p.x, p.y, p.length_cm, p.width_cm)
                    for p in current_placed
                )
                if overlap:
                    continue

                cand = PlacedItem(
                    item_id=item.id,
                    order_id=item.order_id,
                    x=x,
                    y=y,
                    length_cm=l,
                    width_cm=w,
                    weight_kg=float(item.weight_kg),
                    cargo_kind=item_kind,
                )

                ingress_clear, _ = is_path_to_door_clear(
                    cand, self.L, current_placed + [cand]
                )
                if not ingress_clear:
                    continue

                cand_list = current_placed + [cand]
                blocked_order = False
                for existing in current_placed:
                    ex_rank = delivery_ranks.get(existing.order_id, 999999)
                    if ex_rank < item_delivery_rank:
                        clear, _ = is_path_to_door_clear(existing, self.L, cand_list)
                        if not clear:
                            blocked_order = True
                            break
                    elif ex_rank > item_delivery_rank:
                        clear, _ = is_path_to_door_clear(cand, self.L, cand_list)
                        if not clear:
                            blocked_order = True
                            break
                if blocked_order:
                    continue

                # Evaluate corridor clearance, lateral weight balance, and fragile separation.
                lat_imb, fragile_adj = score_candidate_balance_and_fragility(
                    cand_x=x,
                    cand_y=y,
                    cand_l=l,
                    cand_w=w,
                    cand_weight_kg=float(item.weight_kg),
                    cand_cargo_kind=item_kind,
                    current_placed=current_placed,
                    cargo_kind_by_id=cargo_kind_by_id,
                    floor_length_cm=self.L,
                    floor_width_cm=self.W,
                )
                if strategy == "default":
                    corridor_penalty = 150.0 if (y > 0.01 and y + w < self.W - 0.01) else 0.0
                    score = x * 1000.0 + corridor_penalty + lat_imb * 120.0 + fragile_adj * 140.0 + y * 0.05
                else:
                    # Keep overlapping deliveries in separate longitudinal y-lanes for FIFO clearance.
                    diff_y = any(
                        delivery_ranks.get(p.order_id, 999999) != item_delivery_rank
                        and not (y + w <= p.y + 0.01 or p.y + p.width_cm <= y + 0.01)
                        for p in current_placed
                    )
                    y_pref = (y + w) if strategy == "lane_y_left" else (self.W - y)
                    score = (1_000_000.0 if diff_y else 0.0) + y_pref * 1000.0 + x * 10.0 + lat_imb * 20.0 + fragile_adj * 25.0
                if score < best_score:
                    best_score = score
                    best_candidate = cand

        return best_candidate

    def validate_route_stops(
        self, stops: List[ScheduledStop], cargo_items_by_id: Dict[str, CargoItem],
    ) -> Tuple[bool, str]:
        if self.demo_stacking is not None:
            return fast_validate_stacked_route(
                self.vehicle,
                stops,
                cargo_items_by_id,
                self.demo_stacking,
                allow_layout_search=self.allow_layout_search,
            )
        valid, reason = self._validate_greedy_route_stops(stops, cargo_items_by_id, strategy="default")
        if valid:
            return valid, reason
        order_count = len({s.order_id for s in stops if s.order_id})
        if order_count > 1:
            for strategy in ("lane_y_left", "lane_y_right"):
                alt_valid, alt_reason = self._validate_greedy_route_stops(
                    stops, cargo_items_by_id, strategy=strategy
                )
                if alt_valid:
                    return alt_valid, alt_reason
        if len(stops) <= 12 or self.allow_layout_search:
            valid_dyn, dyn_reason = self._validate_dynamic_lifo_route_stops(stops, cargo_items_by_id)
            if valid_dyn:
                return True, "Hợp lệ theo LIFO động"
        if self.allow_layout_search and bounded_spatial_fallback(self.vehicle, stops, cargo_items_by_id):
            return True, "Hợp lệ sau tìm kiếm bố trí có giới hạn"
        return False, reason

    def _validate_dynamic_lifo_route_stops(
        self,
        stops: List[ScheduledStop],
        cargo_items_by_id: Dict[str, CargoItem],
    ) -> Tuple[bool, str]:
        placed_boxes: List[Dict] = []
        onboard_weight = 0.0

        for stop in stops:
            if stop.stop_type == "PICKUP":
                for item_id in stop.items_loaded:
                    item = cargo_items_by_id.get(item_id)
                    if not item:
                        continue
                    onboard_weight += item.weight_kg
                    if onboard_weight > self.vehicle.payload_limit_kg + 0.01:
                        return False, "Vượt tải trọng xe"
                    if item.height_cm > self.vehicle.height_cm + 0.01:
                        return False, "Vượt chiều cao thùng"

                    box_placed = self._place_dynamic_box(item, placed_boxes)
                    if box_placed is None:
                        return False, "Không đủ diện tích sàn"
                    placed_boxes.append(box_placed)

            elif stop.stop_type == "DELIVERY":
                target_boxes = [b for b in placed_boxes if b["id"] in stop.items_unloaded]
                target_boxes.sort(key=lambda b: b["x"] + b["l"], reverse=True)
                for target_box in target_boxes:
                    for other in placed_boxes:
                        if other["id"] == target_box["id"]:
                            continue
                        if other["x"] > target_box["x"] + 0.01:
                            if not (other["y"] + other["w"] <= target_box["y"] + 0.01 or other["y"] >= target_box["y"] + target_box["w"] - 0.01):
                                return False, "Bị hàng dỡ sau chặn lối ra cửa đuôi"
                    placed_boxes = [b for b in placed_boxes if b["id"] != target_box["id"]]
                    item = cargo_items_by_id.get(target_box["id"])
                    if item:
                        onboard_weight = max(0.0, onboard_weight - item.weight_kg)

        if placed_boxes:
            return False, "Còn hàng chưa dỡ"
        return True, "Hợp lệ"

    def _place_dynamic_box(self, item: CargoItem, placed_boxes: List[Dict]) -> Optional[Dict]:
        total_used_area = sum(b["l"] * b["w"] for b in placed_boxes)
        box_area = item.length_cm * item.width_cm
        if total_used_area + box_area > self.L * self.W + 0.01:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if resolve_can_rotate(item) and abs(item.length_cm - item.width_cm) > 0.01:
            orientations.append((item.width_cm, item.length_cm))

        candidate_positions = {(0.0, 0.0)}
        for b in placed_boxes:
            if b["x"] + b["l"] <= self.L:
                candidate_positions.add((b["x"] + b["l"], b["y"]))
                candidate_positions.add((b["x"] + b["l"], 0.0))
            if b["y"] + b["w"] <= self.W:
                candidate_positions.add((b["x"], b["y"] + b["w"]))
                candidate_positions.add((0.0, b["y"] + b["w"]))

        for l_dim, w_dim in orientations:
            if w_dim <= self.W:
                candidate_positions.add((0.0, self.W - w_dim))
                for b in placed_boxes:
                    if b["x"] + b["l"] <= self.L:
                        candidate_positions.add((b["x"] + b["l"], self.W - w_dim))

        sorted_positions = sorted(candidate_positions, key=lambda p: (p[0], p[1]))

        for l_dim, w_dim in orientations:
            if l_dim > self.L + 0.01 or w_dim > self.W + 0.01:
                continue
            for x_cand, y_cand in sorted_positions:
                if x_cand + l_dim <= self.L + 0.01 and y_cand + w_dim <= self.W + 0.01:
                    overlap = any(
                        is_box_overlap(x_cand, y_cand, l_dim, w_dim, other["x"], other["y"], other["l"], other["w"])
                        for other in placed_boxes
                    )
                    if not overlap:
                        clear, _ = is_path_to_door_clear(
                            PlacedItem(item_id=item.id, order_id=item.order_id, x=x_cand, y=y_cand, length_cm=l_dim, width_cm=w_dim),
                            self.L,
                            [PlacedItem(item_id=b["id"], order_id=b["order_id"], x=b["x"], y=b["y"], length_cm=b["l"], width_cm=b["w"]) for b in placed_boxes]
                            + [PlacedItem(item_id=item.id, order_id=item.order_id, x=x_cand, y=y_cand, length_cm=l_dim, width_cm=w_dim)]
                        )
                        if clear:
                            return {
                                "id": item.id,
                                "order_id": item.order_id,
                                "x": x_cand,
                                "y": y_cand,
                                "l": l_dim,
                                "w": w_dim,
                            }
        return None

    def _validate_greedy_route_stops(
        self,
        stops: List[ScheduledStop],
        cargo_items_by_id: Dict[str, CargoItem],
        strategy: str = "default",
    ) -> Tuple[bool, str]:
        current_placed: List[PlacedItem] = []
        loaded_item_ids = set()

        delivery_ranks: Dict[str, int] = {}
        deliv_idx = 0
        for stop in stops:
            if stop.stop_type == "DELIVERY" and stop.order_id:
                if stop.order_id not in delivery_ranks:
                    delivery_ranks[stop.order_id] = deliv_idx
                    deliv_idx += 1

        for stop in stops:
            if stop.stop_type == "PICKUP":
                # LIFO-guided loading order: items with higher delivery rank (delivering later)
                # are loaded first so they sit deeper inside the truck bed.
                items_to_load = sorted(
                    stop.items_loaded,
                    key=lambda i_id: (
                        delivery_ranks.get(
                            cargo_items_by_id[i_id].order_id if i_id in cargo_items_by_id else "", -1
                        ),
                        0 if (i_id in cargo_items_by_id and getattr(cargo_items_by_id[i_id], "cargo_kind", "UNCLASSIFIED") == "FRAGILE") else 1,
                        cargo_items_by_id[i_id].weight_kg if i_id in cargo_items_by_id else 0.0,
                        cargo_items_by_id[i_id].length_cm * cargo_items_by_id[i_id].width_cm if i_id in cargo_items_by_id else 0,
                    ),
                    reverse=True,
                )
                for item_id in items_to_load:
                    item = cargo_items_by_id.get(item_id)
                    if not item:
                        return False, f"Không tìm thấy dữ liệu kiện {item_id}"
                    if item_id in loaded_item_ids:
                        return False, f"Kiện {item_id} bị bốc lên nhiều lần"
                    if (
                        item.length_cm <= 0
                        or item.width_cm <= 0
                        or item.height_cm <= 0
                        or item.weight_kg <= 0
                    ):
                        return False, f"Kiện {item_id} có kích thước hoặc khối lượng không hợp lệ"
                    if item.height_cm > self.vehicle.height_cm + 0.01:
                        return (
                            False,
                            f"Kiện {item.id} cao {item.height_cm} cm vượt chiều cao thùng {self.vehicle.height_cm} cm",
                        )
                    item_rank = delivery_ranks.get(item.order_id, 999999)
                    placed = self.find_placement(
                        item, current_placed, item_rank, delivery_ranks, strategy=strategy
                    )
                    if not placed:
                        return (
                            False,
                            f"Kiện {item.id} (đơn {item.order_id}) không tìm được chỗ đặt hợp lệ trên sàn xe {self.vehicle.plate_number}",
                        )
                    current_placed.append(placed)
                    loaded_item_ids.add(item_id)

            elif stop.stop_type == "DELIVERY":
                missing = [
                    item_id
                    for item_id in stop.items_unloaded
                    if item_id not in loaded_item_ids
                ]
                if missing:
                    return False, f"Dỡ kiện chưa có trên xe: {', '.join(missing)}"
                items_to_unload = [
                    p for p in current_placed if p.item_id in stop.items_unloaded
                ]
                items_to_unload.sort(key=lambda p: p.x + p.length_cm, reverse=True)

                for target in items_to_unload:
                    clear, blocker_id = is_path_to_door_clear(
                        target, self.L, current_placed
                    )
                    if not clear:
                        return (
                            False,
                            f"Kiện {target.item_id} bị kiện {blocker_id} chắn lối ra cửa thùng xe tại điểm dỡ {stop.location_name}",
                        )
                    current_placed.remove(target)
                    loaded_item_ids.remove(target.item_id)

            else:
                return False, f"Loại điểm dừng không hợp lệ: {stop.stop_type}"

        if current_placed:
            remaining = ", ".join(p.item_id for p in current_placed[:5])
            return False, f"Kết thúc tuyến vẫn còn hàng trên xe: {remaining}"

        return True, "Hợp lệ"
