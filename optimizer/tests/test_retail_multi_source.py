import pytest
from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OptimizationRequest,
    OrderPair,
    VehicleFloor,
)
from app.multi_start import MultiStartFleetOptimizer
from app.routing_solver import OrToolsRoutingSolver


def test_hybrid_alns_multi_source_consolidation_optimization():
    """
    Kiểm chứng bài toán tối ưu gom hàng đa nguồn (Multi-Source Retail Consolidation)
    trên thuật toán chính thức của hệ thống: Packing-aware Hybrid ALNS.
    
    Kịch bản thực tế:
    - 1 đơn hàng bán lẻ SO-RETAIL-001 cần giao tại Khu đô thị An Phú.
    - Đơn hàng gồm 2 yêu cầu vận tải gom từ 2 cửa hàng nguồn:
        + TR-01: Lấy tại Cửa hàng VLXD Thủ Đức (Store A) - 650 kg gạch Viglacera.
        + TR-02: Lấy tại Cửa hàng Dĩ An (Store B) - 520 kg sơn ngoại thất Dulux.
    - Đội xe: 1 xe tải nhẹ 2.5T tại Tổng kho Sóng Thần, tài xế bằng C.
    - Thuật toán PackingAwareHybridALNSOptimizer tiến hành lập lịch và bốc xếp:
        1. Tuyến xe phải gom được cả 2 nguồn TR-01 và TR-02.
        2. Thứ tự bốc hàng tại Store A và Store B phải trước khi dỡ hàng tại điểm giao.
        3. Kiểm định xếp dỡ không gian (Dynamic 2D Spatial Packing): các kiện không chồng, vừa thùng xe,
           lối rút dỡ ra cửa thùng sau (REAR door) hoàn toàn thông suốt (T21-T27).
        4. Hợp đồng TMS: giữ đúng order_id = 'order-retail-001' và allocation_id = 'tr-01' / 'tr-02'.
    """
    vehicle = FleetVehicle(
        id="truck-2.5t",
        plate_number="51C-999.88",
        length_cm=430.0,
        width_cm=190.0,
        height_cm=195.0,
        payload_limit_kg=2500.0,
        door_position="REAR",
        depot=LocationPoint(
            id="depot-sgn",
            name="Tổng kho Sóng Thần",
            latitude=10.8924,
            longitude=106.7582,
        ),
        fuel_consumption_liters_per_100_km=14.0,
        fixed_operating_cost_vnd=150000,
        available_start_sec=0,
        available_end_sec=28800,  # 8 giờ làm việc
    )

    driver = DriverOption(
        id="driver-01",
        full_name="Nguyễn Văn Tài",
        license_class="C",
        fixed_salary_monthly_vnd=12000000,
        trip_base_pay_vnd=150000,
        per_km_pay_vnd=2000,
    )

    # TR-01: Lấy tại Store A (Thủ Đức) -> Giao khách tại An Phú
    tr1 = OrderPair(
        id="tr-01",
        source_order_id="order-retail-001",
        source_order_number="SO-RETAIL-001",
        order_number="TR-01",
        pickup_location=LocationPoint(
            id="store-a",
            source_location_id="order-stop-pickup-store-a",
            name="Cửa hàng VLXD Thủ Đức",
            latitude=10.8500,
            longitude=106.7550,
        ),
        delivery_location=LocationPoint(
            id="customer-d1",
            source_location_id="order-stop-delivery-customer",
            name="Công trình Khách hàng - Khu đô thị An Phú",
            latitude=10.8000,
            longitude=106.7400,
        ),
        items=[
            CargoItem(
                id="pkg-store-a-tiles",
                order_id="order-retail-001",
                description="Gạch ốp lát Granite Viglacera",
                length_cm=120.0,
                width_cm=80.0,
                height_cm=75.0,
                weight_kg=650.0,
            )
        ],
        pickup_service_time_sec=600,
        delivery_service_time_sec=900,
        pickup_window_start_sec=0,
        pickup_window_end_sec=14400,
        delivery_window_start_sec=3600,
        delivery_window_end_sec=21600,
        package_contract_version="1",
    )

    # TR-02: Lấy tại Store B (Dĩ An) -> Giao khách tại An Phú
    tr2 = OrderPair(
        id="tr-02",
        source_order_id="order-retail-001",
        source_order_number="SO-RETAIL-001",
        order_number="TR-02",
        pickup_location=LocationPoint(
            id="store-b",
            source_location_id="order-stop-pickup-store-b",
            name="Cửa hàng Sơn & Chống thấm Dĩ An",
            latitude=10.8800,
            longitude=106.7650,
        ),
        delivery_location=LocationPoint(
            id="customer-d2",
            source_location_id="order-stop-delivery-customer",
            name="Công trình Khách hàng - Khu đô thị An Phú",
            latitude=10.8000,
            longitude=106.7400,
        ),
        items=[
            CargoItem(
                id="pkg-store-b-paint",
                order_id="order-retail-001",
                description="Sơn ngoại thất Dulux Weathershield",
                length_cm=110.0,
                width_cm=90.0,
                height_cm=80.0,
                weight_kg=520.0,
            )
        ],
        pickup_service_time_sec=600,
        delivery_service_time_sec=900,
        pickup_window_start_sec=0,
        pickup_window_end_sec=14400,
        delivery_window_start_sec=3600,
        delivery_window_end_sec=21600,
        package_contract_version="1",
    )

    # Ma trận khoảng cách (5 điểm: 0:Depot, 1:Store A, 2:Customer D1, 3:Store B, 4:Customer D2)
    distance_matrix = [
        [0, 5000, 12000, 4000, 12000],      # 0: Depot Sóng Thần
        [5000, 0, 7000, 3500, 7000],        # 1: Store A Thủ Đức
        [12000, 7000, 0, 9000, 0],          # 2: Customer D1 (cùng vị trí D2)
        [4000, 3500, 9000, 0, 9000],        # 3: Store B Dĩ An
        [12000, 7000, 0, 9000, 0],          # 4: Customer D2
    ]
    duration_matrix = [
        [0, 600, 1500, 500, 1500],
        [600, 0, 900, 450, 900],
        [1500, 900, 0, 1100, 0],
        [500, 450, 1100, 0, 1100],
        [1500, 900, 0, 1100, 0],
    ]

    policy = CostPolicy(
        fuel_price_per_liter_vnd=24000,
        monthly_working_minutes=10560,
    )

    fleet_request = FleetOptimizationRequest(
        job_id="job-hybrid-multi-source-01",
        vehicles=[vehicle],
        drivers=[driver],
        orders=[tr1, tr2],
        policy=policy,
        max_time_seconds=3,
        distance_matrix_meters=distance_matrix,
        duration_matrix_seconds=duration_matrix,
    )

    # 1. Chạy giải bằng thuật toán chính: Packing-aware Hybrid ALNS
    optimizer = PackingAwareHybridALNSOptimizer(
        fleet_request,
        time_budget_seconds=1.0,
        random_seed=42,
    )
    result = optimizer.solve()

    assert result.status == "SUCCESS"
    assert len(result.unassigned_orders) == 0, "Hybrid ALNS phải phục vụ đủ cả 2 yêu cầu gom hàng"
    assert len(result.routes) == 1, "Cả 2 yêu cầu gom hàng phải được phân vào 1 tuyến xe hợp lý"

    route = result.routes[0]
    assert route.vehicle_id == "truck-2.5t"
    assert route.driver_id == "driver-01"
    assert len(route.stops) == 4  # 2 pickups + 2 deliveries

    # Kiểm tra tính toàn vẹn của hợp đồng TMS
    for stop in route.stops:
        assert stop.order_id == "order-retail-001"
        assert stop.allocation_id in ["tr-01", "tr-02"]

    # Kiểm tra bất biến Pickup trước Delivery
    pickup_seqs = {stop.allocation_id: stop.sequence for stop in route.stops if stop.stop_type == "PICKUP"}
    delivery_seqs = {stop.allocation_id: stop.sequence for stop in route.stops if stop.stop_type == "DELIVERY"}

    assert "tr-01" in pickup_seqs and "tr-01" in delivery_seqs
    assert "tr-02" in pickup_seqs and "tr-02" in delivery_seqs
    assert pickup_seqs["tr-01"] < delivery_seqs["tr-01"]
    assert pickup_seqs["tr-02"] < delivery_seqs["tr-02"]

    # Kiểm tra kiểm định không gian xếp dỡ thùng xe
    assert route.spatial_validation is not None
    assert route.spatial_validation.is_valid is True
    assert len(route.spatial_validation.step_states) > 0


