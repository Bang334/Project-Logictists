from typing import List

from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer
from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    LocationPoint,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
    SpatialValidationResult,
)
from app.multi_start import select_ranked_candidates
from app.request_preprocessor import split_infeasible_orders_across_fleet
from app.search_strategies import SEARCH_STRATEGIES


def _build_grid_matrices(locations: List[LocationPoint]):
    n = len(locations)
    dist = [[0.0] * n for _ in range(n)]
    dur = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            d_lat = abs(locations[i].latitude - locations[j].latitude)
            d_lon = abs(locations[i].longitude - locations[j].longitude)
            meters = max(500.0, float(round((d_lat + d_lon) * 100_000)))
            dist[i][j] = meters
            dur[i][j] = max(60.0, float(round(meters / 10)))
    return dist, dur


def _default_policy() -> CostPolicy:
    return CostPolicy(
        fuel_price_per_liter_vnd=23_000,
        monthly_working_minutes=10_560,
    )


def test_gk01_gk02_single_order_multiple_packages_and_multisource_grouped_on_one_trip() -> None:
    """GK01 & GK02: Một Order có nhiều kiện / nhiều nguồn lấy vừa trên 1 xe phải gom chung 1 chuyến."""
    depot = LocationPoint(id="depot", name="Kho Trung Tâm", latitude=10.75, longitude=106.65)
    p1 = LocationPoint(id="p1", name="Kho A", latitude=10.76, longitude=106.66)
    p2 = LocationPoint(id="p2", name="Cửa hàng B", latitude=10.77, longitude=106.67)
    d1 = LocationPoint(id="d1", name="Khách Hàng X", latitude=10.78, longitude=106.68)

    locations = [depot, depot, p1, d1, p2, d1]
    dist, dur = _build_grid_matrices(locations)

    request = FleetOptimizationRequest(
        job_id="gk01-gk02",
        vehicles=[
            FleetVehicle(
                id="v1",
                plate_number="51C-001",
                length_cm=300,
                width_cm=160,
                height_cm=160,
                payload_limit_kg=1500,
                available_start_sec=0,
                available_end_sec=28_800,
                depot=depot,
                fuel_consumption_liters_per_100_km=10,
                fixed_operating_cost_vnd=100_000,
            ),
            FleetVehicle(
                id="v2",
                plate_number="51C-002",
                length_cm=300,
                width_cm=160,
                height_cm=160,
                payload_limit_kg=1500,
                available_start_sec=0,
                available_end_sec=28_800,
                depot=depot,
                fuel_consumption_liters_per_100_km=10,
                fixed_operating_cost_vnd=100_000,
            ),
        ],
        drivers=[
            DriverOption(
                id="drv-1",
                full_name="Tài xế 1",
                license_class="C",
                fixed_salary_monthly_vnd=12_000_000,
                trip_base_pay_vnd=100_000,
                per_km_pay_vnd=1_000,
            ),
            DriverOption(
                id="drv-2",
                full_name="Tài xế 2",
                license_class="C",
                fixed_salary_monthly_vnd=12_000_000,
                trip_base_pay_vnd=100_000,
                per_km_pay_vnd=1_000,
            ),
        ],
        orders=[
            OrderPair(
                id="tr-1",
                source_order_id="retail-order-1",
                order_number="TR-001",
                pickup_location=p1,
                delivery_location=d1,
                items=[
                    CargoItem(
                        id="pkg-1",
                        order_id="retail-order-1",
                        length_cm=80,
                        width_cm=60,
                        height_cm=50,
                        weight_kg=200,
                        can_rotate=True,
                    ),
                    CargoItem(
                        id="pkg-2",
                        order_id="retail-order-1",
                        length_cm=80,
                        width_cm=60,
                        height_cm=50,
                        weight_kg=200,
                        can_rotate=True,
                    ),
                ],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=20_000,
            ),
            OrderPair(
                id="tr-2",
                source_order_id="retail-order-1",
                order_number="TR-002",
                pickup_location=p2,
                delivery_location=d1,
                items=[
                    CargoItem(
                        id="pkg-3",
                        order_id="retail-order-1",
                        length_cm=80,
                        width_cm=60,
                        height_cm=50,
                        weight_kg=250,
                        can_rotate=True,
                    ),
                ],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=20_000,
            ),
        ],
        policy=_default_policy(),
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )

    result = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1.5, random_seed=1).solve()
    assert result.status == "SUCCESS"
    assert len(result.routes) == 1
    assert result.planning_objective is not None
    assert result.planning_objective.extra_order_trips == 0
    assert result.planning_objective.split_order_count == 0
    assert result.planning_objective.active_route_count == 1


