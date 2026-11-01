"""Validated audit rows and versioned comparison objectives.

Legacy files retain operating-cost ranking. New production-profile files use
the application's objective without mixing the two experiment contracts.
"""
from typing import Literal, Optional, Tuple

from pydantic import BaseModel, Field, StrictBool, model_validator

from app.models import FleetOptimizationResponse, PlanningObjectiveBreakdown
from app.planning_objective import plan_lexicographic_key

PRODUCTION_PROFILE = "production_v1"
LEGACY_PROFILE = "legacy_operating_v1"


class Trial(BaseModel):
    case: str
    algorithm: str
    seed: int
    budget: float = Field(gt=0)
    objective_profile: Literal["production_v1", "legacy_operating_v1"] = LEGACY_PROFILE
    production_objective: Optional[PlanningObjectiveBreakdown] = None
    served_requests: int = Field(ge=0)
    total_requests: int = Field(gt=0)
    delivered_packages: int = Field(ge=0)
    total_packages: int = Field(gt=0)
    routes: int = Field(ge=0)
    physical_vehicles: Optional[int] = Field(default=None, ge=0)
    extra_order_trips: int = Field(ge=0)
    cost_vnd: int = Field(ge=0)
    complete_manifest: StrictBool
    unique_balanced_manifest: StrictBool
    spatial_valid: StrictBool
    basic_schedule_valid: StrictBool

    @property
    def audit_valid(self) -> bool:
        return self.unique_balanced_manifest and self.spatial_valid and self.basic_schedule_valid and self.routes > 0

    @property
    def verified(self) -> bool:
        return (self.audit_valid and self.complete_manifest
            and self.served_requests == self.total_requests
            and self.delivered_packages == self.total_packages)

    @model_validator(mode="after")
    def validate_production_objective(self):
        if self.objective_profile != PRODUCTION_PROFILE:
            return self
        objective = self.production_objective
        if objective is None:
            if self.audit_valid:
                raise ValueError("A valid production-profile trial needs its audited production objective")
            return self
        if not set(PlanningObjectiveBreakdown.model_fields) <= objective.model_fields_set:
            raise ValueError("Production objective fields must be explicit, not defaulted to zero")
        if (objective.operating_cost_vnd != self.cost_vnd
            or objective.active_route_count != self.routes
            or objective.extra_order_trips != self.extra_order_trips
            or objective.physical_vehicle_count != self.physical_vehicles):
            raise ValueError("Production objective does not match audited cost/grouping/fleet metrics")
        expected = max(0, self.cost_vnd - objective.driver_active_salary_allocation_vnd
            + objective.driver_calendar_salary_vnd + objective.operational_late_penalty_vnd)
        if objective.selection_score_vnd != expected:
            raise ValueError("Production selection score has inconsistent cost components")
        return self

    @property
    def operating_key(self) -> Tuple[int, int, int]:
        return self.extra_order_trips, self.routes, self.cost_vnd

    @property
    def key(self) -> Tuple[int, ...]:
        if self.objective_profile == LEGACY_PROFILE:
            return self.operating_key
        if self.production_objective is None:
            raise ValueError("Production objective is unavailable for this invalid trial")
        # A ranking-only aggregate view; no route or audited plan is invented.
        view = FleetOptimizationResponse(job_id=self.case, status="PARTIAL",
            total_cost_vnd=self.cost_vnd, planning_objective=self.production_objective)
        return plan_lexicographic_key(view)

    @property
    def dimension_names(self) -> Tuple[str, ...]:
        if self.objective_profile == LEGACY_PROFILE:
            return "extra_order_trips", "routes", "operating_cost_vnd"
        return "extra_order_trips", "routes", "selection_score_vnd", "operating_cost_vnd", "physical_vehicles"
