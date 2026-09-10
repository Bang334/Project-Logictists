import pytest
from app.models import (
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    VehicleFloor,
    CargoItem,
    LocationPoint,
    OrderPair,
    OptimizationRequest,
)
from app.routing_solver import FleetRoutingSolver, OrToolsRoutingSolver

def test_ortools_vrp_with_spatial_validation():
    vehicle = VehicleFloor(
        id="truck-1",
        plate_number="29H-842.15",
        length_cm=620.0,
        width_cm=215.0,
        height_cm=205.0,
        payload_limit_kg=5200.0,
        door_position="REAR",
    )

    depot = LocationPoint(
        id="depot-hn",
        name="Kho Vận Long Biên - Hà Nội",
        latitude=21.0345,
        longitude=105.9082,
    )

    # Đơn 1: Tiên Sơn -> Minh Khai (1,250 kg)
    order1 = OrderPair(
        id="ord-1",
        order_number="ORD-20260909-001",
        pickup_location=LocationPoint(
            id="p1",
            name="Nhà máy Sữa Tiên Sơn",
            latitude=21.1189,
            longitude=105.9967,
        ),
        delivery_location=LocationPoint(
            id="d1",
            name="Vinamilk Minh Khai",
            latitude=20.9992,
            longitude=105.8674,
        ),
        items=[
            CargoItem(
                id="item-milk",
                order_id="ord-1",
                description="Sữa Vinamilk",
                length_cm=200.0,
                width_cm=150.0,
                height_cm=120.0,
                weight_kg=1250.0,
            )
        ],
    )

    # Đơn 2: Ngọc Hồi -> Phạm Văn Đồng (850 kg)
    order2 = OrderPair(
        id="ord-2",
        order_number="ORD-20260909-002",
        pickup_location=LocationPoint(
            id="p2",
            name="Kho Sunhouse Ngọc Hồi",
            latitude=20.9324,
            longitude=105.8567,
        ),
        delivery_location=LocationPoint(
            id="d2",
            name="MediaMart Phạm Văn Đồng",
            latitude=21.0664,
            longitude=105.7836,
        ),
        items=[
            CargoItem(
                id="item-sunhouse",
                order_id="ord-2",
                description="Gia dụng Sunhouse",
                length_cm=180.0,
                width_cm=100.0,
                height_cm=100.0,
                weight_kg=850.0,
            )
        ],
    )

    request = OptimizationRequest(
        job_id="job-test-01",
        vehicle=vehicle,
        depot=depot,
        orders=[order1, order2],
        max_time_seconds=5,
        distance_matrix_meters=[
            [0 if i == j else (abs(i - j) + 1) * 1000 for j in range(5)]
            for i in range(5)
        ],
        duration_matrix_seconds=[
            [0 if i == j else (abs(i - j) + 1) * 120 for j in range(5)]
            for i in range(5)
        ],
    )

    solver = OrToolsRoutingSolver(request)
    response = solver.solve()

    assert response.status == "SUCCESS"
    assert response.total_distance_km > 0
    assert len(response.stops) == 4  # 2 pickups + 2 deliveries
    assert response.spatial_validation is not None
    assert response.spatial_validation.is_valid is True
    assert len(response.spatial_validation.step_states) == 4


