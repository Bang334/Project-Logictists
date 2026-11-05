"""Shared candidate-ranking objective for every fleet search engine.

The reported route cost remains an operating-cost estimate. Candidate ranking
follows the confirmed lexicographic hierarchy:
1. Serve all required orders/packages under hard constraints.
2. Minimize extra order trips: sum(max(0, distinct_trip_count(order) - 1)).
3. Minimize active route count (trips), tracking physical vehicles separately.
4. Minimize selection_score_vnd (operating cost + idle calendar salary + late penalty).
"""

from collections import defaultdict
from typing import Dict, Set, Tuple

from .models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    PlanningObjectiveBreakdown,
)


SECONDS_PER_DAY = 86_400


def operational_late_daily_weight_vnd(request: FleetOptimizationRequest) -> int:
    """Return the non-financial daily weight used only when no fee is configured."""
    if request.policy.late_delivery_penalty_mode != "NONE":
        return 0
    return max(1, request.policy.unassigned_order_penalty_vnd // 1000)


def _calendar_salary_vnd(
    request: FleetOptimizationRequest,
    planning_span_days: int,
    active_salary_vnd: int,
) -> int:
    if planning_span_days <= 0:
        return 0

    # Production fleet planning expands every physical resource into one slot
    # per service day. Legacy/single-vehicle requests do not, so retain their
    # existing active-time allocation instead of inventing a workday length.
    has_daily_resource_slots = any(
        vehicle.source_vehicle_id is not None for vehicle in request.vehicles
    ) and any(driver.source_driver_id is not None for driver in request.drivers)
    if not has_daily_resource_slots:
        return active_salary_vnd

    service_minutes_by_day: Dict[int, float] = defaultdict(float)
    for vehicle in request.vehicles:
        if vehicle.service_day_index >= planning_span_days:
            continue
        available_minutes = max(
            0.0,
            (vehicle.available_end_sec - vehicle.available_start_sec) / 60.0,
        )
        service_minutes_by_day[vehicle.service_day_index] = max(
            service_minutes_by_day[vehicle.service_day_index],
            available_minutes,
        )

    salary_vnd = 0
    seen_driver_days = set()
    for driver in request.drivers:
        day_index = driver.service_day_index
        if day_index >= planning_span_days:
            continue
        physical_driver_id = driver.source_driver_id or driver.id
        driver_day = (physical_driver_id, day_index)
        if driver_day in seen_driver_days:
            continue
        seen_driver_days.add(driver_day)
        salary_vnd += round(
            driver.fixed_salary_monthly_vnd
            * service_minutes_by_day.get(day_index, 0.0)
            / request.policy.monthly_working_minutes
        )

    # Never make a plan look cheaper merely because its resource snapshot is
    # incomplete. Active route salary is the conservative lower bound.
    return max(active_salary_vnd, salary_vnd)


def calendar_salary_for_span(request: FleetOptimizationRequest, planning_span_days: int) -> int:
    """Snapshot calendar payroll used to price a search horizon extension.

    Final objective calculation still applies its active-salary lower bound.
    Single-day legacy snapshots without daily resource slots add no calendar
    payroll beyond their existing active route allocation.
    """
    return _calendar_salary_vnd(request, planning_span_days, 0)


def _operational_late_penalty_vnd(
    request: FleetOptimizationRequest,
    plan: FleetOptimizationResponse,
) -> int:
    if request.policy.late_delivery_penalty_mode != "NONE":
        return 0

    order_by_id = {order.id: order for order in request.orders}
    latest_delivery_by_source_order: Dict[str, int] = {}
    optimizer_order_by_source: Dict[str, str] = {}
    for route in plan.routes:
        for stop in route.stops:
            if stop.stop_type != "DELIVERY":
                continue
            optimizer_order_id = stop.allocation_id or stop.order_id
            order = order_by_id.get(optimizer_order_id or "")
            if order is None:
                continue
            source_order_id = order.source_order_id or order.id
            optimizer_order_by_source.setdefault(source_order_id, order.id)
            latest_delivery_by_source_order[source_order_id] = max(
                latest_delivery_by_source_order.get(source_order_id, 0),
                stop.arrival_time_sec,
            )

    # This is a solver-only weight, not a customer-facing financial charge. It
    # reuses the existing OR-Tools scale instead of introducing a new business
    # amount while the branch penalty policy is disabled.
    daily_weight_vnd = operational_late_daily_weight_vnd(request)
    total = 0
    for source_order_id, delivered_at_sec in latest_delivery_by_source_order.items():
        order = order_by_id[optimizer_order_by_source[source_order_id]]
        grace_end_sec = (
            order.ordered_at_sec
            + request.policy.delivery_grace_days * SECONDS_PER_DAY
        )
        late_seconds = max(0, delivered_at_sec - grace_end_sec)
        total += round(daily_weight_vnd * late_seconds / SECONDS_PER_DAY)
    return total


def compute_grouping_metrics(
    request: FleetOptimizationRequest,
    plan: FleetOptimizationResponse,
) -> Dict[str, int]:
    """Compute order-grouping and fleet-usage metrics for a candidate plan."""
    order_by_id = {order.id: order for order in request.orders}
    source_by_order_id: Dict[str, str] = {}
    for order in request.orders:
        source_id = order.source_order_id or order.id
        source_by_order_id[order.id] = source_id
        source_by_order_id.setdefault(source_id, source_id)

    trips_by_source_order: Dict[str, Set[str]] = defaultdict(set)
    trips_by_request: Dict[str, Set[str]] = defaultdict(set)
    delivery_visits_by_source_order: Dict[str, Set[str]] = defaultdict(set)

    for route_index, route in enumerate(plan.routes):
        route_key = route.route_id or f"{route.vehicle_id}::{route_index}"
        for stop in route.stops:
            allocation_or_order = stop.allocation_id or stop.order_id or ""
            matched_order = order_by_id.get(allocation_or_order) or order_by_id.get(
                stop.order_id or ""
            )
            if matched_order is not None:
                source_order_id = matched_order.source_order_id or matched_order.id
                base_request_id = matched_order.id.split("::split:")[0]
            else:
                raw_id = stop.order_id or allocation_or_order.split("::split:")[0]
                if not raw_id:
                    continue
                source_order_id = source_by_order_id.get(raw_id, raw_id)
                base_request_id = (
                    allocation_or_order.split("::split:")[0] or raw_id
                )

            trips_by_source_order[source_order_id].add(route_key)
            trips_by_request[base_request_id].add(route_key)
            if stop.stop_type == "DELIVERY":
                delivery_visits_by_source_order[source_order_id].add(route_key)

    extra_order_trips = sum(
        max(0, len(route_keys) - 1)
        for route_keys in trips_by_source_order.values()
    )
    split_order_count = sum(
        1 for route_keys in trips_by_source_order.values() if len(route_keys) > 1
    )
    max_trips_per_order = max(
        (len(route_keys) for route_keys in trips_by_source_order.values()),
        default=0,
    )
    extra_request_trips = sum(
        max(0, len(route_keys) - 1)
        for route_keys in trips_by_request.values()
    )
    active_route_count = len(plan.routes)
    physical_vehicle_count = len(
        {route.vehicle_id for route in plan.routes if route.vehicle_id}
    )
    delivery_visit_count = sum(
        len(route_keys)
        for route_keys in delivery_visits_by_source_order.values()
    )

    return {
        "extra_order_trips": extra_order_trips,
        "split_order_count": split_order_count,
        "max_trips_per_order": max_trips_per_order,
        "extra_request_trips": extra_request_trips,
        "active_route_count": active_route_count,
        "physical_vehicle_count": physical_vehicle_count,
        "delivery_visit_count": delivery_visit_count,
    }


def plan_lexicographic_key(
    plan: FleetOptimizationResponse,
) -> Tuple[int, int, int, int, int]:
    """Return the confirmed lexicographic comparison tuple for two plans.

    Ordering:
    1. extra_order_trips: sum(max(0, distinct_trip_count(order) - 1))
    2. active_route_count: total active trips
    3. selection_score_vnd: financial + calendar + operational lateness score
    4. total_cost_vnd: direct operating cost tie-breaker
    5. physical_vehicle_count: distinct physical vehicles tie-breaker
    """
    breakdown = plan.planning_objective
    if breakdown is not None:
        extra_order_trips = breakdown.extra_order_trips
        active_route_count = (
            breakdown.active_route_count
            if breakdown.active_route_count > 0 or not plan.routes
            else len(plan.routes)
        )
        selection_score_vnd = breakdown.selection_score_vnd
        physical_vehicle_count = (
            breakdown.physical_vehicle_count
            if breakdown.physical_vehicle_count > 0 or not plan.routes
            else len({route.vehicle_id for route in plan.routes if route.vehicle_id})
        )
    else:
        trips_by_order: Dict[str, Set[str]] = defaultdict(set)
        for idx, route in enumerate(plan.routes):
            r_key = route.route_id or f"{route.vehicle_id}::{idx}"
            for stop in route.stops:
                oid = stop.order_id or (
                    stop.allocation_id.split("::split:")[0]
                    if stop.allocation_id
                    else ""
                )
                if oid:
                    trips_by_order[oid].add(r_key)
        extra_order_trips = sum(
            max(0, len(r_keys) - 1) for r_keys in trips_by_order.values()
        )
        active_route_count = len(plan.routes)
        selection_score_vnd = plan.total_cost_vnd
        physical_vehicle_count = len(
            {route.vehicle_id for route in plan.routes if route.vehicle_id}
        )

    return (
        extra_order_trips,
        active_route_count,
        selection_score_vnd,
        plan.total_cost_vnd,
        physical_vehicle_count,
    )


def apply_planning_objective(
    request: FleetOptimizationRequest,
    plan: FleetOptimizationResponse,
) -> PlanningObjectiveBreakdown:
    planning_span_days = (
        max(route.service_day_index for route in plan.routes) + 1
        if plan.routes
        else 0
    )
    active_salary_vnd = sum(
        route.cost.driver_fixed_salary_allocation_vnd
        for route in plan.routes
        if route.cost is not None
    )
    calendar_salary_vnd = _calendar_salary_vnd(
        request,
        planning_span_days,
        active_salary_vnd,
    )
    idle_salary_vnd = max(0, calendar_salary_vnd - active_salary_vnd)
    operational_late_penalty_vnd = _operational_late_penalty_vnd(request, plan)
    selection_score_vnd = (
        plan.total_cost_vnd
        - active_salary_vnd
        + calendar_salary_vnd
        + operational_late_penalty_vnd
    )
    grouping = compute_grouping_metrics(request, plan)
    breakdown = PlanningObjectiveBreakdown(
        planning_span_days=planning_span_days,
        operating_cost_vnd=plan.total_cost_vnd,
        driver_active_salary_allocation_vnd=active_salary_vnd,
        driver_calendar_salary_vnd=calendar_salary_vnd,
        driver_idle_salary_allocation_vnd=idle_salary_vnd,
        operational_late_penalty_vnd=operational_late_penalty_vnd,
        selection_score_vnd=max(0, selection_score_vnd),
        **grouping,
    )
    plan.planning_objective = breakdown
    return breakdown
