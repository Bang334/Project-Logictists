"""Shared candidate-ranking objective for every fleet search engine.

The reported route cost remains an operating-cost estimate. Candidate ranking
also accounts for fixed monthly salaries paid while the plan is still open and
for operational lateness when no financial late-fee policy is configured.
"""

from collections import defaultdict
from typing import Dict

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
    breakdown = PlanningObjectiveBreakdown(
        planning_span_days=planning_span_days,
        operating_cost_vnd=plan.total_cost_vnd,
        driver_active_salary_allocation_vnd=active_salary_vnd,
        driver_calendar_salary_vnd=calendar_salary_vnd,
        driver_idle_salary_allocation_vnd=idle_salary_vnd,
        operational_late_penalty_vnd=operational_late_penalty_vnd,
        selection_score_vnd=max(0, selection_score_vnd),
    )
    plan.planning_objective = breakdown
    return breakdown