def test_gk05_geometric_2d_floor_infeasibility_triggers_split_with_matrix_expansion() -> None:
    """GK05: Tổng tải và diện tích đủ nhưng 2 kiện 60x60 không xếp vừa mặt sàn 100x100 phải được tách."""
    depot = LocationPoint(id="depot", name="Kho", latitude=10.75, longitude=106.65)
    pickup = LocationPoint(id="p-a", name="Kho A", latitude=10.76, longitude=106.66)
    delivery = LocationPoint(id="d-a", name="Khách A", latitude=10.77, longitude=106.67)
    dist, dur = _build_grid_matrices([depot, depot, pickup, delivery])

    request = FleetOptimizationRequest(
        job_id="gk05",
        vehicles=[
            FleetVehicle(
                id="v1",
                plate_number="51C-101",
                length_cm=100,
                width_cm=100,
                height_cm=120,
                payload_limit_kg=1000,
                available_start_sec=0,
                available_end_sec=28_800,
                depot=depot,
                fuel_consumption_liters_per_100_km=10,
                fixed_operating_cost_vnd=100_000,
            ),
            FleetVehicle(
                id="v2",
                plate_number="51C-102",
                length_cm=100,
                width_cm=100,
                height_cm=120,
                payload_limit_kg=1000,
                available_start_sec=0,
                available_end_sec=28_800,
                depot=depot,
                fuel_consumption_liters_per_100_km=10,
                fixed_operating_cost_vnd=100_000,
            ),
        ],
        drivers=[
            DriverOption(
                id="d1",
                full_name="TX 1",
                license_class="C",
                fixed_salary_monthly_vnd=10_000_000,
                trip_base_pay_vnd=100_000,
                per_km_pay_vnd=1_000,
            ),
            DriverOption(
                id="d2",
                full_name="TX 2",
                license_class="C",
                fixed_salary_monthly_vnd=10_000_000,
                trip_base_pay_vnd=100_000,
                per_km_pay_vnd=1_000,
            ),
        ],
        orders=[
            OrderPair(
                id="order-geom",
                order_number="ORD-GEOM",
                pickup_location=pickup,
                delivery_location=delivery,
                items=[
                    CargoItem(id="box-1", order_id="order-geom", length_cm=60, width_cm=60, height_cm=50, weight_kg=100),
                    CargoItem(id="box-2", order_id="order-geom", length_cm=60, width_cm=60, height_cm=50, weight_kg=100),
                ],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=20_000,
            )
        ],
        policy=_default_policy(),
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )

    expanded, split_count = split_infeasible_orders_across_fleet(request)
    assert split_count == 1
    assert len(expanded.orders) == 2
    assert {part.split_group_id for part in expanded.orders} == {"order-geom"}
    assert len(expanded.distance_matrix_meters) == len(expanded.vehicles) + 2 * len(expanded.orders)


def test_gk06_gk08_split_order_leaves_residual_capacity_for_order_b_without_opening_third_vehicle() -> None:
    """GK06-GK08: Đơn A tách ra 2 xe, phần dư trên một xe phải ghép thêm Đơn B thay vì mở xe thứ 3."""
    depot = LocationPoint(id="depot", name="Kho", latitude=10.75, longitude=106.65)
    p_a = LocationPoint(id="p-a", name="Kho A", latitude=10.76, longitude=106.66)
    d_a = LocationPoint(id="d-a", name="Khách A", latitude=10.77, longitude=106.67)
    p_b = LocationPoint(id="p-b", name="Kho B", latitude=10.765, longitude=106.665)
    d_b = LocationPoint(id="d-b", name="Khách B", latitude=10.775, longitude=106.675)

    locations = [depot, depot, depot, p_a, d_a, p_b, d_b]
    dist, dur = _build_grid_matrices(locations)

    request = FleetOptimizationRequest(
        job_id="gk06-gk08",
        vehicles=[
            FleetVehicle(
                id=f"v{idx}",
                plate_number=f"51C-20{idx}",
                length_cm=200,
                width_cm=100,
                height_cm=120,
                payload_limit_kg=1000,
                available_start_sec=0,
                available_end_sec=28_800,
                depot=depot,
                fuel_consumption_liters_per_100_km=10,
                fixed_operating_cost_vnd=200_000,
            )
            for idx in (1, 2, 3)
        ],
        drivers=[
            DriverOption(
                id=f"drv-{idx}",
                full_name=f"TX {idx}",
                license_class="C",
                fixed_salary_monthly_vnd=12_000_000,
                trip_base_pay_vnd=150_000,
                per_km_pay_vnd=1_000,
            )
            for idx in (1, 2, 3)
        ],
        orders=[
            OrderPair(
                id="order-a",
                order_number="ORD-A",
                pickup_location=p_a,
                delivery_location=d_a,
                items=[
                    CargoItem(id="a-1", order_id="order-a", length_cm=100, width_cm=90, height_cm=60, weight_kg=700),
                    CargoItem(id="a-2", order_id="order-a", length_cm=60, width_cm=90, height_cm=60, weight_kg=400),
                    CargoItem(id="a-3", order_id="order-a", length_cm=60, width_cm=90, height_cm=60, weight_kg=300),
                ],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=25_000,
            ),
            OrderPair(
                id="order-b",
                order_number="ORD-B",
                pickup_location=p_b,
                delivery_location=d_b,
                items=[
                    CargoItem(id="b-1", order_id="order-b", length_cm=60, width_cm=80, height_cm=60, weight_kg=250),
                ],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=25_000,
            ),
        ],
        policy=_default_policy(),
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )

    result = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=2.0, random_seed=0).solve()
    assert result.status == "SUCCESS"
    assert result.unassigned_orders == []
    assert len(result.routes) == 2
    assert result.planning_objective is not None
    assert result.planning_objective.extra_order_trips == 1
    assert result.planning_objective.split_order_count == 1
    assert result.planning_objective.active_route_count == 2

    loaded_ids = [
        item_id
        for route in result.routes
        for stop in route.stops
        if stop.stop_type == "PICKUP"
        for item_id in stop.items_loaded
    ]
    assert sorted(loaded_ids) == ["a-1", "a-2", "a-3", "b-1"]
    assert all(route.spatial_validation.is_valid for route in result.routes)


