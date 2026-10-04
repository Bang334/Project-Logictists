"""Adaptive search policy for fleet optimization.

The caller supplies a hard upper bound.  This module derives the actual
per-search budget and strategy count from the problem shape so tiny jobs do
not spend the same amount of CPU time as large dispatch batches.
"""

from dataclasses import dataclass
import math
from typing import Optional

from .models import FleetOptimizationRequest


MAX_SEARCH_BUDGET_SECONDS = 120


@dataclass(frozen=True)
class AdaptiveSearchPolicy:
    time_budget_seconds: int
    strategy_count: int
    stagnation_seconds: float
    complexity_score: float
    routing_budget_share: float
    validation_budget_share: float
    consolidation_budget_share: float


def calculate_search_policy(
    *,
    order_count: int,
    item_count: int,
    physical_vehicle_count: int,
    virtual_vehicle_count: int,
    requested_max_time_seconds: int,
) -> AdaptiveSearchPolicy:
    """Return a monotonic, bounded policy for the supplied problem shape.

    ``virtual_vehicle_count`` includes service-day copies.  Physical vehicles
    are weighted more heavily because they add real assignment alternatives;
    day copies still add routing nodes but should not make a two-order job look
    like a large fleet problem.
    """
    caller_cap = max(
        1,
        min(int(requested_max_time_seconds), MAX_SEARCH_BUDGET_SECONDS),
    )
    safe_order_count = max(0, int(order_count))
    safe_item_count = max(0, int(item_count))
    safe_physical_vehicle_count = max(1, int(physical_vehicle_count))
    safe_virtual_vehicle_count = max(
        safe_physical_vehicle_count,
        int(virtual_vehicle_count),
    )

    complexity_score = (
        safe_order_count * 1.10
        + safe_item_count * 0.15
        + safe_physical_vehicle_count * 0.75
        + safe_virtual_vehicle_count * 0.10
    )

    is_tiny = (
        safe_order_count <= 2
        and safe_item_count <= 4
        and safe_physical_vehicle_count <= 2
    )
    if is_tiny:
        desired_budget = 3
    else:
        # Package-heavy and multi-resource jobs need disproportionately more
        # local-search time than tiny routing graphs.  Scale the shared score
        # while retaining the caller-provided and global 120-second caps.
        desired_budget = math.ceil(5 + complexity_score * 1.30)

    time_budget_seconds = min(caller_cap, max(1, desired_budget))
    if time_budget_seconds <= 3:
        strategy_count = 2
        desired_stagnation = 0.5
        phase_shares = (0.60, 0.25, 0.15)
    elif time_budget_seconds <= 20:
        strategy_count = 3
        desired_stagnation = 1.5
        phase_shares = (0.65, 0.20, 0.15)
    elif time_budget_seconds <= 60:
        strategy_count = 4
        phase_shares = (0.72, 0.18, 0.10)
        desired_stagnation = max(
            4.0,
            min(12.0, time_budget_seconds * phase_shares[0] * 0.20),
        )
    else:
        strategy_count = 6
        phase_shares = (0.78, 0.14, 0.08)
        desired_stagnation = max(
            12.0,
            min(24.0, time_budget_seconds * phase_shares[0] * 0.25),
        )

    stagnation_seconds = round(
        max(
            0.2,
            min(desired_stagnation, time_budget_seconds * 0.4),
        ),
        2,
    )
    return AdaptiveSearchPolicy(
        time_budget_seconds=time_budget_seconds,
        strategy_count=strategy_count,
        stagnation_seconds=stagnation_seconds,
        complexity_score=round(complexity_score, 2),
        routing_budget_share=phase_shares[0],
        validation_budget_share=phase_shares[1],
        consolidation_budget_share=phase_shares[2],
    )


def derive_search_policy(request: FleetOptimizationRequest) -> AdaptiveSearchPolicy:
    physical_vehicle_ids = {
        vehicle.source_vehicle_id or vehicle.id for vehicle in request.vehicles
    }
    physical_driver_ids = {
        driver.source_driver_id or driver.id for driver in request.drivers
    }
    usable_physical_resources = max(
        1,
        min(len(physical_vehicle_ids), len(physical_driver_ids)),
    )
    return calculate_search_policy(
        order_count=len(request.orders),
        item_count=sum(len(order.items) for order in request.orders),
        physical_vehicle_count=usable_physical_resources,
        virtual_vehicle_count=len(request.vehicles),
        requested_max_time_seconds=request.max_time_seconds,
    )


class SearchProgressTracker:
    """Track objective stagnation after a fully served routing solution exists."""

    def __init__(self, stagnation_seconds: float):
        if stagnation_seconds <= 0:
            raise ValueError("stagnation_seconds must be greater than zero")
        self.stagnation_seconds = float(stagnation_seconds)
        self.best_objective: Optional[int] = None
        self.last_improvement_seconds = 0.0
        self.fully_served_seen = False

    def observe(
        self,
        *,
        objective: int,
        fully_served: bool,
        elapsed_seconds: float,
    ) -> None:
        if self.best_objective is None or objective < self.best_objective:
            self.best_objective = objective
            self.last_improvement_seconds = elapsed_seconds
        if fully_served:
            self.fully_served_seen = True

    def should_stop(self, elapsed_seconds: float) -> bool:
        return (
            self.fully_served_seen
            and self.best_objective is not None
            and elapsed_seconds - self.last_improvement_seconds
            >= self.stagnation_seconds
        )
