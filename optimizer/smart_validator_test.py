import json
import sys
sys.stdout.reconfigure(encoding='utf-8')

from app.models import VehicleFloor, CargoItem, PlacedItem, StopAction, SpatialValidationResult, FloorState
from typing import List, Dict, Optional, Tuple

class SmartSpatialValidator:
    """
    SpatialValidator nâng cấp với nhận thức về thứ tự dỡ hàng (Unload-Sequence Aware).
    Đảm bảo:
    1. Khi xếp kiện mới, không bao giờ đặt vào vị trí chắn lối ra của các kiện cần dỡ trước nó.
    2. Các kiện nạp cùng lúc được ưu tiên: hàng giao sau xếp vào trong (x nhỏ), hàng giao trước xếp ra ngoài (x lớn).
    3. Hỗ trợ tạo làn (lanes) song song trên sàn xe để chở nhiều đơn hàng cùng lúc mà không bị chắn.
    """
    def __init__(self, vehicle: VehicleFloor):
        self.vehicle = vehicle
        self.floor_length = vehicle.length_cm
        self.floor_width = vehicle.width_cm
        self.floor_height = vehicle.height_cm
        self.payload_limit = vehicle.payload_limit_kg
        self.total_floor_area = self.floor_length * self.floor_width

    def is_overlap(self, x1: float, y1: float, l1: float, w1: float,
                   x2: float, y2: float, l2: float, w2: float) -> bool:
        return not (
            x1 + l1 <= x2 + 0.01 or
            x2 + l2 <= x1 + 0.01 or
            y1 + w1 <= y2 + 0.01 or
            y2 + w2 <= y1 + 0.01
        )

    def is_path_to_door_clear(self, target_item: PlacedItem,
                              other_items: List[PlacedItem]) -> Tuple[bool, Optional[str]]:
        path_x_start = target_item.x + target_item.length_cm
        path_x_end = self.floor_length
        path_y_start = target_item.y
        path_y_end = target_item.y + target_item.width_cm

        for other in other_items:
            if other.item_id == target_item.item_id:
                continue
            if self.is_overlap(
                path_x_start, path_y_start, path_x_end - path_x_start, path_y_end - path_y_start,
                other.x, other.y, other.length_cm, other.width_cm
            ):
                return False, other.item_id

        return True, None

    def find_placement_position(self, item: CargoItem,
                                current_placed: List[PlacedItem],
                                item_unload_seq: int,
                                placed_unload_seq: Dict[str, int]) -> Optional[Tuple[float, float, float, float]]:
        """
        Tìm vị trí (x, y, l, w) thỏa mãn:
        1. Không đè lên kiện khác (T22).
        2. Lối đưa vào từ cửa xe không bị chặn (T26).
        3. QUAN TRỌNG: Vị trí đặt không được chắn lối ra cửa của bất kỳ kiện nào cần dỡ TRƯỚC kiện này!
        4. Kiện này không bị chắn bởi các kiện dỡ SAU nó!
        """
        orientations = [(item.length_cm, item.width_cm)]
        if item.can_rotate and item.length_cm != item.width_cm:
            orientations.append((item.width_cm, item.length_cm))

        x_candidates = {0.0}
        y_candidates = {0.0}
        for p in current_placed:
            x_candidates.add(p.x + p.length_cm)
            y_candidates.add(p.y + p.width_cm)
            x_candidates.add(p.x)
            y_candidates.add(p.y)

        # Nếu hàng giao sớm (dỡ trước), ưu tiên thử các vị trí ở làn bên hoặc gần cửa
        sorted_x = sorted([x for x in x_candidates if x <= self.floor_length])
        sorted_y = sorted([y for y in y_candidates if y <= self.floor_width])

        best_cand = None
        min_waste_score = float("inf")

        for l_cand, w_cand in orientations:
            if item.height_cm > self.floor_height:
                continue

            for x_cand in sorted_x:
                if x_cand + l_cand > self.floor_length:
                    continue
                for y_cand in sorted_y:
                    if y_cand + w_cand > self.floor_width:
                        continue

                    # 1. Không đè lên kiện khác
                    conflict = False
                    for other in current_placed:
                        if self.is_overlap(x_cand, y_cand, l_cand, w_cand,
                                           other.x, other.y, other.length_cm, other.width_cm):
                            conflict = True
                            break
                    if conflict:
                        continue

                    # 2. Đường đưa vào từ cửa không bị chặn
                    temp_placed = PlacedItem(
                        item_id=item.id,
                        order_id=item.order_id,
                        x=x_cand,
                        y=y_cand,
                        length_cm=l_cand,
                        width_cm=w_cand,
                        height_cm=item.height_cm,
                        weight_kg=item.weight_kg,
                    )
                    path_in_clear, _ = self.is_path_to_door_clear(temp_placed, current_placed)
                    if not path_in_clear:
                        continue

                    # 3. KIỂM TRA TƯƠNG QUAN DỠ HÀNG VỚI CÁC KIỆN ĐANG TRÊN XE:
                    # a) Kiện mới không được chắn đường dỡ của bất kỳ kiện nào dỡ TRƯỚC nó
                    blocks_earlier_item = False
                    for p in current_placed:
                        p_seq = placed_unload_seq.get(p.item_id, 999999)
                        if p_seq < item_unload_seq:
                            # Kiện p dỡ trước item! Kiểm tra xem item có chắn p không
                            # Hành lang của p: [p.x + p.length, floor_length] x [p.y, p.y + p.width]
                            if self.is_overlap(
                                p.x + p.length_cm, p.y, self.floor_length - (p.x + p.length_cm), p.width_cm,
                                x_cand, y_cand, l_cand, w_cand
                            ):
                                blocks_earlier_item = True
                                break
                    if blocks_earlier_item:
                        continue

                    # b) Kiện mới (dỡ trước) không bị kiện dỡ sau chắn
                    blocked_by_later_item = False
                    for p in current_placed:
                        p_seq = placed_unload_seq.get(p.item_id, 999999)
                        if item_unload_seq < p_seq:
                            # Item dỡ trước p! Kiểm tra xem p có chắn item không
                            if self.is_overlap(
                                x_cand + l_cand, y_cand, self.floor_length - (x_cand + l_cand), w_cand,
                                p.x, p.y, p.length_cm, p.width_cm
                            ):
                                blocked_by_later_item = True
                                break
                    if blocked_by_later_item:
                        continue

                    # Điểm số vị trí:
                    # Kiện dỡ muộn (unload_seq lớn) -> ưu tiên x nhỏ (trong cùng).
                    # Kiện dỡ sớm (unload_seq nhỏ) -> ưu tiên x lớn (gần cửa) hoặc cùng dải y để không cản trở.
                    score = x_cand * 10 + y_cand
                    if score < min_waste_score:
                        min_waste_score = score
                        best_cand = (x_cand, y_cand, l_cand, w_cand)

        return best_cand

    def validate_plan(self, stops: List[StopAction]) -> SpatialValidationResult:
        # Xây dựng bảng tra cứu stop sequence dỡ hàng cho từng kiện
        unload_seq_by_item: Dict[str, int] = {}
        for st in stops:
            for it_id in st.items_to_unload:
                unload_seq_by_item[it_id] = st.sequence

        current_items: Dict[str, PlacedItem] = {}
        step_states: List[FloorState] = []
        max_weight = 0.0
        max_area = 0.0

        for stop_idx, stop in enumerate(stops):
            # BƯỚC 1: DỠ HÀNG
            sorted_unload_ids = sorted(
                stop.items_to_unload,
                key=lambda it_id: (current_items[it_id].x + current_items[it_id].length_cm)
                if it_id in current_items
                else -1.0,
                reverse=True,
            )

            for item_id in sorted_unload_ids:
                if item_id not in current_items:
                    return SpatialValidationResult(
                        is_valid=False,
                        violation_code="ITEM_NOT_ON_BOARD",
                        violation_scenario="T21",
                        error_message=f"Kiện [{item_id}] cần dỡ tại Stop {stop.sequence} ({stop.address}) nhưng không có trên xe!",
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                target = current_items[item_id]
                other_items = [v for k, v in current_items.items() if k != item_id]

                path_clear, blocker_id = self.is_path_to_door_clear(target, other_items)
                if not path_clear:
                    return SpatialValidationResult(
                        is_valid=False,
                        violation_code="UNLOAD_PATH_BLOCKED",
                        violation_scenario="T24",
                        error_message=(
                            f"Vi phạm T24/T26: Không thể dỡ kiện [{item_id}] tại Stop {stop.sequence} ({stop.address}) "
                            f"vì bị kiện [{blocker_id}] nằm chắn ngay trên hành lang ra cửa thùng xe!"
                        ),
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                del current_items[item_id]

            # BƯỚC 2: BỐC HÀNG (LOAD)
            # Sắp xếp các kiện cần load: kiện dỡ SAU CÙNG (unload_seq lớn) nạp trước -> vào sâu trong xe
            sorted_load_items = sorted(
                stop.items_to_load,
                key=lambda it: unload_seq_by_item.get(it.id, 0),
                reverse=True,
            )

            placed_unload_seq = {k: unload_seq_by_item.get(k, 0) for k in current_items.keys()}

            for item in sorted_load_items:
                current_weight = sum(p.weight_kg for p in current_items.values())
                if current_weight + item.weight_kg > self.payload_limit:
                    return SpatialValidationResult(
                        is_valid=False,
                        violation_code="PAYLOAD_EXCEEDED",
                        violation_scenario="T21",
                        error_message=f"Tải trọng tại Stop {stop.sequence} vượt quá giới hạn xe!",
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                item_seq = unload_seq_by_item.get(item.id, 999999)
                placement = self.find_placement_position(
                    item, list(current_items.values()), item_seq, placed_unload_seq
                )
                if not placement:
                    occupied_area = sum(p.length_cm * p.width_cm for p in current_items.values())
                    free_area = self.total_floor_area - occupied_area
                    return SpatialValidationResult(
                        is_valid=False,
                        violation_code="UNLOAD_PATH_BLOCKED",
                        violation_scenario="T24",
                        error_message=f"Không tìm được vị trí đặt kiện [{item.id}] mà không chắn lối dỡ của các kiện khác hoặc vượt kích thước sàn!",
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                x, y, l, w = placement
                current_items[item.id] = PlacedItem(
                    item_id=item.id,
                    order_id=item.order_id,
                    x=x,
                    y=y,
                    length_cm=l,
                    width_cm=w,
                    height_cm=item.height_cm,
                    weight_kg=item.weight_kg,
                )
                placed_unload_seq[item.id] = item_seq

            current_weight = sum(p.weight_kg for p in current_items.values())
            occupied_area = sum(p.length_cm * p.width_cm for p in current_items.values())
            if current_weight > max_weight:
                max_weight = current_weight
            if occupied_area > max_area:
                max_area = occupied_area

        return SpatialValidationResult(
            is_valid=True,
            max_weight_kg=max_weight,
            max_area_cm2=max_area,
            step_states=step_states,
        )

print("SmartSpatialValidator defined successfully.")
