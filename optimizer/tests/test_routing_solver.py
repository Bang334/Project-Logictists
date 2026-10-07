import time

import pytest
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
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
    OptimizedRoute,
    ScheduledStop,
    SpatialValidationResult,
)
from app.routing_solver import FleetRoutingSolver, OrToolsRoutingSolver
from app.multi_start import MultiStartFleetOptimizer

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
    for route in response.routes:
        previous_departure = route.start_time_sec
        for stop in route.stops:
            assert stop.arrival_time_sec - previous_departure == (
                stop.travel_time_sec + stop.waiting_time_sec
            )
            assert stop.departure_time_sec - stop.arrival_time_sec == stop.service_time_sec
            previous_departure = stop.departure_time_sec
        assert route.end_time_sec - previous_departure == (
            route.return_travel_time_sec + route.return_waiting_time_sec
        )


def test_fleet_solver_assigns_every_split_part_to_its_physical_vehicle():
    depot = LocationPoint(id="split-depot", name="Kho", latitude=12.0, longitude=109.0)
    vehicles = [
        FleetVehicle(
            id=f"truck-{index}::day:0",
            source_vehicle_id=f"truck-{index}",
            plate_number=f"79C-00{index}",
            length_cm=200,
            width_cm=100,
            height_cm=120,
            payload_limit_kg=700,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=50_000,
        )
        for index in (1, 2)
    ]
    drivers = [
        DriverOption(
            id=f"driver-{index}",
            full_name=f"Tài xế {index}",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for index in (1, 2)
    ]

    parts = []
    for index in (1, 2):
        parts.append(
            OrderPair(
                id=f"order-large::split:{index}",
                source_order_id="order-large",
                source_order_number="DH-LARGE",
                split_group_id="order-large",
                allowed_source_vehicle_ids=[f"truck-{index}"],
                order_number=f"DH-LARGE ({index}/2)",
                pickup_location=LocationPoint(
                    id=f"pickup-large::split:{index}",
                    source_location_id="pickup-large",
                    name="Kho",
                    latitude=12.01,
                    longitude=109.01,
                ),
                delivery_location=LocationPoint(
                    id=f"delivery-large::split:{index}",
                    source_location_id="delivery-large",
                    name="Khách",
                    latitude=12.02,
                    longitude=109.02,
                ),
                items=[
                    CargoItem(
                        id=f"package-{index}",
                        order_id="order-large",
                        length_cm=150,
                        width_cm=80,
                        height_cm=80,
                        weight_kg=600,
                        can_rotate=False,
                    )
                ],
                service_time_sec=30,
            )
        )

    size = 6
    matrix = [[0 if row == col else 1000 for col in range(size)] for row in range(size)]
    durations = [[0 if row == col else 60 for col in range(size)] for row in range(size)]
    response = FleetRoutingSolver(
        FleetOptimizationRequest(
            job_id="split-job",
            vehicles=vehicles,
            drivers=drivers,
            orders=parts,
            policy=CostPolicy(
                fuel_price_per_liter_vnd=23_000,
                monthly_working_minutes=10_560,
            ),
            max_time_seconds=3,
            distance_matrix_meters=matrix,
            duration_matrix_seconds=durations,
        )
    ).solve()

    assert response.status == "SUCCESS"
    assert response.unassigned_orders == []
    assert {route.vehicle_id for route in response.routes} == {"truck-1", "truck-2"}
    assert {
        stop.order_id for route in response.routes for stop in route.stops
    } == {"order-large"}
    assert {
        stop.allocation_id for route in response.routes for stop in route.stops
    } == {"order-large::split:1", "order-large::split:2"}
    assert {
        stop.order_stop_id for route in response.routes for stop in route.stops
    } == {"pickup-large", "delivery-large"}


def test_fleet_solver_uses_split_vehicle_spare_payload_for_another_order():
    depot = LocationPoint(id="shared-depot", name="Kho", latitude=12.0, longitude=109.0)
    vehicles = [
        FleetVehicle(
            id=f"truck-{index}::day:0",
            source_vehicle_id=f"truck-{index}",
            plate_number=f"79C-10{index}",
            length_cm=400,
            width_cm=100,
            height_cm=120,
            payload_limit_kg=1900,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=50_000,
        )
        for index in (1, 2)
    ]
    drivers = [
        DriverOption(
            id=f"driver-{index}",
            full_name=f"Tài xế {index}",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for index in (1, 2)
    ]

    split_parts = [
        OrderPair(
            id=f"order-large::split:{index}",
            source_order_id="order-large",
            source_order_number="DH-LARGE",
            split_group_id="order-large",
            allowed_source_vehicle_ids=[f"truck-{index}"],
            order_number=f"DH-LARGE ({index}/2)",
            pickup_location=LocationPoint(
                id=f"pickup-large::split:{index}",
                source_location_id="pickup-large",
                name="Kho hàng lớn",
                latitude=12.01,
                longitude=109.01,
            ),
            delivery_location=LocationPoint(
                id=f"delivery-large::split:{index}",
                source_location_id="delivery-large",
                name="Khách hàng lớn",
                latitude=12.02,
                longitude=109.02,
            ),
            items=[
                CargoItem(
                    id=f"large-package-{index}",
                    order_id="order-large",
                    length_cm=150,
                    width_cm=100,
                    height_cm=80,
                    weight_kg=1000,
                    can_rotate=False,
                )
            ],
            pickup_window_start_sec=0,
            pickup_window_end_sec=240,
            delivery_window_start_sec=300,
            delivery_window_end_sec=1200,
            service_time_sec=30,
        )
        for index in (1, 2)
    ]
    extra_order = OrderPair(
        id="order-extra",
        order_number="DH-EXTRA",
        pickup_location=LocationPoint(
            id="pickup-extra",
            name="Kho hàng khác",
            latitude=12.011,
            longitude=109.011,
        ),
        delivery_location=LocationPoint(
            id="delivery-extra",
            name="Khách hàng khác",
            latitude=12.019,
            longitude=109.019,
        ),
        items=[
            CargoItem(
                id="extra-package",
                order_id="order-extra",
                length_cm=100,
                width_cm=100,
                height_cm=80,
                weight_kg=900,
                can_rotate=False,
            )
        ],
        pickup_window_start_sec=0,
        pickup_window_end_sec=240,
        delivery_window_start_sec=300,
        delivery_window_end_sec=1200,
        service_time_sec=30,
    )

    orders = [*split_parts, extra_order]
    size = len(vehicles) + 2 * len(orders)
    matrix = [[0 if row == col else 1000 for col in range(size)] for row in range(size)]
    durations = [[0 if row == col else 60 for col in range(size)] for row in range(size)]
    response = FleetRoutingSolver(
        FleetOptimizationRequest(
            job_id="shared-spare-payload-job",
            vehicles=vehicles,
            drivers=drivers,
            orders=orders,
            policy=CostPolicy(
                fuel_price_per_liter_vnd=23_000,
                monthly_working_minutes=10_560,
            ),
            max_time_seconds=3,
            distance_matrix_meters=matrix,
            duration_matrix_seconds=durations,
        )
    ).solve()

    assert response.status == "SUCCESS"
    assert response.unassigned_orders == []
    assert len(response.routes) == 2
    assert {route.vehicle_id for route in response.routes} == {"truck-1", "truck-2"}
    shared_route = next(
        route
        for route in response.routes
        if {stop.order_id for stop in route.stops} == {"order-large", "order-extra"}
    )
    assert max(stop.current_weight_kg for stop in shared_route.stops) == 1900


def test_fleet_solver_rounds_fractional_resequenced_route_end_time(monkeypatch):
    depot = LocationPoint(id="fractional-depot", name="Kho", latitude=21, longitude=105.8)
    vehicle = FleetVehicle(
        id="fractional-truck",
        plate_number="29C-FRACTIONAL",
        length_cm=400,
        width_cm=200,
        height_cm=200,
        payload_limit_kg=1000,
        depot=depot,
        fuel_consumption_liters_per_100_km=10,
        fixed_operating_cost_vnd=50_000,
    )
    driver = DriverOption(
        id="fractional-driver",
        full_name="Tài xế",
        fixed_salary_monthly_vnd=10_000_000,
        trip_base_pay_vnd=100_000,
        per_km_pay_vnd=1_000,
    )
    order = OrderPair(
        id="fractional-order",
        order_number="FRACTIONAL-ORDER",
        pickup_location=LocationPoint(
            id="fractional-pickup", name="Điểm lấy", latitude=21.01, longitude=105.81
        ),
        delivery_location=LocationPoint(
            id="fractional-delivery", name="Điểm giao", latitude=21.02, longitude=105.82
        ),
        items=[
            CargoItem(
                id="fractional-item",
                order_id="fractional-order",
                length_cm=100,
                width_cm=100,
                height_cm=100,
                weight_kg=100,
            )
        ],
        service_time_sec=0,
    )
    matrix = [[0 if i == j else 60.25 for j in range(3)] for i in range(3)]
    request = FleetOptimizationRequest(
        job_id="fractional-time-job",
        vehicles=[vehicle],
        drivers=[driver],
        orders=[order],
        policy=CostPolicy(
            fuel_price_per_liter_vnd=23_000,
            monthly_working_minutes=10_560,
        ),
        max_time_seconds=1,
        distance_matrix_meters=matrix,
        duration_matrix_seconds=matrix,
    )
    solver = FleetRoutingSolver(request)
    scheduled = [
        ScheduledStop(
            sequence=1,
            location_id=order.pickup_location.id,
            location_name=order.pickup_location.name,
            stop_type="PICKUP",
            order_id=order.id,
            latitude=order.pickup_location.latitude,
            longitude=order.pickup_location.longitude,
            arrival_time_sec=60,
            departure_time_sec=60,
            items_loaded=[order.items[0].id],
            current_weight_kg=100,
        ),
        ScheduledStop(
            sequence=2,
            location_id=order.delivery_location.id,
            location_name=order.delivery_location.name,
            stop_type="DELIVERY",
            order_id=order.id,
            latitude=order.delivery_location.latitude,
            longitude=order.delivery_location.longitude,
            arrival_time_sec=120,
            departure_time_sec=120,
            items_unloaded=[order.items[0].id],
        ),
    ]

    monkeypatch.setattr(
        "app.routing_solver.SpatialValidator.validate_plan",
        lambda *_: SpatialValidationResult(
            is_valid=False,
            violation_code="BLOCKED_ACCESS",
            error_message="Buộc đi qua nhánh tái sắp xếp",
        ),
    )
    monkeypatch.setattr(
        solver,
        "_resequence_stops_for_spatial_feasibility",
        lambda *_, **__: (
            scheduled,
            [],
            180.75,
            180.75,
            SpatialValidationResult(is_valid=True),
        ),
    )

    response = solver.solve()

    assert response.status == "SUCCESS"
    assert response.routes[0].end_time_sec == 181
    assert isinstance(response.routes[0].end_time_sec, int)


def test_recovery_uses_an_idle_future_day_before_repacking_a_busy_route(monkeypatch):
    depot = LocationPoint(id="recovery-depot", name="Kho", latitude=21, longitude=105.8)
    vehicles = [
        FleetVehicle(
            id=f"recovery-truck::day:{day}",
            source_vehicle_id="recovery-truck",
            service_day_index=day,
            available_start_sec=day * 86400,
            available_end_sec=day * 86400 + 3600,
            plate_number="29C-RECOVERY",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=1000,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=50_000,
        )
        for day in (0, 1)
    ]
    drivers = [
        DriverOption(
            id=f"recovery-driver::day:{day}",
            source_driver_id="recovery-driver",
            service_day_index=day,
            full_name="Tài xế",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for day in (0, 1)
    ]

    def make_order(index: int) -> OrderPair:
        return OrderPair(
            id=f"recovery-order-{index}",
            order_number=f"RECOVERY-{index}",
            pickup_location=LocationPoint(
                id=f"recovery-pickup-{index}", name="Điểm lấy", latitude=21.01, longitude=105.81
            ),
            delivery_location=LocationPoint(
                id=f"recovery-delivery-{index}", name="Điểm giao", latitude=21.02, longitude=105.82
            ),
            items=[
                CargoItem(
                    id=f"recovery-item-{index}",
                    order_id=f"recovery-order-{index}",
                    length_cm=100,
                    width_cm=100,
                    height_cm=100,
                    weight_kg=100,
                )
            ],
            service_time_sec=0,
        )

    existing_order = make_order(1)
    pending_order = make_order(2)
    matrix = [[0 if i == j else 60 for j in range(6)] for i in range(6)]
    solver = FleetRoutingSolver(
        FleetOptimizationRequest(
            job_id="future-day-recovery",
            vehicles=vehicles,
            drivers=drivers,
            orders=[existing_order, pending_order],
            policy=CostPolicy(
                fuel_price_per_liter_vnd=23_000,
                monthly_working_minutes=10_560,
            ),
            max_time_seconds=1,
            distance_matrix_meters=matrix,
            duration_matrix_seconds=matrix,
        )
    )
    busy_route = OptimizedRoute(
        route_id=vehicles[0].id,
        vehicle_id=vehicles[0].source_vehicle_id,
        service_day_index=0,
        plate_number=vehicles[0].plate_number,
        vehicle_length_cm=vehicles[0].length_cm,
        vehicle_width_cm=vehicles[0].width_cm,
        total_distance_km=1,
        total_duration_minutes=1,
        stops=[
            ScheduledStop(
                sequence=1,
                location_id=existing_order.pickup_location.id,
                location_name=existing_order.pickup_location.name,
                stop_type="PICKUP",
                order_id=existing_order.id,
                latitude=existing_order.pickup_location.latitude,
                longitude=existing_order.pickup_location.longitude,
                arrival_time_sec=60,
                departure_time_sec=60,
            )
        ],
        spatial_validation=SpatialValidationResult(is_valid=True),
    )
    recovered_stops = [
        ScheduledStop(
            sequence=1,
            location_id=pending_order.pickup_location.id,
            location_name=pending_order.pickup_location.name,
            stop_type="PICKUP",
            order_id=pending_order.id,
            latitude=pending_order.pickup_location.latitude,
            longitude=pending_order.pickup_location.longitude,
            arrival_time_sec=86460,
            departure_time_sec=86460,
        ),
        ScheduledStop(
            sequence=2,
            location_id=pending_order.delivery_location.id,
            location_name=pending_order.delivery_location.name,
            stop_type="DELIVERY",
            order_id=pending_order.id,
            latitude=pending_order.delivery_location.latitude,
            longitude=pending_order.delivery_location.longitude,
            arrival_time_sec=86520,
            departure_time_sec=86520,
        ),
    ]
    attempted_vehicle_ids = []

    def recover_on_future_day(vehicle, *_):
        attempted_vehicle_ids.append(vehicle.id)
        if vehicle.service_day_index == 0:
            raise AssertionError("Không được tái xếp tuyến bận trước khi thử slot trống ngày sau")
        return (
            recovered_stops,
            [],
            1000,
            86580,
            SpatialValidationResult(is_valid=True),
        )

    monkeypatch.setattr(
        solver,
        "_resequence_stops_for_spatial_feasibility",
        recover_on_future_day,
    )
    routes = [busy_route]
    assigned_order_ids = {existing_order.id}

    limit_reached = solver._recover_unassigned_orders(
        routes,
        assigned_order_ids,
        {},
        deadline=time.monotonic() + 1,
    )

    assert limit_reached is False
    assert attempted_vehicle_ids == [vehicles[1].id]
    assert pending_order.id in assigned_order_ids
    assert {route.service_day_index for route in routes} == {0, 1}


def test_recovery_selects_lowest_incremental_cost_not_shortest_distance(monkeypatch):
    depot = LocationPoint(id="cost-recovery-depot", name="Kho", latitude=21, longitude=105.8)
    vehicles = [
        FleetVehicle(
            id="expensive-short-truck",
            service_day_index=0,
            plate_number="29C-EXPENSIVE",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=1_000,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=1_000_000,
        ),
        FleetVehicle(
            id="cheap-long-truck",
            service_day_index=0,
            plate_number="29C-CHEAP",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=1_000,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=10_000,
        ),
    ]
    drivers = [
        DriverOption(
            id=f"cost-driver-{index}",
            service_day_index=0,
            full_name=f"Tai xe {index}",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for index in (1, 2)
    ]
    order = OrderPair(
        id="cost-recovery-order",
        order_number="COST-RECOVERY",
        pickup_location=LocationPoint(
            id="cost-recovery-pickup", name="P", latitude=21.01, longitude=105.81
        ),
        delivery_location=LocationPoint(
            id="cost-recovery-delivery", name="D", latitude=21.02, longitude=105.82
        ),
        items=[
            CargoItem(
                id="cost-recovery-item",
                order_id="cost-recovery-order",
                length_cm=100,
                width_cm=100,
                height_cm=100,
                weight_kg=100,
            )
        ],
        service_time_sec=0,
    )
    matrix = [[0 if i == j else 1_000 for j in range(4)] for i in range(4)]
    solver = FleetRoutingSolver(
        FleetOptimizationRequest(
            job_id="cost-recovery-job",
            vehicles=vehicles,
            drivers=drivers,
            orders=[order],
            policy=CostPolicy(
                fuel_price_per_liter_vnd=23_000,
                monthly_working_minutes=10_560,
            ),
            max_time_seconds=2,
            distance_matrix_meters=matrix,
            duration_matrix_seconds=matrix,
        )
    )

    def candidate_for(vehicle, *_args, **_kwargs):
        distance_meters = 1_000 if vehicle.id == "expensive-short-truck" else 2_000
        stops = [
            ScheduledStop(
                sequence=1,
                location_id=order.pickup_location.id,
                location_name=order.pickup_location.name,
                stop_type="PICKUP",
                order_id=order.id,
                latitude=order.pickup_location.latitude,
                longitude=order.pickup_location.longitude,
                arrival_time_sec=60,
                departure_time_sec=60,
                items_loaded=[order.items[0].id],
                current_weight_kg=100,
            ),
            ScheduledStop(
                sequence=2,
                location_id=order.delivery_location.id,
                location_name=order.delivery_location.name,
                stop_type="DELIVERY",
                order_id=order.id,
                latitude=order.delivery_location.latitude,
                longitude=order.delivery_location.longitude,
                arrival_time_sec=120,
                departure_time_sec=120,
                items_unloaded=[order.items[0].id],
                current_weight_kg=0,
            ),
        ]
        return stops, [], distance_meters, 180, SpatialValidationResult(is_valid=True)

    monkeypatch.setattr(solver, "_resequence_stops_for_spatial_feasibility", candidate_for)
    routes = []
    assigned_order_ids = set()

    solver._recover_unassigned_orders(
        routes,
        assigned_order_ids,
        {},
        deadline=time.monotonic() + 1,
    )

    assert routes[0].route_id == "cheap-long-truck"


def test_consolidation_replaces_two_routes_only_when_total_cost_decreases(monkeypatch):
    depot = LocationPoint(id="merge-depot", name="Kho", latitude=21, longitude=105.8)
    vehicles = [
        FleetVehicle(
            id=f"merge-truck-{index}",
            service_day_index=0,
            plate_number=f"29C-MERGE-{index}",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=1_000,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=500_000,
        )
        for index in (1, 2)
    ]
    drivers = [
        DriverOption(
            id=f"merge-driver-{index}",
            service_day_index=0,
            full_name=f"Tai xe {index}",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for index in (1, 2)
    ]

    def make_order(index: int) -> OrderPair:
        return OrderPair(
            id=f"merge-order-{index}",
            order_number=f"MERGE-{index}",
            pickup_location=LocationPoint(
                id=f"merge-pickup-{index}", name=f"P{index}", latitude=21, longitude=105.8
            ),
            delivery_location=LocationPoint(
                id=f"merge-delivery-{index}", name=f"D{index}", latitude=21, longitude=105.9
            ),
            items=[
                CargoItem(
                    id=f"merge-item-{index}",
                    order_id=f"merge-order-{index}",
                    length_cm=100,
                    width_cm=100,
                    height_cm=100,
                    weight_kg=100,
                )
            ],
            service_time_sec=0,
        )

    orders = [make_order(1), make_order(2)]
    matrix = [[0 if i == j else 1_000 for j in range(6)] for i in range(6)]
    solver = FleetRoutingSolver(
        FleetOptimizationRequest(
            job_id="merge-job",
            vehicles=vehicles,
            drivers=drivers,
            orders=orders,
            policy=CostPolicy(
                fuel_price_per_liter_vnd=23_000,
                monthly_working_minutes=10_560,
            ),
            max_time_seconds=2,
            distance_matrix_meters=matrix,
            duration_matrix_seconds=matrix,
        )
    )

    def stops_for(order, sequence_start=1):
        return [
            ScheduledStop(
                sequence=sequence_start,
                location_id=order.pickup_location.id,
                location_name=order.pickup_location.name,
                stop_type="PICKUP",
                order_id=order.id,
                latitude=order.pickup_location.latitude,
                longitude=order.pickup_location.longitude,
                arrival_time_sec=60 * sequence_start,
                departure_time_sec=60 * sequence_start,
                items_loaded=[order.items[0].id],
                current_weight_kg=100,
            ),
            ScheduledStop(
                sequence=sequence_start + 1,
                location_id=order.delivery_location.id,
                location_name=order.delivery_location.name,
                stop_type="DELIVERY",
                order_id=order.id,
                latitude=order.delivery_location.latitude,
                longitude=order.delivery_location.longitude,
                arrival_time_sec=60 * (sequence_start + 1),
                departure_time_sec=60 * (sequence_start + 1),
                items_unloaded=[order.items[0].id],
                current_weight_kg=0,
            ),
        ]

    routes = [
        OptimizedRoute(
            route_id=vehicle.id,
            vehicle_id=vehicle.id,
            service_day_index=0,
            plate_number=vehicle.plate_number,
            vehicle_length_cm=vehicle.length_cm,
            vehicle_width_cm=vehicle.width_cm,
            total_distance_km=10,
            total_duration_minutes=10,
            stops=stops_for(order),
            spatial_validation=SpatialValidationResult(is_valid=True),
        )
        for vehicle, order in zip(vehicles, orders)
    ]
    merged_stops = stops_for(orders[0], 1) + stops_for(orders[1], 3)
    monkeypatch.setattr(
        solver,
        "_resequence_stops_for_spatial_feasibility",
        lambda *_args, **_kwargs: (
            merged_stops,
            [],
            12_000,
            1_200,
            SpatialValidationResult(is_valid=True),
        ),
    )

    solver._consolidate_routes(routes, deadline=time.monotonic() + 1)

    assert len(routes) == 1
    assert {stop.order_id for stop in routes[0].stops} == {order.id for order in orders}


def test_fleet_solver_reuses_vehicle_and_driver_on_the_next_service_day():
    depot = LocationPoint(id="depot-multiday", name="Kho", latitude=21.0, longitude=105.8)
    vehicle_slots = [
        FleetVehicle(
            id=f"truck-1::day:{day}",
            source_vehicle_id="truck-1",
            service_day_index=day,
            available_start_sec=day * 86400,
            available_end_sec=day * 86400 + 300,
            plate_number="29C-001.23",
            length_cm=400,
            width_cm=200,
            height_cm=200,
            payload_limit_kg=1000,
            depot=depot,
            fuel_consumption_liters_per_100_km=10,
            fixed_operating_cost_vnd=50_000,
        )
        for day in (0, 1)
    ]
    driver_slots = [
        DriverOption(
            id=f"driver-1::day:{day}",
            source_driver_id="driver-1",
            service_day_index=day,
            full_name="Tài xế 1",
            fixed_salary_monthly_vnd=10_000_000,
            trip_base_pay_vnd=100_000,
            per_km_pay_vnd=1_000,
        )
        for day in (0, 1)
    ]

    def make_order(index: int) -> OrderPair:
        return OrderPair(
            id=f"next-day-order-{index}",
            order_number=f"NEXT-DAY-{index}",
            pickup_location=LocationPoint(
                id=f"next-day-p{index}", name=f"P{index}", latitude=21.01, longitude=105.81
            ),
            delivery_location=LocationPoint(
                id=f"next-day-d{index}", name=f"D{index}", latitude=21.02, longitude=105.82
            ),
            items=[
                CargoItem(
                    id=f"next-day-item-{index}", order_id=f"next-day-order-{index}",
                    length_cm=100, width_cm=100, height_cm=100, weight_kg=100,
                )
            ],
            pickup_window_end_sec=2 * 86400 + 300,
            delivery_window_end_sec=2 * 86400 + 300,
            service_time_sec=0,
        )

    size = 6
    distances = [[0 if i == j else 1000 for j in range(size)] for i in range(size)]
    durations = [[0 if i == j else 100 for j in range(size)] for i in range(size)]
    response = FleetRoutingSolver(FleetOptimizationRequest(
        job_id="multi-day-job",
        vehicles=vehicle_slots,
        drivers=driver_slots,
        orders=[make_order(1), make_order(2)],
        policy=CostPolicy(fuel_price_per_liter_vnd=23_000, monthly_working_minutes=10_560),
        max_time_seconds=3,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )).solve()

    assert response.status == "SUCCESS"
    assert len(response.routes) == 2
    assert {route.vehicle_id for route in response.routes} == {"truck-1"}
    assert {route.driver_id for route in response.routes} == {"driver-1"}
    assert {route.service_day_index for route in response.routes} == {0, 1}
    assert all(route.end_time_sec <= (route.service_day_index + 1) * 86400 for route in response.routes)


def test_fleet_solver_does_not_bypass_driver_license_requirements():
    depot = LocationPoint(id="depot-license", name="Kho", latitude=21, longitude=105)
    vehicle = FleetVehicle(
        id="heavy-truck",
        plate_number="29H-HEAVY",
        length_cm=600,
        width_cm=220,
        height_cm=220,
        payload_limit_kg=8_000,
        depot=depot,
        fuel_consumption_liters_per_100_km=18,
        fixed_operating_cost_vnd=100_000,
    )
    driver = DriverOption(
        id="b2-driver",
        full_name="Tài xế B2",
        license_class="B2",
        fixed_salary_monthly_vnd=10_000_000,
        trip_base_pay_vnd=100_000,
        per_km_pay_vnd=1_000,
    )
    order = OrderPair(
        id="license-order",
        order_number="LICENSE-ORDER",
        pickup_location=LocationPoint(id="license-p", name="P", latitude=21, longitude=105.1),
        delivery_location=LocationPoint(id="license-d", name="D", latitude=21, longitude=105.2),
        items=[
            CargoItem(
                id="license-item",
                order_id="license-order",
                length_cm=100,
                width_cm=100,
                height_cm=100,
                weight_kg=500,
            )
        ],
        service_time_sec=0,
    )
    matrix = [[0 if i == j else 1_000 for j in range(3)] for i in range(3)]

    response = FleetRoutingSolver(
        FleetOptimizationRequest(
            job_id="license-job",
            vehicles=[vehicle],
            drivers=[driver],
            orders=[order],
            policy=CostPolicy(
                fuel_price_per_liter_vnd=23_000,
                monthly_working_minutes=10_560,
            ),
            max_time_seconds=1,
            distance_matrix_meters=matrix,
            duration_matrix_seconds=matrix,
        )
    ).solve()

    assert response.status == "INFEASIBLE"
    assert response.routes == []
    assert response.unassigned_orders[0].reason_code == "NO_COMPATIBLE_DRIVER"


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


@pytest.mark.parametrize(
    ("routing_status", "expected_status"),
    [
        (routing_enums_pb2.RoutingSearchStatus.ROUTING_FAIL_TIMEOUT, "TIMEOUT"),
        (routing_enums_pb2.RoutingSearchStatus.ROUTING_FAIL, "INFEASIBLE"),
    ],
)
def test_no_solution_uses_ortools_proof_status_not_elapsed_time(
    monkeypatch, routing_status, expected_status
):
    monkeypatch.setattr(
        pywrapcp.RoutingModel,
        "SolveWithParameters",
        lambda self, search: None,
    )
    monkeypatch.setattr(
        pywrapcp.RoutingModel,
        "status",
        lambda self: routing_status,
    )

    response = FleetRoutingSolver(_economic_sequence_request()).solve()

    assert response.status == expected_status


def test_fleet_solver_hanoi_multi_package_no_blocking():
    """
    Regression cho snapshot 11 đơn Hà Nội: cả ba xe đã có tuyến
    nhưng đơn DEMO-HN-002 vẫn ghép được vào xe 29D-528.36.
    Recovery không được chỉ xét xe rảnh.
    """
    import json, os, math

    snapshot_path = os.path.join(os.path.dirname(__file__), "..", "test_full_payload.json")
    assert os.path.exists(snapshot_path), "Thiếu fixture test_full_payload.json bắt buộc"

    with open(snapshot_path, encoding="utf-8") as f:
        data = json.load(f)

    # This regression isolates recovery across already-busy vehicles. The
    # original synthetic route groups cannot meet the fixture's narrow time
    # windows, so widen only this test's windows instead of relying on the old
    # resequencing bug that silently ignored them.
    for order in data["orders"]:
        order["pickup_window_start_sec"] = 0
        order["pickup_window_end_sec"] = 2_592_000
        order["delivery_window_start_sec"] = 0
        order["delivery_window_end_sec"] = 2_592_000

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

    solver = FleetRoutingSolver(req)
    orders_by_number = {order.order_number: order for order in req.orders}
    route_orders = {
        "29C-678.92": ["DEMO-HN-003", "DEMO-HN-005", "DEMO-HN-006", "DEMO-HN-008"],
        "29D-528.36": ["DEMO-HN-001", "DEMO-HN-004", "DEMO-HN-007", "DEMO-HN-011"],
        "29H-842.15": ["DEMO-HN-009", "DEMO-HN-010"],
    }

    def placeholder_route(vehicle, order_numbers):
        stops = []
        for sequence, order_number in enumerate(order_numbers, 1):
            order = orders_by_number[order_number]
            stops.append(
                ScheduledStop(
                    sequence=sequence,
                    location_id=order.pickup_location.id,
                    location_name=order.pickup_location.name,
                    stop_type="PICKUP",
                    order_id=order.id,
                    latitude=order.pickup_location.latitude,
                    longitude=order.pickup_location.longitude,
                    arrival_time_sec=0,
                    departure_time_sec=0,
                )
            )
        return OptimizedRoute(
            vehicle_id=vehicle.id,
            plate_number=vehicle.plate_number,
            vehicle_length_cm=vehicle.length_cm,
            vehicle_width_cm=vehicle.width_cm,
            total_distance_km=0,
            total_duration_minutes=0,
            stops=stops,
            spatial_validation=SpatialValidationResult(is_valid=True),
        )

    routes = [
        placeholder_route(vehicle, route_orders[vehicle.plate_number])
        for vehicle in req.vehicles
    ]
    target = orders_by_number["DEMO-HN-002"]
    assigned_order_ids = {
        order.id for order in req.orders if order.id != target.id
    }
    rejected_reasons = {
        target.id: ("SPATIAL_ROUTE_CONFLICT", "Tuyến ban đầu không hợp lệ")
    }

    limit_reached = solver._recover_unassigned_orders(
        routes,
        assigned_order_ids,
        rejected_reasons,
        # Keep this behavioral regression deterministic on shared CI workers;
        # production budgets are covered separately by timeout tests.
        deadline=time.monotonic() + 30,
    )

    assert limit_reached is False
    assert target.id in assigned_order_ids
    assert target.id not in rejected_reasons
    assert len(routes) == 3
    assert any(target.id in {stop.order_id for stop in route.stops} for route in routes)
    assert all(route.spatial_validation.is_valid for route in routes)


def _build_nha_trang_fifo_request():
    """
    Regression cho bài toán Nha Trang:
    - ORD-NTR-001 (C63438): 2 kiện 100x100cm (gọn nhẹ, 300kg)
    - ORD-NTR-002 (AEE326): 7 kiện 80x80cm (420kg)
    Thùng xe: 500x200cm.
    Lộ trình thuận địa lý và ngắn nhất nếu bỏ qua lối thao tác là FIFO:
    P(ORD-001) -> P(ORD-002) -> D(ORD-001) -> D(ORD-002) (~19.5 km).
    Tuy nhiên 2 kiện ORD-001 phủ kín bề ngang 200 cm gần cửa, nên không thể
    đưa 7 kiện ORD-002 vào phía trong mà không xê dịch hàng. Validator phải loại
    tuyến 19.5 km theo T26 và chọn thứ tự dỡ an toàn khoảng 22.1 km.
    """
    depot = LocationPoint(id="depot-ntr", name="Kho Nha Trang", latitude=12.2485, longitude=109.1834)
    vehicle = FleetVehicle(
        id="truck-ntr",
        plate_number="79C-188.26",
        length_cm=500,
        width_cm=200,
        height_cm=210,
        payload_limit_kg=3500,
        depot=depot,
        fuel_consumption_liters_per_100_km=13.5,
        load_fuel_surcharge_percent_at_full_payload=20,
        fixed_operating_cost_vnd=100_000,
    )
    driver = DriverOption(
        id="driver-ntr",
        full_name="Nguyễn Thành Đạt",
        license_class="C",
        fixed_salary_monthly_vnd=12_500_000,
        trip_base_pay_vnd=180_000,
        per_km_pay_vnd=1_200,
    )

    ord1 = OrderPair(
        id="ord-ntr-001",
        order_number="ORD-NTR-001",
        pickup_location=LocationPoint(id="p1", name="P1", latitude=12.285555, longitude=109.191747),
        delivery_location=LocationPoint(id="d1", name="D1", latitude=12.304572, longitude=109.188757),
        items=[
            CargoItem(
                id=f"item-1-{i}",
                order_id="ord-ntr-001",
                length_cm=100,
                width_cm=100,
                height_cm=80,
                weight_kg=150,
            )
            for i in range(2)
        ],
        service_time_sec=1200,
    )
    ord2 = OrderPair(
        id="ord-ntr-002",
        order_number="ORD-NTR-002",
        pickup_location=LocationPoint(id="p2", name="P2", latitude=12.29214, longitude=109.188386),
        delivery_location=LocationPoint(id="d2", name="D2", latitude=12.316131, longitude=109.187378),
        items=[
            CargoItem(
                id=f"item-2-{i}",
                order_id="ord-ntr-002",
                length_cm=80,
                width_cm=80,
                height_cm=70,
                weight_kg=60,
            )
            for i in range(7)
        ],
        service_time_sec=1200,
    )

    # Node indices: 0: Depot, 1: P(ord2), 2: D(ord2), 3: P(ord1), 4: D(ord1)
    # Trích xuất chính xác ma trận khoảng cách (meters) từ Mapbox thực tế
    distances = [
        [0, 6458.7, 9111.5, 5435.5, 7814.2],
        [6412.9, 0, 2929.2, 2015.9, 1631.9],
        [10139.0, 4028.9, 0, 5742.1, 3466.4],
        [5515.4, 1023.2, 3676.1, 0, 2378.7],
        [9273.4, 3163.3, 1297.3, 4876.4, 0],
    ]
    # Ma trận thời gian di chuyển (seconds)
    durations = [
        [0, 1040.9, 1229.3, 856.4, 1121.6],
        [1010.5, 0, 326.9, 350.2, 219.2],
        [1348.4, 490.6, 0, 688.1, 385.9],
        [851.2, 184.5, 372.9, 0, 265.2],
        [1222.6, 364.8, 107.7, 562.3, 0],
    ]

    req = FleetOptimizationRequest(
        job_id="test-nha-trang-fifo",
        vehicles=[vehicle],
        drivers=[driver],
        orders=[ord2, ord1],
        policy=CostPolicy(
            fuel_price_per_liter_vnd=23_500,
            monthly_working_minutes=10_560,
            cargo_holding_cost_vnd_per_ton_hour=15_000,
        ),
        max_time_seconds=5,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )

    return req, ord1


def test_fleet_solver_nha_trang_fifo_smart_placement():
    req, ord1 = _build_nha_trang_fifo_request()
    response = FleetRoutingSolver(req).solve()

    assert response.status == "SUCCESS"
    assert len(response.routes) == 1
    route = response.routes[0]
    assert route.spatial_validation.is_valid is True

    # Solver bảo đảm T26 bằng cách dỡ ord2 trước ord1; không nhận
    # tuyến ngắn hơn nhưng không có lối đưa hàng vào/ra.
    stop_sequence = [(stop.stop_type, stop.order_id) for stop in route.stops]
    assert stop_sequence == [
        ("PICKUP", ord1.id),
        ("PICKUP", "ord-ntr-002"),
        ("DELIVERY", "ord-ntr-002"),
        ("DELIVERY", ord1.id),
    ]
    assert route.total_distance_km == pytest.approx(22.13, abs=0.01)


def test_tiny_exhaustive_search_handles_nha_trang_seven_day_slots():
    one_day_request, ord1 = _build_nha_trang_fifo_request()
    source_vehicle = one_day_request.vehicles[0]
    source_driver = one_day_request.drivers[0]
    vehicles = [
        source_vehicle.model_copy(
            update={
                "id": f"{source_vehicle.id}::day:{day}",
                "source_vehicle_id": source_vehicle.id,
                "service_day_index": day,
                "available_start_sec": day * 86_400,
                "available_end_sec": (day + 1) * 86_400,
            }
        )
        for day in range(7)
    ]
    drivers = [
        source_driver.model_copy(
            update={
                "id": f"{source_driver.id}::day:{day}",
                "source_driver_id": source_driver.id,
                "service_day_index": day,
            }
        )
        for day in range(7)
    ]

    vehicle_count = len(vehicles)
    full_size = vehicle_count + 2 * len(one_day_request.orders)

    def expand_matrix(compact):
        expanded = [[0.0 for _ in range(full_size)] for _ in range(full_size)]
        for row in range(full_size):
            compact_row = 0 if row < vehicle_count else row - vehicle_count + 1
            for column in range(full_size):
                compact_column = 0 if column < vehicle_count else column - vehicle_count + 1
                if row < vehicle_count and column < vehicle_count:
                    continue
                expanded[row][column] = compact[compact_row][compact_column]
        return expanded

    request = FleetOptimizationRequest(
        **one_day_request.model_dump(
            exclude={
                "vehicles",
                "drivers",
                "distance_matrix_meters",
                "duration_matrix_seconds",
                "max_time_seconds",
            }
        ),
        vehicles=vehicles,
        drivers=drivers,
        max_time_seconds=120,
        distance_matrix_meters=expand_matrix(one_day_request.distance_matrix_meters),
        duration_matrix_seconds=expand_matrix(one_day_request.duration_matrix_seconds),
    )

    started_at = time.monotonic()
    batch = MultiStartFleetOptimizer(request).solve(max_candidates=3)
    elapsed_seconds = time.monotonic() - started_at

    assert elapsed_seconds < 12
    assert batch.solver_run_count == 1
    assert batch.candidates[0].result.status == "SUCCESS"
    assert any("Vét cạn" in line for line in batch.diagnostics)
    best_route = batch.candidates[0].result.routes[0]
    assert best_route.service_day_index == 0
    assert best_route.stops[0].order_id == ord1.id
    assert [candidate.result.total_cost_vnd for candidate in batch.candidates] == sorted(
        candidate.result.total_cost_vnd for candidate in batch.candidates
    )

