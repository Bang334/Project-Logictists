from app.baseline_calculator import BaselineCostCalculator
from app.models import (
    CargoItem,
    CostPolicy,
    DriverOption,
    FleetOptimizationRequest,
    FleetVehicle,
    LocationPoint,
    OrderPair,
)
from app.routing_solver import FleetRoutingSolver
from typing import List


def _request(
    *,
    vehicles: List[FleetVehicle],
    orders: List[OrderPair],
    distances: List[List[float]],
    durations: List[List[float]],
    holding_rate: int = 0,
) -> FleetOptimizationRequest:
    return FleetOptimizationRequest(
        job_id="benchmark-regression",
        vehicles=vehicles,
        drivers=[
            DriverOption(
                id=f"driver-{index}",
                full_name=f"Driver {index}",
                license_class="C",
                fixed_salary_monthly_vnd=0,
                trip_base_pay_vnd=0,
                per_km_pay_vnd=0,
            )
            for index in range(1, len(vehicles) + 1)
        ],
        orders=orders,
        policy=CostPolicy(
            fuel_price_per_liter_vnd=20_000,
            monthly_working_minutes=10_560,
            cargo_holding_cost_vnd_per_ton_hour=holding_rate,
        ),
        max_time_seconds=2,
        distance_matrix_meters=distances,
        duration_matrix_seconds=durations,
    )


def _vehicle(index: int, *, length_cm: float = 100, width_cm: float = 100):
    depot = LocationPoint(
        id=f"depot-{index}", name=f"Depot {index}", latitude=21, longitude=105
    )
    return FleetVehicle(
        id=f"vehicle-{index}",
        plate_number=f"TEST-{index}",
        length_cm=length_cm,
        width_cm=width_cm,
        height_cm=200,
        payload_limit_kg=10_000,
        depot=depot,
        fuel_consumption_liters_per_100_km=10,
        fixed_operating_cost_vnd=100_000,
    )


def _order(index: int, *, length_cm: float = 10, width_cm: float = 10, weight=10):
    return OrderPair(
        id=f"order-{index}",
        order_number=f"ORDER-{index}",
        pickup_location=LocationPoint(
            id=f"p{index}", name=f"P{index}", latitude=21, longitude=105
        ),
        delivery_location=LocationPoint(
            id=f"d{index}", name=f"D{index}", latitude=21, longitude=105
        ),
        items=[
            CargoItem(
                id=f"item-{index}",
                order_id=f"order-{index}",
                length_cm=length_cm,
                width_cm=width_cm,
                height_cm=50,
                weight_kg=weight,
                can_rotate=False,
            )
        ],
        service_time_sec=0,
    )


def test_baseline_preserves_distinct_service_durations_and_timing_breakdown():
    vehicle = _vehicle(1)
    order = _order(1).model_copy(update={
        "pickup_service_time_sec": 60,
        "delivery_service_time_sec": 120,
    })
    matrix = [[0 if i == j else 30 for j in range(3)] for i in range(3)]
    request = _request(vehicles=[vehicle], orders=[order], distances=matrix, durations=matrix)
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    route = calculator._evaluate_actions(vehicle, 0, calculator._actions_for_order(order), order_index=0)

    assert not route.violations
    pickup, delivery = route.stops
    assert (pickup.arrival_time_sec, pickup.departure_time_sec, pickup.service_time_sec) == (30, 90, 60)
    assert (delivery.arrival_time_sec, delivery.departure_time_sec, delivery.service_time_sec) == (120, 240, 120)
    assert all(stop.travel_time_sec == 30 and stop.waiting_time_sec == 0 for stop in route.stops)
    assert route.duration_seconds == 270


def test_direct_dedicated_benchmark_uses_the_same_cargo_holding_cost_component():
    vehicle = _vehicle(1)
    order = _order(1, weight=1_000)
    distances = [
        [0, 1_000, 1_000],
        [1_000, 0, 1_000],
        [1_000, 1_000, 0],
    ]
    durations = [
        [0, 60, 60],
        [60, 0, 3_600],
        [60, 3_600, 0],
    ]
    request = _request(
        vehicles=[vehicle],
        orders=[order],
        distances=distances,
        durations=durations,
        holding_rate=1_000,
    )
    calculator = BaselineCostCalculator(
        request, FleetRoutingSolver(request).nodes
    )

    metric = calculator.compute_direct_dedicated()

    assert metric.is_feasible is True
    assert metric.cargo_holding_cost_vnd == 1_000
    assert metric.total_cost_vnd == (
        metric.fuel_cost_vnd
        + metric.vehicle_fixed_cost_vnd
        + metric.driver_cost_vnd
        + metric.cargo_holding_cost_vnd
    )


