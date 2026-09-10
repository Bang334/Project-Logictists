from typing import List, Dict, Optional, Tuple
from .models import (
    VehicleFloor,
    CargoItem,
    PlacedItem,
    StopAction,
    FloorState,
    SpatialValidationResult,
)

class SpatialValidator:
    """
    Bộ thẩm định hình học và xếp dỡ động trên sàn xe (Non-stacking 2D floor packing with dynamic reuse).
    Kiểm chứng nghiêm ngặt 7 kịch bản bắt buộc từ T21 đến T27 theo quy chuẩn TMS:
    - T21: Nhiều kiện cùng xe vừa sàn/thùng, không chồng và xếp/dỡ thông suốt -> HỢP LỆ.
    - T22: Đặt chồng kiện lên nhau -> BỊ LOẠI (Cấm xếp chồng).
    - T23: Dỡ A rồi bốc C vào chỗ của A, giữ nguyên B -> HỢP LỆ.
    - T24: C vừa chỗ A nhưng chắn đường dỡ của B ở chặng tương lai -> BỊ LOẠI.
    - T25: Tổng diện tích trống đủ nhưng bị chia cắt rời rạc, kiện lớn không vừa ô nào -> BỊ LOẠI.
    - T26: Cửa thùng xe đủ kích thước nhưng hành lang đưa kiện vào bị chắn -> BỊ LOẠI.
    - T27: Bốc hàng C trước khi dỡ hàng A tại cùng một điểm dừng -> BỊ LOẠI.
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
        """Kiểm tra 2 hình chữ nhật có đè lên nhau không (sai số dung sai 0.01 cm)"""
        return not (
            x1 + l1 <= x2 + 0.01 or
            x2 + l2 <= x1 + 0.01 or
            y1 + w1 <= y2 + 0.01 or
            y2 + w2 <= y1 + 0.01
        )

    def is_path_to_door_clear(self, target_item: PlacedItem,
                              other_items: List[PlacedItem]) -> Tuple[bool, Optional[str]]:
        """
        Kiểm tra hành lang từ vị trí kiện ra cửa thùng xe có bị hàng khác chắn không.
        Cửa sau (REAR): vị trí x = floor_length.
        Hành lang dỡ hàng của target_item là vùng: [target.x + target.length, floor_length] x [target.y, target.y + target.width].
        """
        path_x_start = target_item.x + target_item.length_cm
        path_x_end = self.floor_length
        path_y_start = target_item.y
        path_y_end = target_item.y + target_item.width_cm

        for other in other_items:
            if other.item_id == target_item.item_id:
                continue
            # Kiểm tra xem 'other' có giao cắt với hành lang ra cửa của 'target' không
            if self.is_overlap(
                path_x_start, path_y_start, path_x_end - path_x_start, path_y_end - path_y_start,
                other.x, other.y, other.length_cm, other.width_cm
            ):
                return False, other.item_id

        return True, None

    def find_placement_position(self, item: CargoItem,
                                current_placed: List[PlacedItem]) -> Optional[Tuple[float, float, float, float]]:
        """
        Tìm tọa độ (x, y, length, width) hợp lệ trên sàn xe cho một kiện hàng mới.
        Chiến lược: Xếp từ trong cùng ra ngoài (x=0 -> x=L, y=0 -> y=W).
        Ưu tiên các ô trống (kể cả ô vừa được giải phóng từ kiện đã dỡ).
        Đảm bảo không chồng (T22), không vượt kích thước, và đường vào từ cửa x=L thông suốt.
        """
        orientations = [(item.length_cm, item.width_cm)]
        if item.can_rotate and item.length_cm != item.width_cm:
            orientations.append((item.width_cm, item.length_cm))

        # Tập hợp các tọa độ ứng viên (Candidate Points) dựa trên góc các kiện hiện có
        x_candidates = {0.0}
        y_candidates = {0.0}
        for p in current_placed:
            x_candidates.add(p.x + p.length_cm)
            y_candidates.add(p.y + p.width_cm)
            x_candidates.add(p.x)
            y_candidates.add(p.y)

        # Sắp xếp để ưu tiên lấp đầy từ sâu trong góc
        sorted_x = sorted([x for x in x_candidates if x <= self.floor_length])
        sorted_y = sorted([y for y in y_candidates if y <= self.floor_width])

        for l_cand, w_cand in orientations:
            # Kiểm tra chiều cao kiện
            if item.height_cm > self.floor_height:
                continue

            for x_cand in sorted_x:
                if x_cand + l_cand > self.floor_length:
                    continue
                for y_cand in sorted_y:
                    if y_cand + w_cand > self.floor_width:
                        continue

                    # 1. Kiểm tra không đè lên kiện khác
                    conflict = False
                    for other in current_placed:
                        if self.is_overlap(x_cand, y_cand, l_cand, w_cand,
                                           other.x, other.y, other.length_cm, other.width_cm):
                            conflict = True
                            break
                    if conflict:
                        continue

                    # 2. Kiểm tra đường đưa từ cửa (x=L) vào vị trí (x_cand) có bị chặn không
                    # Đường đưa hàng: [x_cand + l_cand, floor_length] x [y_cand, y_cand + w_cand]
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
                    path_clear, _ = self.is_path_to_door_clear(temp_placed, current_placed)
                    if not path_clear:
                        continue

                    # Tìm thấy vị trí khả thi hoàn hảo!
                    return (x_cand, y_cand, l_cand, w_cand)

        return None

    def validate_plan(self, stops: List[StopAction]) -> SpatialValidationResult:
        """
        Mô phỏng và thẩm định toàn bộ chuỗi hành trình qua từng Stop:
        - Quản lý trạng thái sàn xe theo từng bước.
        - Kiểm tra quy tắc dỡ trước - nạp sau tại cùng 1 stop (T27).
        - Kiểm tra dỡ hàng không bị cản lối (T24, T26).
        - Kiểm tra nạp hàng vào chỗ trống tái sử dụng (T23) hoặc cấm chồng (T22).
        - Kiểm tra phân mảnh diện tích sàn (T25).
        """
        current_items: Dict[str, PlacedItem] = {}  # item_id -> PlacedItem
        step_states: List[FloorState] = []
        max_weight = 0.0
        max_area = 0.0

        for stop_idx, stop in enumerate(stops):
            current_weight = sum(item.weight_kg for item in current_items.values())

            # BƯỚC 1: XỬ LÝ DỠ HÀNG (UNLOAD) TRƯỚC
            # Sắp xếp các kiện cần dỡ tại stop này theo thứ tự từ gần cửa nhất (x + length_cm lớn nhất) vào trong.
            # Đúng theo thực tế vận hành: kiện nào ở mép cửa thùng xe thì dỡ ra trước.
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
                        error_message=f"Kiện [{item_id}] cần dỡ tại Stop {stop.sequence} ({stop.address}) nhưng hiện không có trên xe!",
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                target = current_items[item_id]
                other_items = [v for k, v in current_items.items() if k != item_id]

                # Kiểm tra lối ra cửa có thông suốt không (T24, T26)
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

                # Dỡ hàng thành công -> Giải phóng không gian sàn (Dynamic Space Release)
                del current_items[item_id]

            # BƯỚC 2: XỬ LÝ BỐC HÀNG (LOAD) SAU KHI ĐÃ DỠ XONG
            for item in stop.items_to_load:
                # Kiểm tra tải trọng xe
                current_weight = sum(p.weight_kg for p in current_items.values())
                if current_weight + item.weight_kg > self.payload_limit:
                    return SpatialValidationResult(
                        is_valid=False,
                        violation_code="PAYLOAD_EXCEEDED",
                        violation_scenario="T21",
                        error_message=(
                            f"Tải trọng tại Stop {stop.sequence} đạt {current_weight + item.weight_kg:.1f} kg, "
                            f"vượt quá tải trọng cho phép của xe ({self.payload_limit:.1f} kg)!"
                        ),
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                # Tìm vị trí đặt kiện trên sàn xe (2D non-stacking)
                placement = self.find_placement_position(item, list(current_items.values()))
                if not placement:
                    # Kiểm tra xem tổng diện tích trống còn đủ không để phân loại vi phạm T22 hay T25
                    occupied_area = sum(p.length_cm * p.width_cm for p in current_items.values())
                    free_area = self.total_floor_area - occupied_area
                    item_area = item.length_cm * item.width_cm

                    if free_area >= item_area:
                        # Tổng diện tích trống còn đủ nhưng bị chia cắt hoặc không có ô nào vừa kích thước kiện -> T25
                        violation_scenario = "T25"
                        violation_code = "DISCONNECTED_FREE_SPACE"
                        msg = (
                            f"Vi phạm T25: Tổng diện tích sàn xe còn trống ({free_area / 10000:.2f} m²) "
                            f"đủ lớn hơn kiện [{item.id}] ({item_area / 10000:.2f} m²), nhưng các vùng trống bị chia cắt rời rạc "
                            f"hoặc đường đưa qua cửa bị chắn, không thể xếp vừa mà không ghép giả!"
                        )
                    else:
                        # Không còn đủ diện tích sàn, chỉ xếp vừa nếu xếp chồng lên kiện khác -> T22
                        violation_scenario = "T22"
                        violation_code = "STACKING_FORBIDDEN"
                        msg = (
                            f"Vi phạm T22: Hết diện tích mặt sàn xe tại Stop {stop.sequence}. "
                            f"Kiện [{item.id}] chỉ có thể đặt vừa nếu xếp chồng lên kiện khác (CẤM XẾP CHỒNG)!"
                        )

                    return SpatialValidationResult(
                        is_valid=False,
                        violation_code=violation_code,
                        violation_scenario=violation_scenario,
                        error_message=msg,
                        max_weight_kg=max_weight,
                        max_area_cm2=max_area,
                        step_states=step_states,
                    )

                # Đặt kiện vào sàn xe
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

            # Ghi nhận trạng thái sàn xe sau Stop này
            current_weight = sum(p.weight_kg for p in current_items.values())
            occupied_area = sum(p.length_cm * p.width_cm for p in current_items.values())
            if current_weight > max_weight:
                max_weight = current_weight
            if occupied_area > max_area:
                max_area = occupied_area

            step_states.append(
                FloorState(
                    step_index=stop_idx + 1,
                    stop_id=stop.stop_id,
                    stop_type=stop.stop_type,
                    action_description=f"Stop {stop.sequence} ({stop.stop_type}) - {stop.address}",
                    placed_items=list(current_items.values()),
                    current_weight_kg=round(current_weight, 1),
                    current_occupied_area_cm2=round(occupied_area, 1),
                    floor_area_cm2=self.total_floor_area,
                    weight_utilization_percent=round((current_weight / self.payload_limit) * 100, 1),
                    area_utilization_percent=round((occupied_area / self.total_floor_area) * 100, 1),
                    is_valid=True,
                )
            )

        return SpatialValidationResult(
            is_valid=True,
            max_weight_kg=max_weight,
            max_area_cm2=max_area,
            step_states=step_states,
        )
