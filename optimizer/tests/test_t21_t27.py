import pytest
from app.models import VehicleFloor, CargoItem, StopAction
from app.spatial_validator import SpatialValidator

@pytest.fixture
def standard_truck():
    """
    Xe tải tiêu chuẩn 5 tấn:
    - Sàn thùng: Dài 600 cm, Rộng 200 cm (Diện tích sàn = 12 m²)
    - Chiều cao: 200 cm
    - Cửa sau: tại x = 600 cm
    - Tải trọng: 5,000 kg
    """
    return VehicleFloor(
        id="truck-1",
        plate_number="29H-842.15",
        length_cm=600.0,
        width_cm=200.0,
        height_cm=200.0,
        payload_limit_kg=5000.0,
        door_position="REAR",
    )

def test_t21_multiple_items_fit_without_stacking(standard_truck):
    """
    Kịch bản T21:
    Nhiều kiện cùng xe vừa sàn/thùng, không chồng và xếp/dỡ thông suốt.
    - Kiện 1: 200 x 100 cm (2 m²), 1000 kg
    - Kiện 2: 200 x 100 cm (2 m²), 1000 kg
    Cả 2 kiện vừa sàn 12 m², xếp cạnh nhau, dỡ hàng thông suốt.
    -> HỢP LỆ.
    """
    validator = SpatialValidator(standard_truck)

    item1 = CargoItem(id="item-1", order_id="ord-1", length_cm=200, width_cm=100, height_cm=100, weight_kg=1000)
    item2 = CargoItem(id="item-2", order_id="ord-2", length_cm=200, width_cm=100, height_cm=100, weight_kg=1000)

    stops = [
        StopAction(stop_id="s1", sequence=1, stop_type="PICKUP", items_to_load=[item1, item2]),
        StopAction(stop_id="s2", sequence=2, stop_type="DELIVERY", items_to_unload=["item-2"]),
        StopAction(stop_id="s3", sequence=3, stop_type="DELIVERY", items_to_unload=["item-1"]),
    ]

    result = validator.validate_plan(stops)
    assert result.is_valid is True
    assert result.max_weight_kg == 2000.0
    assert len(result.step_states) == 3

def test_t22_stacking_forbidden_rejected(standard_truck):
    """
    Kịch bản T22:
    Một kiện chỉ vừa khi đặt lên kiện khác -> BỊ LOẠI (Cấm xếp chồng).
    - Thùng xe diện tích sàn: 600 x 200 = 120,000 cm²
    - Kiện 1: 500 x 200 cm (100,000 cm²), chiếm gần hết sàn xe
    - Kiện 2: 200 x 200 cm (40,000 cm²)
    Tổng diện tích = 140,000 cm² > 120,000 cm² (chỉ vừa nếu xếp chồng kiện 2 lên kiện 1).
    -> BỊ LOẠI VỚI LỖI T22.
    """
    validator = SpatialValidator(standard_truck)

    item1 = CargoItem(id="item-1", order_id="ord-1", length_cm=500, width_cm=200, height_cm=80, weight_kg=1500)
    item2 = CargoItem(id="item-2", order_id="ord-2", length_cm=200, width_cm=200, height_cm=80, weight_kg=800)

    stops = [
        StopAction(stop_id="s1", sequence=1, stop_type="PICKUP", items_to_load=[item1, item2]),
    ]

    result = validator.validate_plan(stops)
    assert result.is_valid is False
    assert result.violation_scenario == "T22"
    assert "CẤM XẾP CHỒNG" in result.error_message

def test_t23_dynamic_space_reuse_after_delivery(standard_truck):
    """
    Kịch bản T23:
    Dỡ A rồi lấy C vào vùng A, B vẫn ở trên xe.
    C vào được và vẫn dỡ B/C đúng kế hoạch, vị trí B giữ nguyên.
    -> HỢP LỆ (Chứng minh khả năng tái sử dụng không gian động).
    """
    validator = SpatialValidator(standard_truck)

    # Thùng xe 600 x 200 cm.
    # Kiện A: 250 x 100 cm (nằm bên trái y=0..100)
    # Kiện B: 250 x 100 cm (nằm bên phải y=100..200)
    # Kiện C: 200 x 100 cm (vừa đúng vào vị trí A sau khi A được dỡ)
    itemA = CargoItem(id="item-A", order_id="ord-A", length_cm=250, width_cm=100, height_cm=100, weight_kg=1000)
    itemB = CargoItem(id="item-B", order_id="ord-B", length_cm=250, width_cm=100, height_cm=100, weight_kg=1000)
    itemC = CargoItem(id="item-C", order_id="ord-C", length_cm=200, width_cm=100, height_cm=100, weight_kg=800)

    stops = [
        # Stop 1: Lấy cả A và B lên xe
        StopAction(stop_id="s1", sequence=1, stop_type="PICKUP", items_to_load=[itemA, itemB]),
        # Stop 2: Dỡ A, sau đó lấy C vào vị trí trống của A
        StopAction(stop_id="s2", sequence=2, stop_type="DELIVERY", items_to_unload=["item-A"], items_to_load=[itemC]),
        # Stop 3: Dỡ C
        StopAction(stop_id="s3", sequence=3, stop_type="DELIVERY", items_to_unload=["item-C"]),
        # Stop 4: Dỡ B
        StopAction(stop_id="s4", sequence=4, stop_type="DELIVERY", items_to_unload=["item-B"]),
    ]

    result = validator.validate_plan(stops)
    assert result.is_valid is True
    assert len(result.step_states) == 4