def test_direct_dedicated_runs_two_trips_in_one_shift_and_drives_directly_to_next_pickup():
    vehicle = _vehicle(1).model_copy(update={"available_end_sec": 600})
    orders = [_order(1), _order(2)]
    # Matrix order is depot, pickup 1, delivery 1, pickup 2, delivery 2.
    matrix = [[0 if i == j else 60 for j in range(5)] for i in range(5)]
    matrix[2][3] = 10
    matrix[4][1] = 300
    request = _request(vehicles=[vehicle], orders=orders, distances=matrix, durations=matrix)
    metric = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).compute_direct_dedicated()

    assert metric.is_feasible
    assert metric.vehicles_used == 2 and metric.physical_vehicle_count == 1
    assert metric.planning_span_days == 1
    first, second = metric.routes
    assert first.route_id != second.route_id
    assert first.driver_id == second.driver_id
    assert [stop.allocation_id for stop in first.stops] == ['order-1', 'order-1']
    assert [stop.allocation_id for stop in second.stops] == ['order-2', 'order-2']
    assert first.end_time_sec == second.start_time_sec
    assert first.return_travel_time_sec == 0
    assert second.stops[0].travel_time_sec == 10
    assert second.return_travel_time_sec == 60
    assert metric.total_distance_km == 0.25
    assert first.end_location == second.depot == orders[0].delivery_location
    assert second.end_location == vehicle.depot
    assert metric.fuel_cost_vnd == 500


def test_direct_dedicated_uses_next_shift_when_two_trips_do_not_fit_in_one():
    vehicle = _vehicle(1).model_copy(update={"source_vehicle_id": "truck-1", "available_end_sec": 180})
    next_day = vehicle.model_copy(update={
        "id": "vehicle-1-next-day", "service_day_index": 1,
        "available_start_sec": 86_400, "available_end_sec": 86_580,
    })
    matrix = [[0 if i == j else 60 for j in range(6)] for i in range(6)]
    request = _request(vehicles=[vehicle, next_day], orders=[_order(1), _order(2)],
                       distances=matrix, durations=matrix)
    request.drivers[0] = request.drivers[0].model_copy(update={"source_driver_id": "drv-1", "service_day_index": 0})
    request.drivers[1] = request.drivers[1].model_copy(update={"source_driver_id": "drv-1", "service_day_index": 1})
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    comparison = calculator.build_comparison([], 100_000, 0, 0)

    assert comparison.direct_dedicated.is_feasible is True
    assert comparison.direct_dedicated.vehicles_used == 2
    assert comparison.direct_dedicated.physical_vehicle_count == 1
    assert comparison.direct_dedicated.planning_span_days == 2
    assert comparison.savings_vs_direct_vnd is not None


def test_direct_dedicated_reports_no_full_plan_when_available_shift_is_too_short():
    vehicle = _vehicle(1).model_copy(update={"available_end_sec": 180})
    orders = [_order(1), _order(2)]
    matrix = [[0 if i == j else 60 for j in range(5)] for i in range(5)]
    request = _request(vehicles=[vehicle], orders=orders, distances=matrix, durations=matrix)
    comparison = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).build_comparison([], 100_000, 0, 0)

    assert not comparison.direct_dedicated.is_feasible
    assert not comparison.direct_dedicated.routes
    assert comparison.savings_vs_direct_vnd is None