def test_lexicographic_ranking_prefers_fewer_extra_order_trips_over_raw_cost() -> None:
    """Mức 2 & Mức 3 trong hàm mục tiêu phân cấp: ưu tiên giảm extra_order_trips rồi mới đến số chuyến và chi phí."""
    plan_grouped = FleetOptimizationResponse(
        job_id="lex-test",
        status="SUCCESS",
        total_cost_vnd=450_000,
        routes=[
            OptimizedRoute(
                route_id="r1",
                vehicle_id="v1",
                start_time_sec=0,
                end_time_sec=600,
                plate_number="51C-01",
                vehicle_length_cm=300,
                vehicle_width_cm=150,
                total_distance_km=10,
                total_duration_minutes=20,
                stops=[
                    ScheduledStop(
                        sequence=1,
                        location_id="p1",
                        location_name="P1",
                        stop_type="PICKUP",
                        order_id="o1",
                        allocation_id="o1",
                        latitude=10.0,
                        longitude=106.0,
                        arrival_time_sec=100,
                        departure_time_sec=160,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_loaded=["pkg-1", "pkg-2"],
                    ),
                    ScheduledStop(
                        sequence=2,
                        location_id="d1",
                        location_name="D1",
                        stop_type="DELIVERY",
                        order_id="o1",
                        allocation_id="o1",
                        latitude=10.1,
                        longitude=106.1,
                        arrival_time_sec=260,
                        departure_time_sec=320,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_unloaded=["pkg-1", "pkg-2"],
                    ),
                ],
                return_travel_time_sec=280,
                return_waiting_time_sec=0,
                spatial_validation=SpatialValidationResult(is_valid=True),
            )
        ],
    )
    plan_split = FleetOptimizationResponse(
        job_id="lex-test",
        status="SUCCESS",
        total_cost_vnd=400_000,
        routes=[
            OptimizedRoute(
                route_id="r1",
                vehicle_id="v1",
                start_time_sec=0,
                end_time_sec=600,
                plate_number="51C-01",
                vehicle_length_cm=300,
                vehicle_width_cm=150,
                total_distance_km=5,
                total_duration_minutes=10,
                stops=[
                    ScheduledStop(
                        sequence=1,
                        location_id="p1",
                        location_name="P1",
                        stop_type="PICKUP",
                        order_id="o1",
                        allocation_id="o1",
                        latitude=10.0,
                        longitude=106.0,
                        arrival_time_sec=100,
                        departure_time_sec=160,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_loaded=["pkg-1"],
                    ),
                    ScheduledStop(
                        sequence=2,
                        location_id="d1",
                        location_name="D1",
                        stop_type="DELIVERY",
                        order_id="o1",
                        allocation_id="o1",
                        latitude=10.1,
                        longitude=106.1,
                        arrival_time_sec=260,
                        departure_time_sec=320,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_unloaded=["pkg-1"],
                    ),
                ],
                return_travel_time_sec=280,
                return_waiting_time_sec=0,
                spatial_validation=SpatialValidationResult(is_valid=True),
            ),
            OptimizedRoute(
                route_id="r2",
                vehicle_id="v2",
                start_time_sec=0,
                end_time_sec=600,
                plate_number="51C-02",
                vehicle_length_cm=300,
                vehicle_width_cm=150,
                total_distance_km=5,
                total_duration_minutes=10,
                stops=[
                    ScheduledStop(
                        sequence=1,
                        location_id="p1",
                        location_name="P1",
                        stop_type="PICKUP",
                        order_id="o1",
                        allocation_id="o1",
                        latitude=10.0,
                        longitude=106.0,
                        arrival_time_sec=100,
                        departure_time_sec=160,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_loaded=["pkg-2"],
                    ),
                    ScheduledStop(
                        sequence=2,
                        location_id="d1",
                        location_name="D1",
                        stop_type="DELIVERY",
                        order_id="o1",
                        allocation_id="o1",
                        latitude=10.1,
                        longitude=106.1,
                        arrival_time_sec=260,
                        departure_time_sec=320,
                        travel_time_sec=100,
                        waiting_time_sec=0,
                        service_time_sec=60,
                        items_unloaded=["pkg-2"],
                    ),
                ],
                return_travel_time_sec=280,
                return_waiting_time_sec=0,
                spatial_validation=SpatialValidationResult(is_valid=True),
            ),
        ],
    )

    candidates, fully_served, _ = select_ranked_candidates(
        [
            (SEARCH_STRATEGIES[0], plan_split, 400_000),
            (SEARCH_STRATEGIES[1], plan_grouped, 450_000),
        ],
        all_order_ids={"o1"},
        max_candidates=2,
    )
    assert fully_served == 2
    assert len(candidates) == 2
    assert candidates[0].result.routes[0].stops[0].items_loaded == ["pkg-1", "pkg-2"]
    assert candidates[1].result.total_cost_vnd == 400_000