def test_t24_item_blocks_subsequent_delivery(standard_truck):
    """
    Kịch bản T24:
    C vừa vùng sàn nhưng nằm chắn ngay trước mặt B (B cần giao trước C).
    - Cửa sau ở x = 600.
    - Kiện B nằm sâu phía trong (x = 0..300, y = 0..200, chiếm trọn chiều ngang).
    - Kiện C được bốc lên và đặt ở phía ngoài (x = 300..500, y = 0..200).
    - Khi tới điểm dỡ B, B bị C chắn đường ra cửa sau -> BỊ LOẠI VỚI LỖI T24.
    """
    validator = SpatialValidator(standard_truck)

    # Thùng xe 600 x 200 cm
    # Kiện B chiếm trọn chiều ngang ở phía trước
    itemB = CargoItem(id="item-B", order_id="ord-B", length_cm=300, width_cm=200, height_cm=100, weight_kg=1500, can_rotate=False)
    # Kiện C đặt phía sau B
    itemC = CargoItem(id="item-C", order_id="ord-C", length_cm=200, width_cm=200, height_cm=100, weight_kg=1000, can_rotate=False)

    stops = [
        # Stop 1: Lấy B trước (đặt sâu trong x=0)
        StopAction(stop_id="s1", sequence=1, stop_type="PICKUP", items_to_load=[itemB]),
        # Stop 2: Lấy C sau (đặt x=300..500, chắn cửa sau x=600)
        StopAction(stop_id="s2", sequence=2, stop_type="PICKUP", items_to_load=[itemC]),
        # Stop 3: Cố dỡ B trước C -> BỊ CHẮN BỞI C!
        StopAction(stop_id="s3", sequence=3, stop_type="DELIVERY", items_to_unload=["item-B"]),
        # Stop 4: Dỡ C
        StopAction(stop_id="s4", sequence=4, stop_type="DELIVERY", items_to_unload=["item-C"]),
    ]

    result = validator.validate_plan(stops)
    assert result.is_valid is False
    assert result.violation_scenario == "T24"
    assert "chắn ngay trên hành lang ra cửa" in result.error_message

def test_t25_disconnected_space_rejected(standard_truck):
    """
    Kịch bản T25:
    Tổng diện tích trống đủ nhưng bị chia cắt thành các vùng nhỏ rời rạc.
    Kiện lớn không vừa bất kỳ ô trống liên tục nào -> BỊ LOẠI (Không ghép giả diện tích).
    - Thùng xe 600 x 200 cm.
    - Kiện 1: 300 x 120 cm tại [0, 300] x [0, 120] -> ô trống còn lại là rộng 80 cm.
    - Kiện 2: 300 x 120 cm tại [300, 600] x [80, 200] -> ô trống còn lại là rộng 80 cm.
    - Tổng diện tích trống = 48,000 cm².
    - Kiện 3 (item_large): 200 x 120 cm (diện tích 24,000 cm² < 48,000 cm²).
    Vì các ô trống chỉ có chiều rộng 80 cm < 120 cm, kiện 3 không thể nhét vừa!
    """
    validator = SpatialValidator(standard_truck)

    item1 = CargoItem(id="item-1", order_id="ord-1", length_cm=300, width_cm=120, height_cm=100, weight_kg=500, can_rotate=False)
    item2 = CargoItem(id="item-2", order_id="ord-2", length_cm=300, width_cm=120, height_cm=100, weight_kg=500, can_rotate=False)
    # Kiện 3 có chiều rộng 120 cm và chiều dài 200 cm (diện tích 24,000 cm² nhỏ hơn tổng diện tích trống 48,000 cm²)
    item_large = CargoItem(id="item-large", order_id="ord-3", length_cm=200, width_cm=120, height_cm=100, weight_kg=800, can_rotate=False)

    # Đặt item1 và item2 theo 2 chặng hoặc thứ tự sao cho tạo ra 2 dải hẹp rộng 80 cm
    stops = [
        StopAction(stop_id="s1", sequence=1, stop_type="PICKUP", items_to_load=[item1, item2, item_large]),
    ]

    result = validator.validate_plan(stops)
    assert result.is_valid is False
    assert result.violation_scenario == "T25"
    assert "chia cắt rời rạc" in result.error_message

def test_t27_unload_before_load_at_same_stop(standard_truck):
    """
    Kịch bản T27:
    Tại cùng 1 điểm dừng, dỡ hàng A trước để giải phóng chỗ trống rồi mới bốc C vào chỗ của A.
    Nếu lập trình đúng thứ tự dỡ trước bốc sau -> HỢP LỆ.
    """
    validator = SpatialValidator(standard_truck)

    # Thùng xe 600 x 200 cm
    # Kiện A chiếm trọn thùng xe 500 x 200 cm
    itemA = CargoItem(id="item-A", order_id="ord-A", length_cm=500, width_cm=200, height_cm=100, weight_kg=2000)
    # Kiện C cũng chiếm 500 x 200 cm
    itemC = CargoItem(id="item-C", order_id="ord-C", length_cm=500, width_cm=200, height_cm=100, weight_kg=2000)

    # Tại Stop 2: Dỡ A rồi bốc C
    stops = [
        StopAction(stop_id="s1", sequence=1, stop_type="PICKUP", items_to_load=[itemA]),
        StopAction(stop_id="s2", sequence=2, stop_type="DELIVERY", items_to_unload=["item-A"], items_to_load=[itemC]),
        StopAction(stop_id="s3", sequence=3, stop_type="DELIVERY", items_to_unload=["item-C"]),
    ]

    result = validator.validate_plan(stops)
    assert result.is_valid is True
    assert len(result.step_states) == 3