def test_direct_dedicated_assigns_the_large_truck_to_the_order_that_needs_it():
    vehicles = [
        _vehicle(1, length_cm=200),
        _vehicle(2).model_copy(update={"fixed_operating_cost_vnd": 150_000}),
    ]
    vehicles = [vehicle.model_copy(update={"available_end_sec": 180}) for vehicle in vehicles]
    orders = [_order(1), _order(2, length_cm=150)]
    matrix = [[0 if i == j else 60 for j in range(6)] for i in range(6)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    metric = calculator.compute_direct_dedicated()

    assert metric.is_feasible
    assert metric.vehicles_used == 2
    assert metric.vehicle_fixed_cost_vnd == sum(vehicle.fixed_operating_cost_vnd for vehicle in vehicles)


def test_build_comparison_includes_direct_dedicated_without_greedy():
    vehicle = _vehicle(1)
    order = _order(1, weight=500)
    distances = [
        [0, 100, 100],
        [100, 0, 100],
        [100, 100, 0],
    ]
    durations = [
        [0, 60, 60],
        [60, 0, 60],
        [60, 60, 0],
    ]
    request = _request(
        vehicles=[vehicle],
        orders=[order],
        distances=distances,
        durations=durations,
    )
    solver = FleetRoutingSolver(request)
    result = solver.solve()
    calculator = BaselineCostCalculator(request, solver.nodes)

    comparison = calculator.build_comparison(
        result.routes,
        result.total_cost_vnd,
        result.total_distance_km,
        result.total_duration_minutes,
    )

    assert comparison.direct_dedicated is not None
    assert comparison.or_tools is not None
    assert not hasattr(comparison, "greedy_heuristic")
    assert not hasattr(comparison, "savings_vs_greedy_vnd")


def test_cost_optimizer_may_use_one_vehicle_for_eleven_small_orders():
    vehicles = [_vehicle(index, length_cm=1_000, width_cm=200) for index in range(3)]
    orders = [_order(index) for index in range(1, 12)]
    size = len(vehicles) + 2 * len(orders)
    distances = [
        [0 if origin == destination else 100 for destination in range(size)]
        for origin in range(size)
    ]
    durations = [
        [0 if origin == destination else 1 for destination in range(size)]
        for origin in range(size)
    ]
    request = _request(
        vehicles=vehicles,
        orders=orders,
        distances=distances,
        durations=durations,
    )

    result = FleetRoutingSolver(request).solve()

    assert result.status == "SUCCESS"
    assert len(result.routes) == 1
    assert len(result.routes[0].stops) == 22


def test_solver_allows_full_floor_when_spatial_validator_confirms_access():
    vehicle = _vehicle(1)
    order = _order(1, length_cm=100, width_cm=100)
    size = 3
    distances = [
        [0 if origin == destination else 100 for destination in range(size)]
        for origin in range(size)
    ]
    durations = [
        [0 if origin == destination else 1 for destination in range(size)]
        for origin in range(size)
    ]
    request = _request(
        vehicles=[vehicle],
        orders=[order],
        distances=distances,
        durations=durations,
    )

    result = FleetRoutingSolver(request).solve()

    assert result.status == "SUCCESS"
    assert len(result.routes) == 1
    assert result.routes[0].spatial_validation.is_valid is True


def test_direct_dedicated_filters_non_rotatable_item_and_retries_after_spatial_rejection(monkeypatch):
    # Vehicle 1 is narrow (100x220): two 60x100 items pass total area (12000 <= 22000)
    # and per-item bounds, yet cannot share a 100cm-wide floor when rotation is locked.
    # Vehicle 2 (120x220) is slightly costlier so OR-Tools tries Vehicle 1 first,
    # gets rejected on spatial validation, and retries onto Vehicle 2.
    vehicles = [
        _vehicle(1, length_cm=220, width_cm=100).model_copy(
            update={"available_end_sec": 600, "fixed_operating_cost_vnd": 50_000}
        ),
        _vehicle(2, length_cm=220, width_cm=120).model_copy(
            update={"available_end_sec": 600, "fixed_operating_cost_vnd": 200_000}
        ),
    ]
    tight_order = _order(1, length_cm=60, width_cm=100).model_copy(
        update={
            "items": [
                CargoItem(
                    id="tight-1",
                    order_id="order-1",
                    length_cm=60,
                    width_cm=100,
                    height_cm=50,
                    weight_kg=10,
                    can_rotate=False,
                    allowed_orientations=["LWH"],
                ),
                CargoItem(
                    id="tight-2",
                    order_id="order-1",
                    length_cm=60,
                    width_cm=100,
                    height_cm=50,
                    weight_kg=10,
                    can_rotate=False,
                    allowed_orientations=["LWH"],
                ),
            ]
        }
    )
    non_rotatable_long_order = _order(2, length_cm=210, width_cm=90).model_copy(
        update={
            "items": [
                CargoItem(
                    id="long-1",
                    order_id="order-2",
                    length_cm=210,
                    width_cm=90,
                    height_cm=50,
                    weight_kg=10,
                    can_rotate=False,
                    allowed_orientations=["LWH"],
                )
            ]
        }
    )
    # Order 2 fits Vehicle 1 too, so let's make Vehicle 1 200x100 vs Vehicle 2 220x120
    # and check _passes_direct_load_bounds rejects rotated-only fit when can_rotate=False.
    vehicles[0] = vehicles[0].model_copy(update={"length_cm": 110, "width_cm": 150})
    tight_order = tight_order.model_copy(
        update={
            "items": [
                item.model_copy(update={"length_cm": 70, "width_cm": 90})
                for item in tight_order.items
            ]
        }
    )
    # On Vehicle 1 (110x150): 70x90 fits individually without rotation (70<=110, 90<=150),
    # area 2*6300 = 12600 <= 16500, yet two 70x90 boxes side-by-side need 140x90 or 70x180!
    # On Vehicle 2 (150x180): two 70x90 boxes fit side-by-side (140<=150, 90<=180).
    vehicles[1] = vehicles[1].model_copy(update={"length_cm": 150, "width_cm": 180})

    # Order 2: 140x100 with can_rotate=False cannot fit Vehicle 1 (110x150) without rotating.
    non_rotatable_long_order = non_rotatable_long_order.model_copy(
        update={
            "items": [
                CargoItem(
                    id="long-1",
                    order_id="order-2",
                    length_cm=140,
                    width_cm=100,
                    height_cm=50,
                    weight_kg=10,
                    can_rotate=False,
                    allowed_orientations=["LWH"],
                )
            ]
        }
    )
    # Order 3 fits Vehicle 1 easily so Vehicle 1 still gets used if needed, or only tight_order + non_rotatable.
    small_order = _order(3, length_cm=40, width_cm=40)
    orders = [tight_order, non_rotatable_long_order, small_order]
    size = len(vehicles) + 2 * len(orders)
    matrix = [[0 if i == j else 30 for j in range(size)] for i in range(size)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)

    import app.baseline_calculator as bc_mod

    spatial_calls = []
    real_validate = bc_mod.validate_stop_actions

    def counting_validate(*args, **kwargs):
        spatial_calls.append(True)
        return real_validate(*args, **kwargs)

    monkeypatch.setattr(bc_mod, "validate_stop_actions", counting_validate)
    calculator = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes)

    assert calculator._passes_direct_load_bounds(non_rotatable_long_order, vehicles[0]) is False
    assert calculator._passes_direct_load_bounds(non_rotatable_long_order, vehicles[1]) is True

    metric = calculator.compute_direct_dedicated()
    assert metric.is_feasible is True
    assert len(metric.routes) == 3
    assert all(route.spatial_validation.is_valid for route in metric.routes)
    tight_route = next(r for r in metric.routes if any(s.order_id == "order-1" for s in r.stops))
    assert tight_route.vehicle_id == "vehicle-2"
    # Spatial validation only runs on selected routes (not all 2*3 = 6 slot-order pairs up front).
    assert len(spatial_calls) <= 4