def test_fleet_solver_assigns_two_vehicles_drivers_and_costs():
    depot = LocationPoint(id="depot", name="Kho", latitude=21.0, longitude=105.8)
    vehicles = [
        FleetVehicle(
            id=f"truck-{index}", plate_number=f"29C-00{index}", length_cm=400,
            width_cm=200, height_cm=200, payload_limit_kg=1000, depot=depot,
            fuel_consumption_liters_per_100_km=10 + index,
            fixed_operating_cost_vnd=50_000,
        )
        for index in (1, 2)
    ]
    drivers = [
        DriverOption(
            id=f"driver-{index}", full_name=f"Tài xế {index}",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000 + index * 10_000,
            per_km_pay_vnd=1_000,
        )
        for index in (1, 2)
    ]

    def make_order(index: int) -> OrderPair:
        return OrderPair(
            id=f"order-{index}", order_number=f"ORDER-{index}",
            pickup_location=LocationPoint(id=f"p{index}", name=f"P{index}", latitude=21 + index / 100, longitude=105.8),
            delivery_location=LocationPoint(id=f"d{index}", name=f"D{index}", latitude=21 + index / 100, longitude=105.9),
            items=[CargoItem(id=f"item-{index}", order_id=f"order-{index}", length_cm=100, width_cm=80, height_cm=60, weight_kg=800)],
            pickup_window_start_sec=0,
            pickup_window_end_sec=120,
            delivery_window_start_sec=120,
            delivery_window_end_sec=1200,
            service_time_sec=30,
        )

    size = 6
    distances = [[0 if i == j else 1000 for j in range(size)] for i in range(size)]
    durations = [[0 if i == j else 60 for j in range(size)] for i in range(size)]
    durations[2][4] = durations[4][2] = 600

    response = FleetRoutingSolver(FleetOptimizationRequest(
        job_id="fleet-job", vehicles=vehicles, drivers=drivers,
        orders=[make_order(1), make_order(2)],
        policy=CostPolicy(fuel_price_per_liter_vnd=23_000, monthly_working_minutes=10_560),
        max_time_seconds=2,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )).solve()

    assert response.status == "SUCCESS"
    assert len(response.routes) == 2
    assert {route.driver_id for route in response.routes} == {"driver-1", "driver-2"}
    assert all(route.cost and route.cost.total_cost_vnd > 0 for route in response.routes)


def _economic_sequence_request(
    *, load_surcharge_percent: float = 0, cargo_holding_rate: int = 0
) -> FleetOptimizationRequest:
    depot = LocationPoint(id="depot-cost", name="Depot", latitude=21, longitude=105)
    vehicle = FleetVehicle(
        id="truck-cost",
        plate_number="29C-COST",
        length_cm=500,
        width_cm=250,
        height_cm=220,
        payload_limit_kg=2000,
        depot=depot,
        fuel_consumption_liters_per_100_km=20,
        load_fuel_surcharge_percent_at_full_payload=load_surcharge_percent,
        fixed_operating_cost_vnd=0,
    )
    driver = DriverOption(
        id="driver-cost",
        full_name="Driver",
        fixed_salary_monthly_vnd=0,
        trip_base_pay_vnd=0,
        per_km_pay_vnd=0,
    )

    def order(index: int, weight_kg: float) -> OrderPair:
        return OrderPair(
            id=f"order-cost-{index}",
            order_number=f"ORDER-COST-{index}",
            pickup_location=LocationPoint(
                id=f"p{index}", name=f"P{index}", latitude=21, longitude=105 + index / 100
            ),
            delivery_location=LocationPoint(
                id=f"d{index}", name=f"D{index}", latitude=21.01, longitude=105 + index / 100
            ),
            items=[
                CargoItem(
                    id=f"item-cost-{index}",
                    order_id=f"order-cost-{index}",
                    length_cm=100 if index == 1 else 50,
                    width_cm=50,
                    height_cm=50,
                    weight_kg=weight_kg,
                )
            ],
            service_time_sec=0,
        )

    # Node order: depot, P1, D1, P2, D2. The distance-only winner is
    # P1 -> P2 -> D2 -> D1 (5 km). Delivering heavy order 1 first costs
    # 5.5 km but carries much less weight-distance.
    size = 5
    distances = [[20_000 if i != j else 0 for j in range(size)] for i in range(size)]
    for origin, destination, meters in (
        (0, 1, 1000), (1, 3, 1000), (3, 4, 1000), (4, 2, 1000), (2, 0, 1000),
        (1, 2, 1000), (2, 3, 1500), (4, 0, 1000),
    ):
        distances[origin][destination] = meters
    durations = [
        [0 if i == j else round(distances[i][j] / 1000 * 60) for j in range(size)]
        for i in range(size)
    ]
    return FleetOptimizationRequest(
        job_id="economic-sequence",
        vehicles=[vehicle],
        drivers=[driver],
        orders=[order(1, 1200), order(2, 100)],
        policy=CostPolicy(
            fuel_price_per_liter_vnd=20_000,
            monthly_working_minutes=10_560,
            cargo_holding_cost_vnd_per_ton_hour=cargo_holding_rate,
        ),
        max_time_seconds=3,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )


def test_load_sensitive_fuel_cost_delivers_heavy_order_earlier():
    distance_only = FleetRoutingSolver(_economic_sequence_request()).solve()
    load_sensitive = FleetRoutingSolver(
        _economic_sequence_request(load_surcharge_percent=50)
    ).solve()

    assert [stop.location_id for stop in distance_only.routes[0].stops] == ["p1", "p2", "d2", "d1"]
    assert [stop.location_id for stop in load_sensitive.routes[0].stops] == ["p1", "d1", "p2", "d2"]
    assert load_sensitive.routes[0].total_distance_km == 5.5
    assert load_sensitive.routes[0].cost is not None
    assert load_sensitive.routes[0].cost.load_fuel_surcharge_vnd > 0
    assert load_sensitive.routes[0].cost.cargo_distance_ton_km == pytest.approx(1.3)


def test_cargo_holding_cost_penalizes_long_onboard_time():
    response = FleetRoutingSolver(
        _economic_sequence_request(cargo_holding_rate=100_000)
    ).solve()

    assert [stop.location_id for stop in response.routes[0].stops] == ["p1", "d1", "p2", "d2"]
    assert response.routes[0].cost is not None
    assert response.routes[0].cost.cargo_holding_cost_vnd > 0
    assert response.routes[0].cost.cargo_time_ton_hours == pytest.approx(0.022, abs=0.001)


def test_fleet_solver_hanoi_multi_package_no_blocking():
    """
    Kiểm thử bài toán thực tế 8 đơn Hà Nội (nhiều kiện, pallet, kích thước khác nhau)
    trên 2 xe tải (2.5t và 5t).
    Đảm bảo 100% đơn được xếp (0 unassigned) và không xảy ra vi phạm T24/T26 (chắn cửa).
    """
    import json, os, math

    snapshot_path = os.path.join(os.path.dirname(__file__), "..", "job_snapshot.json")
    if not os.path.exists(snapshot_path):
        return

    with open(snapshot_path, encoding="utf-8") as f:
        data = json.load(f)

    def haversine(c1, c2):
        lon1, lat1 = c1
        lon2, lat2 = c2
        R = 6371000
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi, dlam = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
        a = math.sin(dphi/2.0)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam/2.0)**2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    coords = []
    for v in data["vehicles"]:
        coords.append((v["depot"]["longitude"], v["depot"]["latitude"]))
    for o in data["orders"]:
        coords.append((o["pickup_location"]["longitude"], o["pickup_location"]["latitude"]))
        coords.append((o["delivery_location"]["longitude"], o["delivery_location"]["latitude"]))

    n = len(coords)
    dist_matrix = [[0.0]*n for _ in range(n)]
    dur_matrix = [[0.0]*n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            d = haversine(coords[i], coords[j]) * 1.3
            dist_matrix[i][j] = d
            dur_matrix[i][j] = (d / 30000.0) * 3600.0

    req = FleetOptimizationRequest(
        job_id="test-hanoi-8-orders",
        vehicles=data["vehicles"],
        drivers=data["drivers"],
        orders=data["orders"],
        policy=data["policy"],
        max_time_seconds=data["max_time_seconds"],
        distance_matrix_meters=dist_matrix,
        duration_matrix_seconds=dur_matrix,
    )

    response = FleetRoutingSolver(req).solve()
    assert response.status == "SUCCESS"
    assert len(response.routes) == 2
    assert len(response.unassigned_orders) == 0
    assert all(r.spatial_validation.is_valid for r in response.routes)