def test_ortools_fallback_multi_source_consolidation():
    """
    Kiểm tra bài toán tối ưu với OrToolsRoutingSolver (solver fallback / benchmark).
    """
    vehicle = VehicleFloor(
        id="truck-2.5t",
        plate_number="51C-999.88",
        length_cm=430.0,
        width_cm=190.0,
        height_cm=195.0,
        payload_limit_kg=2500.0,
        door_position="REAR",
    )

    depot = LocationPoint(
        id="depot-sgn",
        name="Tổng kho Sóng Thần",
        latitude=10.8924,
        longitude=106.7582,
    )

    tr1 = OrderPair(
        id="tr-01",
        source_order_id="order-retail-001",
        source_order_number="SO-RETAIL-001",
        order_number="TR-01",
        pickup_location=LocationPoint(
            id="store-a",
            source_location_id="order-stop-pickup-store-a",
            name="Cửa hàng VLXD Thủ Đức",
            latitude=10.8500,
            longitude=106.7550,
        ),
        delivery_location=LocationPoint(
            id="customer-d1",
            source_location_id="order-stop-delivery-customer",
            name="Công trình Khách hàng - Khu đô thị An Phú",
            latitude=10.8000,
            longitude=106.7400,
        ),
        items=[
            CargoItem(
                id="pkg-store-a-tiles",
                order_id="order-retail-001",
                description="Gạch ốp lát Granite Viglacera",
                length_cm=120.0,
                width_cm=80.0,
                height_cm=75.0,
                weight_kg=650.0,
            )
        ],
        pickup_service_time_sec=600,
        delivery_service_time_sec=900,
        package_contract_version="1",
    )

    tr2 = OrderPair(
        id="tr-02",
        source_order_id="order-retail-001",
        source_order_number="SO-RETAIL-001",
        order_number="TR-02",
        pickup_location=LocationPoint(
            id="store-b",
            source_location_id="order-stop-pickup-store-b",
            name="Cửa hàng Sơn & Chống thấm Dĩ An",
            latitude=10.8800,
            longitude=106.7650,
        ),
        delivery_location=LocationPoint(
            id="customer-d2",
            source_location_id="order-stop-delivery-customer",
            name="Công trình Khách hàng - Khu đô thị An Phú",
            latitude=10.8000,
            longitude=106.7400,
        ),
        items=[
            CargoItem(
                id="pkg-store-b-paint",
                order_id="order-retail-001",
                description="Sơn ngoại thất Dulux Weathershield",
                length_cm=110.0,
                width_cm=90.0,
                height_cm=80.0,
                weight_kg=520.0,
            )
        ],
        pickup_service_time_sec=600,
        delivery_service_time_sec=900,
        package_contract_version="1",
    )

    distance_matrix = [
        [0, 5000, 12000, 4000, 12000],
        [5000, 0, 7000, 3500, 7000],
        [12000, 7000, 0, 9000, 0],
        [4000, 3500, 9000, 0, 9000],
        [12000, 7000, 0, 9000, 0],
    ]
    duration_matrix = [
        [0, 600, 1500, 500, 1500],
        [600, 0, 900, 450, 900],
        [1500, 900, 0, 1100, 0],
        [500, 450, 1100, 0, 1100],
        [1500, 900, 0, 1100, 0],
    ]

    request = OptimizationRequest(
        job_id="job-multi-source-test-01",
        vehicle=vehicle,
        depot=depot,
        orders=[tr1, tr2],
        max_time_seconds=5,
        distance_matrix_meters=distance_matrix,
        duration_matrix_seconds=duration_matrix,
    )

    solver = OrToolsRoutingSolver(request)
    response = solver.solve()

    assert response.status == "SUCCESS"
    assert response.total_distance_km > 0
    assert len(response.stops) == 4