def test_gk09_split_group_all_or_nothing_rolls_back_when_second_part_is_infeasible() -> None:
    """GK09: Khi một đơn bị tách thành 2 phần nhưng chỉ có 1 xe khả dụng, không được giao nửa đơn."""
    depot = LocationPoint(id="depot", name="Kho", latitude=10.75, longitude=106.65)
    p_a = LocationPoint(id="p-a", name="Kho A", latitude=10.76, longitude=106.66)
    d_a = LocationPoint(id="d-a", name="Khách A", latitude=10.77, longitude=106.67)
    dist, dur = _build_grid_matrices([depot, p_a, d_a, p_a, d_a])

    request = FleetOptimizationRequest(
        job_id="gk09",
        vehicles=[
            FleetVehicle(
                id="v1",
                plate_number="51C-901",
                length_cm=200,
                width_cm=100,
                height_cm=120,
                payload_limit_kg=1000,
                available_start_sec=0,
                available_end_sec=28_800,
                depot=depot,
                fuel_consumption_liters_per_100_km=10,
                fixed_operating_cost_vnd=100_000,
            ),
        ],
        drivers=[
            DriverOption(
                id="drv-1",
                full_name="TX 1",
                license_class="C",
                fixed_salary_monthly_vnd=12_000_000,
                trip_base_pay_vnd=100_000,
                per_km_pay_vnd=1_000,
            ),
        ],
        orders=[
            OrderPair(
                id="order-split::split:1",
                source_order_id="order-split",
                split_group_id="order-split",
                order_number="ORD-SPLIT (1/2)",
                pickup_location=p_a,
                delivery_location=d_a,
                items=[CargoItem(id="s-1", order_id="order-split", length_cm=80, width_cm=80, height_cm=60, weight_kg=600)],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=20_000,
            ),
            OrderPair(
                id="order-split::split:2",
                source_order_id="order-split",
                split_group_id="order-split",
                order_number="ORD-SPLIT (2/2)",
                pickup_location=p_a,
                delivery_location=d_a,
                items=[CargoItem(id="s-2", order_id="order-split", length_cm=80, width_cm=80, height_cm=60, weight_kg=600)],
                pickup_window_start_sec=0,
                pickup_window_end_sec=14_400,
                delivery_window_start_sec=0,
                delivery_window_end_sec=20_000,
            ),
        ],
        policy=_default_policy(),
        distance_matrix_meters=dist,
        duration_matrix_seconds=dur,
    )

    result = PackingAwareHybridALNSOptimizer(request, time_budget_seconds=1.0, random_seed=0).solve()
    assert result.routes == []
    assert [u.order_id for u in result.unassigned_orders] == ["order-split"]

