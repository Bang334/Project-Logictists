"""Normalize benchmark fixtures to branch daytime shifts spanning several days.

Business rule (confirmed by the user):
- Vehicles and drivers only work inside the branch shift of each service day
  (default 08:00-17:00); no driving during the night (17:00 -> 08:00).
- Work that cannot be finished on one day may be carried over to the
  following service days, each again limited to the daytime shift.

Fixtures whose resource slots already respect the daytime shift (the DB
snapshots with ``service_day_index`` 0..6) are returned unchanged. Every
other fixture is mapped by *working time*: the time elapsed inside the
original resource availability is laid onto consecutive daytime shifts.
The mapping is monotone, keeps the window width measured in working
seconds, keeps travel/service matrices untouched and is identical to a
pure shift for everything that already fits inside day 0.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

from app.models import DriverOption, FleetOptimizationRequest, FleetVehicle, OrderPair

SECONDS_PER_DAY = 86_400
CASES_DIR = Path(__file__).resolve().parents[1] / "cases"


@dataclass(frozen=True)
class DaytimeShift:
    open_sec: int = 8 * 3600
    close_sec: int = 17 * 3600

    @property
    def length_sec(self) -> int:
        return self.close_sec - self.open_sec

    def day_bounds(self, day_index: int) -> Tuple[int, int]:
        base = day_index * SECONDS_PER_DAY
        return base + self.open_sec, base + self.close_sec


@dataclass(frozen=True)
class NormalizedCase:
    name: str
    request: FleetOptimizationRequest
    service_days: int
    was_remapped: bool


def parse_clock(clock: str) -> int:
    hours, minutes = map(int, clock.split(":"))
    return hours * 3600 + minutes * 60


def list_case_files(cases_dir: Path = CASES_DIR) -> List[str]:
    return sorted(path.name for path in cases_dir.glob("*.json"))


def daytime_violations(request: FleetOptimizationRequest, shift: DaytimeShift) -> List[str]:
    errors: List[str] = []
    for vehicle in request.vehicles:
        day_open, day_close = shift.day_bounds(vehicle.service_day_index)
        if vehicle.available_start_sec < day_open or vehicle.available_end_sec > day_close:
            errors.append(f"vehicle slot {vehicle.id} outside daytime shift")
    return errors


def is_daytime_compliant(request: FleetOptimizationRequest, shift: DaytimeShift) -> bool:
    return not daytime_violations(request, shift)


class _WorkingTimeline:
    """Measure working seconds inside merged resource availability intervals."""

    def __init__(self, intervals: Iterable[Tuple[int, int]], origin_sec: int):
        merged: List[Tuple[int, int]] = []
        for start, end in sorted(intervals):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        if not merged:
            raise ValueError("fixture has no vehicle availability interval")
        self.intervals = merged
        self.origin_sec = self._snap_forward(origin_sec)

    def _snap_forward(self, time_sec: int) -> int:
        for start, end in self.intervals:
            if time_sec <= end:
                return max(time_sec, start)
        return self.intervals[-1][1]

    def working_seconds(self, time_sec: int) -> int:
        total = 0
        for start, end in self.intervals:
            low = max(start, self.origin_sec)
            high = min(end, time_sec)
            if high > low:
                total += high - low
        return total


def _map_working_seconds(working_sec: int, shift: DaytimeShift, is_window_end: bool) -> int:
    # A window end landing exactly on a shift boundary belongs to the closing
    # time of the earlier day, not to the opening time of the next one.
    if is_window_end and working_sec > 0 and working_sec % shift.length_sec == 0:
        day_index = working_sec // shift.length_sec - 1
        offset = shift.length_sec
    else:
        day_index = working_sec // shift.length_sec
        offset = working_sec % shift.length_sec
    return day_index * SECONDS_PER_DAY + shift.open_sec + offset


def _map_time(timeline: _WorkingTimeline, time_sec: int, shift: DaytimeShift, is_window_end: bool) -> int:
    return _map_working_seconds(timeline.working_seconds(time_sec), shift, is_window_end)


def _remap_order(order: OrderPair, timeline: _WorkingTimeline, shift: DaytimeShift) -> OrderPair:
    pickup_start = _map_time(timeline, order.pickup_window_start_sec, shift, False)
    pickup_end = _map_time(timeline, order.pickup_window_end_sec, shift, True)
    delivery_start = _map_time(timeline, order.delivery_window_start_sec, shift, False)
    delivery_end = _map_time(timeline, order.delivery_window_end_sec, shift, True)
    if pickup_start > pickup_end or delivery_start > delivery_end:
        raise ValueError(f"order {order.id} has a window outside every working interval")
    if order.ordered_at_sec <= timeline.origin_sec:
        ordered_at = shift.open_sec - (timeline.origin_sec - order.ordered_at_sec)
    else:
        ordered_at = _map_time(timeline, order.ordered_at_sec, shift, False)
    return order.model_copy(
        update={
            "ordered_at_sec": ordered_at,
            "pickup_window_start_sec": pickup_start,
            "pickup_window_end_sec": pickup_end,
            "delivery_window_start_sec": delivery_start,
            "delivery_window_end_sec": delivery_end,
        }
    )


def _physical_vehicle_id(vehicle: FleetVehicle) -> str:
    return vehicle.source_vehicle_id or vehicle.id


def _physical_driver_id(driver: DriverOption) -> str:
    return driver.source_driver_id or driver.id


def _build_vehicle_slots(
    vehicles: Sequence[FleetVehicle],
    timeline: _WorkingTimeline,
    shift: DaytimeShift,
    service_days: int,
) -> List[FleetVehicle]:
    template_by_physical: Dict[str, FleetVehicle] = {}
    hull_by_slot: Dict[Tuple[str, int], Tuple[int, int]] = {}
    for vehicle in vehicles:
        physical_id = _physical_vehicle_id(vehicle)
        template_by_physical.setdefault(physical_id, vehicle)
        mapped_start = _map_time(timeline, vehicle.available_start_sec, shift, False)
        mapped_end = _map_time(timeline, vehicle.available_end_sec, shift, True)
        for day_index in range(service_days):
            day_open, day_close = shift.day_bounds(day_index)
            start, end = max(mapped_start, day_open), min(mapped_end, day_close)
            if start >= end:
                continue
            key = (physical_id, day_index)
            previous = hull_by_slot.get(key)
            hull_by_slot[key] = (start, end) if previous is None else (
                min(previous[0], start), max(previous[1], end)
            )

    slots: List[FleetVehicle] = []
    for (physical_id, day_index), (start, end) in sorted(
        hull_by_slot.items(), key=lambda entry: (entry[0][1], entry[0][0])
    ):
        slots.append(
            template_by_physical[physical_id].model_copy(
                update={
                    "id": f"{physical_id}::day:{day_index}",
                    "source_vehicle_id": physical_id,
                    "service_day_index": day_index,
                    "available_start_sec": start,
                    "available_end_sec": end,
                }
            )
        )
    return slots


def _build_driver_slots(drivers: Sequence[DriverOption], service_days: int) -> List[DriverOption]:
    template_by_physical: Dict[str, DriverOption] = {}
    for driver in drivers:
        template_by_physical.setdefault(_physical_driver_id(driver), driver)
    return [
        template.model_copy(
            update={
                "id": f"{physical_id}::day:{day_index}",
                "source_driver_id": physical_id,
                "service_day_index": day_index,
            }
        )
        for day_index in range(service_days)
        for physical_id, template in template_by_physical.items()
    ]


def _expand_matrix(matrix: List[List[float]], source_index: Sequence[int]) -> List[List[float]]:
    return [[matrix[row][col] for col in source_index] for row in source_index]


def _node_source_indices(
    original: FleetOptimizationRequest, vehicles: Sequence[FleetVehicle]
) -> List[int]:
    # Matrix nodes are ordered as [one depot node per vehicle slot] followed by
    # [pickup, delivery] per order; a new slot reuses its template's depot node.
    first_index_by_physical: Dict[str, int] = {}
    for index, vehicle in enumerate(original.vehicles):
        first_index_by_physical.setdefault(_physical_vehicle_id(vehicle), index)
    vehicle_nodes = [first_index_by_physical[_physical_vehicle_id(v)] for v in vehicles]
    old_vehicle_count = len(original.vehicles)
    order_nodes = [old_vehicle_count + i for i in range(2 * len(original.orders))]
    return vehicle_nodes + order_nodes


def normalize_request(
    request: FleetOptimizationRequest,
    shift: DaytimeShift = DaytimeShift(),
) -> Tuple[FleetOptimizationRequest, int, bool]:
    """Return (daytime request, number of service days, whether it was remapped)."""
    if is_daytime_compliant(request, shift):
        days = max(vehicle.service_day_index for vehicle in request.vehicles) + 1
        return request, days, False

    earliest_pickup = min(order.pickup_window_start_sec for order in request.orders)
    timeline = _WorkingTimeline(
        ((v.available_start_sec, v.available_end_sec) for v in request.vehicles),
        earliest_pickup,
    )
    orders = [_remap_order(order, timeline, shift) for order in request.orders]
    service_days = max(
        order.delivery_window_end_sec // SECONDS_PER_DAY for order in orders
    ) + 1
    vehicles = _build_vehicle_slots(request.vehicles, timeline, shift, service_days)
    drivers = _build_driver_slots(request.drivers, service_days)
    node_sources = _node_source_indices(request, vehicles)
    normalized = request.model_copy(
        update={
            "orders": orders,
            "vehicles": vehicles,
            "drivers": drivers,
            "distance_matrix_meters": _expand_matrix(request.distance_matrix_meters, node_sources),
            "duration_matrix_seconds": _expand_matrix(request.duration_matrix_seconds, node_sources),
        }
    )
    # Re-validate so pydantic invariants (window ordering, matrix shape) hold.
    return FleetOptimizationRequest.model_validate(normalized.model_dump()), service_days, True


def _allow_floor_rotation(raw: dict) -> None:
    # Floor rotation policy D11 is applied identically to every engine; the
    # lightweight benchmark converter forces it too, so production engines
    # must receive the same flag to keep the comparison fair.
    for order in raw["orders"]:
        for item in order["items"]:
            item["can_rotate"] = True


def load_daytime_case(
    case_file: str,
    shift: DaytimeShift = DaytimeShift(),
    cases_dir: Path = CASES_DIR,
) -> NormalizedCase:
    raw = json.loads((cases_dir / case_file).read_text(encoding="utf-8"))
    raw.pop("scenario_profile", None)
    _allow_floor_rotation(raw)
    raw["job_id"] = "day_" + str(raw.get("job_id", case_file))
    request = FleetOptimizationRequest.model_validate(raw)
    normalized, service_days, was_remapped = normalize_request(request, shift)
    return NormalizedCase(
        name="day_" + case_file,
        request=normalized,
        service_days=service_days,
        was_remapped=was_remapped,
    )


def describe_case(case: NormalizedCase) -> str:
    req = case.request
    return (
        f"{case.name}: orders={len(req.orders)}, vehicle_slots={len(req.vehicles)}, "
        f"driver_slots={len(req.drivers)}, days={case.service_days}, "
        f"remapped={case.was_remapped}"
    )


__all__ = [
    "DaytimeShift",
    "NormalizedCase",
    "daytime_violations",
    "describe_case",
    "is_daytime_compliant",
    "list_case_files",
    "load_daytime_case",
    "normalize_request",
    "parse_clock",
]