def test_direct_dedicated_caps_large_batch_budget_and_retries_if_first_pass_times_out(monkeypatch):
    import time
    from app.baseline_calculator import _DirectRoutingTimeout

    vehicles = [
        _vehicle(1, length_cm=200, width_cm=200).model_copy(
            update={
                "id": f"veh-day-{day}",
                "source_vehicle_id": "veh-1",
                "service_day_index": day,
                "available_start_sec": day * 86_400,
                "available_end_sec": day * 86_400 + 3_600,
            }
        )
        for day in range(2)
    ]
    orders = [_order(index, length_cm=20, width_cm=20) for index in range(1, 85)]
    size = len(vehicles) + 2 * len(orders)
    matrix = [[0 if i == j else 30 for j in range(size)] for i in range(size)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)
    request.drivers = [
        d.model_copy(update={"source_driver_id": "drv-1", "service_day_index": day})
        for day, d in enumerate(request.drivers)
    ]

    calculator = BaselineCostCalculator(
        request,
        FleetRoutingSolver(request).nodes,
        deadline=time.perf_counter() + 45.0,
    )
    observed_budgets = []

    def simulated_solve(slots, rejected_loads, routing_budget_ms):
        day_count = len({v.service_day_index for _, v, _ in slots})
        if day_count < 2:
            return None
        observed_budgets.append(routing_budget_ms)
        if len(observed_budgets) == 1:
            raise _DirectRoutingTimeout
        return []

    monkeypatch.setattr(calculator, "_solve_direct_schedule", simulated_solve)
    metric = calculator.compute_direct_dedicated()

    assert len(observed_budgets) == 2
    assert observed_budgets[0] <= 11_000
    assert observed_budgets[1] > observed_budgets[0]
    assert metric.is_feasible is False


