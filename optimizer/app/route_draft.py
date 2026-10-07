"""Route data shared between OR-Tools extraction and candidate post-processing."""
from dataclasses import dataclass, field
from typing import List, Set

from .models import ScheduledStop, StopAction


@dataclass
class RouteDraft:
    """A vehicle route before spatial validation, recovery and costing."""

    vehicle_index: int
    start_time_sec: int
    end_time_sec: float
    distance_meters: float
    scheduled_stops: List[ScheduledStop]
    stop_actions: List[StopAction]
    order_ids: Set[str] = field(default_factory=set)
