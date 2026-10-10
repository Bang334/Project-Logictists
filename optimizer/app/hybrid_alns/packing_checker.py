"""Fast conservative 2D packing pre-check ported from algo_lab."""

from typing import Dict, List, Optional, Tuple
from .models import CargoItem, FleetVehicle, PlacedItem, ScheduledStop


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

    def __init__(self, vehicle: FleetVehicle):
        self.vehicle = vehicle
        self.L = vehicle.length_cm
        self.W = vehicle.width_cm

    def find_placement(
        self,
        item: CargoItem,
        current_placed: List[PlacedItem],
        item_delivery_rank: int,
        delivery_ranks: Dict[str, int],
    ) -> Optional[PlacedItem]:
        floor_area = self.L * self.W
        current_area = sum(p.length_cm * p.width_cm for p in current_placed)
        if current_area + (item.length_cm * item.width_cm) > floor_area + 0.01:
            return None

        orientations = [(item.length_cm, item.width_cm)]
        if item.can_rotate and item.length_cm != item.width_cm:
            orientations.append((item.width_cm, item.length_cm))

        candidate_points = {(0.0, 0.0)}
        for p in current_placed:
            if p.x + p.length_cm <= self.L:
                candidate_points.add((p.x + p.length_cm, p.y))
                candidate_points.add((p.x + p.length_cm, 0.0))
            if p.y + p.width_cm <= self.W:
                candidate_points.add((p.x, p.y + p.width_cm))
                candidate_points.add((0.0, p.y + p.width_cm))

        best_candidate: Optional[PlacedItem] = None
        best_score = float("inf")

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

                score = x * 1000 + y
                if score < best_score:
                    best_score = score
                    best_candidate = cand

        return best_candidate

    def validate_route_stops(
        self,
        stops: List[ScheduledStop],
        cargo_items_by_id: Dict[str, CargoItem],
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
                for item_id in stop.items_loaded:
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
                        item, current_placed, item_rank, delivery_ranks
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