def test_direct_dedicated_preserves_intermediate_horizon_budget(monkeypatch):
    import time

    vehicles = [
        _vehicle(1, length_cm=200, width_cm=200).model_copy(
            update={
                "id": f"veh-day-{day}",
                "source_vehicle_id": "veh-1",
                "service_day_index": day,
                "available_start_sec": day * 86_400,
                "available_end_sec": day * 86_400 + 3_600,
            }
        )
        for day in range(3)
    ]
    orders = [_order(index, length_cm=20, width_cm=20) for index in range(1, 85)]
    size = len(vehicles) + 2 * len(orders)
    matrix = [[0 if i == j else 30 for j in range(size)] for i in range(size)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)
    request.drivers = [
        d.model_copy(update={"source_driver_id": "drv-1", "service_day_index": day})
        for day, d in enumerate(request.drivers)
    ]

    calculator = BaselineCostCalculator(
        request,
        FleetRoutingSolver(request).nodes,
        deadline=time.perf_counter() + 45.0,
    )
    observed = []

    def simulated_solve(slots, rejected_loads, routing_budget_ms):
        observed.append((len({v.service_day_index for _, v, _ in slots}), routing_budget_ms))
        return None

    monkeypatch.setattr(calculator, "_solve_direct_schedule", simulated_solve)
    calculator.compute_direct_dedicated()

    # horizons = [0, 1, 2]; intermediate 2-day horizon (index=1) retains ~remaining*800/2 (> 10s),
    # while only the final 3-day horizon is capped at fast_cap_ms (<= 11s).
    assert len(observed) == 3
    assert observed[1][0] == 2 and observed[1][1] > 10_000
    assert observed[2][0] == 3 and observed[2][1] <= 11_000


def test_direct_dedicated_includes_operational_late_penalty_when_fee_mode_is_none():
    vehicle = _vehicle(1).model_copy(update={"available_end_sec": 86_400})
    order = _order(1).model_copy(
        update={
            "ordered_at_sec": -200_000,
            "pickup_window_start_sec": 0,
            "pickup_window_end_sec": 36_000,
            "delivery_window_start_sec": 0,
            "delivery_window_end_sec": 36_000,
        }
    )
    matrix = [[0 if i == j else 60 for j in range(3)] for i in range(3)]
    request = _request(vehicles=[vehicle], orders=[order], distances=matrix, durations=matrix)
    request.policy.delivery_grace_days = 1
    request.policy.late_delivery_penalty_mode = "NONE"

    metric = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).compute_direct_dedicated()
    assert metric.is_feasible is True
    assert metric.late_delivery_penalty_vnd == 0
    assert metric.operational_late_penalty_vnd > 0
    assert metric.selection_score_vnd == (
        metric.total_cost_vnd
        + metric.driver_idle_salary_allocation_vnd
        + metric.operational_late_penalty_vnd
    )


def test_direct_schedule_prefers_earlier_day_over_cheaper_later_day_truck():
    vehicles = [
        _vehicle(1).model_copy(
            update={
                "id": "veh-day-0-expensive",
                "source_vehicle_id": "phys-day-0",
                "service_day_index": 0,
                "available_start_sec": 28_800,
                "available_end_sec": 64_800,
                "fixed_operating_cost_vnd": 400_000,
            }
        ),
        _vehicle(2).model_copy(
            update={
                "id": "veh-day-1-cheap",
                "source_vehicle_id": "phys-day-1",
                "service_day_index": 1,
                "available_start_sec": 86_400 + 28_800,
                "available_end_sec": 86_400 + 64_800,
                "fixed_operating_cost_vnd": 10_000,
            }
        ),
    ]
    order = _order(1).model_copy(
        update={
            "pickup_window_start_sec": 28_800,
            "pickup_window_end_sec": 86_400 + 50_000,
            "delivery_window_start_sec": 28_800,
            "delivery_window_end_sec": 86_400 + 60_000,
        }
    )
    matrix = [[0 if i == j else 60 for j in range(4)] for i in range(4)]
    request = _request(vehicles=vehicles, orders=[order], distances=matrix, durations=matrix)
    request.drivers = [
        d.model_copy(update={"source_driver_id": f"phys-drv-{day}", "service_day_index": day})
        for day, d in enumerate(request.drivers)
    ]

    metric = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).compute_direct_dedicated()

    assert metric.is_feasible is True
    assert [route.service_day_index for route in metric.routes] == [0]
    assert metric.planning_span_days == 1


def test_direct_dedicated_includes_midpoint_horizon_on_four_plus_days(monkeypatch):
    import time

    vehicles = [
        _vehicle(1, length_cm=200, width_cm=200).model_copy(
            update={
                "id": f"veh-day-{day}",
                "source_vehicle_id": "veh-1",
                "service_day_index": day,
                "available_start_sec": day * 86_400,
                "available_end_sec": day * 86_400 + 3_600,
            }
        )
        for day in range(6)
    ]
    orders = [_order(index, length_cm=20, width_cm=20) for index in range(1, 5)]
    size = len(vehicles) + 2 * len(orders)
    matrix = [[0 if i == j else 30 for j in range(size)] for i in range(size)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)
    request.drivers = [
        d.model_copy(update={"source_driver_id": "drv-1", "service_day_index": day})
        for day, d in enumerate(request.drivers)
    ]

    calculator = BaselineCostCalculator(
        request,
        FleetRoutingSolver(request).nodes,
        deadline=time.perf_counter() + 45.0,
    )
    observed = []

    def simulated_solve(slots, rejected_loads, routing_budget_ms):
        observed.append(len({v.service_day_index for _, v, _ in slots}))
        return None

    monkeypatch.setattr(calculator, "_solve_direct_schedule", simulated_solve)
    calculator.compute_direct_dedicated()

    assert observed == [1, 2, 4, 6]


def test_direct_dedicated_does_not_penalize_day_one_when_two_days_are_required():
    # Each order needs 20 + 60 + 20 + 60 + 20 = 180s, so a 200s shift fits 1 order.
    # Day 0 has 2 vehicles (10k cheap + 400k expensive) => max 2 orders on Day 0, so
    # 3 orders force a 2-day horizon. Day 1 has two 10k vehicles; once 1-day fails,
    # Day 1 must not incur an extra-day slot tax that forces using the 400k Day 0 truck.
    vehicles = [
        _vehicle(1).model_copy(
            update={
                "id": "veh-day0-cheap",
                "source_vehicle_id": "phys-a",
                "service_day_index": 0,
                "available_start_sec": 0,
                "available_end_sec": 200,
                "fixed_operating_cost_vnd": 10_000,
            }
        ),
        _vehicle(2).model_copy(
            update={
                "id": "veh-day0-expensive",
                "source_vehicle_id": "phys-b",
                "service_day_index": 0,
                "available_start_sec": 0,
                "available_end_sec": 200,
                "fixed_operating_cost_vnd": 400_000,
            }
        ),
        _vehicle(3).model_copy(
            update={
                "id": "veh-day1-cheap-a",
                "source_vehicle_id": "phys-a",
                "service_day_index": 1,
                "available_start_sec": 86_400,
                "available_end_sec": 86_400 + 200,
                "fixed_operating_cost_vnd": 10_000,
            }
        ),
        _vehicle(4).model_copy(
            update={
                "id": "veh-day1-cheap-b",
                "source_vehicle_id": "phys-c",
                "service_day_index": 1,
                "available_start_sec": 86_400,
                "available_end_sec": 86_400 + 200,
                "fixed_operating_cost_vnd": 10_000,
            }
        ),
    ]
    orders = [
        _order(index).model_copy(
            update={
                "pickup_window_start_sec": 0,
                "pickup_window_end_sec": 86_400 + 180,
                "delivery_window_start_sec": 0,
                "delivery_window_end_sec": 86_400 + 180,
                "pickup_service_time_sec": 60,
                "delivery_service_time_sec": 60,
            }
        )
        for index in (1, 2, 3)
    ]
    size = len(vehicles) + 2 * len(orders)
    matrix = [[0 if i == j else 20 for j in range(size)] for i in range(size)]
    request = _request(vehicles=vehicles, orders=orders, distances=matrix, durations=matrix)
    request.drivers = [
        d.model_copy(
            update={
                "source_driver_id": f"phys-drv-{index}",
                "service_day_index": vehicles[index].service_day_index,
            }
        )
        for index, d in enumerate(request.drivers)
    ]
    metric = BaselineCostCalculator(request, FleetRoutingSolver(request).nodes).compute_direct_dedicated()
    assert metric.is_feasible is True
    assert metric.planning_span_days == 2
    assert "phys-b" not in {route.vehicle_id for route in metric.routes}
