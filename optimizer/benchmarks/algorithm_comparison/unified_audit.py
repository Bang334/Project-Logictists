"""Independent audit and uniform re-costing of benchmark plans.

Every engine returns its own cost figure, computed by different evaluators
(production ``_build_final_response`` for Hybrid ALNS/ILS, the lightweight
hybrid cost model for HGS/GVNS-Pool/CASA-ILS). To compare engines fairly the
audit recomputes the operating cost of every plan from its stop sequence with
the production formulas (``calculate_route_economic_metrics`` and the
Hungarian ``DriverMatcher``) and never trusts reported distances, weights or
durations.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from app.driver_matcher import DriverMatcher
from app.models import (
    FleetOptimizationRequest,
    FleetOptimizationResponse,
    FleetVehicle,
    OptimizedRoute,
    RouteCostBreakdown,
    ScheduledStop,
    StopAction,
)
from app.route_costing import calculate_late_delivery_penalty, calculate_route_economic_metrics
from app.spatial_validator import SpatialValidator
from app.planning_objective import apply_planning_objective

from .daytime_cases import DaytimeShift
from .benchmark_objective import PRODUCTION_PROFILE
from .layout_certificate import verify_layout_certificate

TIME_TOLERANCE_SEC = 1


@dataclass
class _StopView:
    stop_type: str
    request_id: str
    loads: List[str]
    unloads: List[str]
    arrival_sec: int
    departure_sec: int


@dataclass
class _RouteView:
    vehicle_index: int
    vehicle: FleetVehicle
    stops: List[_StopView] = field(default_factory=list)


class PlanAuditor:
    def __init__(self, request: FleetOptimizationRequest, shift: DaytimeShift):
        self.request = request
        self.shift = shift
        # D11 is the same floor-rotation policy used by production builders and
        # every benchmark converter, independently of legacy fixture flags.
        self.cargo = {item.id: item.model_copy(update={"can_rotate": True})
            for order in request.orders for item in order.items}
        self.orders = {order.id: order for order in request.orders}
        self.owner = {item.id: order.id for order in request.orders for item in order.items}
        self.order_index = {order.id: index for index, order in enumerate(request.orders)}
        self.vehicle_index = {vehicle.id: index for index, vehicle in enumerate(request.vehicles)}
        self.vehicle_count = len(request.vehicles)

    # ------------------------------------------------------------------ views
    def _resolve_vehicle(self, route, is_raw_hybrid: bool) -> Optional[int]:
        slot_id = route.vehicle.id if is_raw_hybrid else (route.route_id or route.vehicle_id)
        if slot_id in self.vehicle_index:
            return self.vehicle_index[slot_id]
        physical = route.vehicle_id if not is_raw_hybrid else slot_id
        day = getattr(route, "service_day_index", 0)
        for index, vehicle in enumerate(self.request.vehicles):
            if (vehicle.source_vehicle_id or vehicle.id) == physical and vehicle.service_day_index == day:
                return index
        return None

    def _stop_view(self, stop, is_raw_hybrid: bool) -> Optional[_StopView]:
        if stop.stop_type not in ("PICKUP", "DELIVERY"):
            return None
        raw_id = (getattr(stop, "allocation_id", None) or stop.order_id) or ""
        request_id = raw_id.split("::split:")[0]
        loads, unloads = list(stop.items_loaded), list(stop.items_unloaded)
        return _StopView(
            stop_type=stop.stop_type,
            request_id=request_id,
            loads=loads,
            unloads=unloads,
            arrival_sec=int(stop.arrival_time_sec),
            departure_sec=int(stop.departure_time_sec),
        )

    def _node_of(self, stop: _StopView) -> int:
        order_position = self.order_index[stop.request_id]
        offset = 0 if stop.stop_type == "PICKUP" else 1
        return self.vehicle_count + 2 * order_position + offset

    # ----------------------------------------------------------------- checks
    def _check_schedule(self, view: _RouteView, errors: List[str]) -> Tuple[int, int]:
        durations = self.request.duration_matrix_seconds
        vehicle = view.vehicle
        day_open, day_close = self.shift.day_bounds(vehicle.service_day_index)
        previous_node, previous_departure = view.vehicle_index, None
        for stop in view.stops:
            node = self._node_of(stop)
            if previous_departure is not None and (
                stop.arrival_sec + TIME_TOLERANCE_SEC < previous_departure + durations[previous_node][node]
            ):
                errors.append("travel time inconsistency")
            if stop.departure_sec + TIME_TOLERANCE_SEC < stop.arrival_sec:
                errors.append("departure before arrival")
            previous_node, previous_departure = node, stop.departure_sec

        first, last = view.stops[0], view.stops[-1]
        route_start = max(
            vehicle.available_start_sec,
            first.arrival_sec - durations[view.vehicle_index][self._node_of(first)],
        )
        route_end = last.departure_sec + durations[previous_node][view.vehicle_index]
        if route_start < day_open - TIME_TOLERANCE_SEC or route_end > day_close + TIME_TOLERANCE_SEC:
            errors.append("route outside daytime shift (night driving)")
        if route_start < vehicle.available_start_sec - TIME_TOLERANCE_SEC or (
            route_end > vehicle.available_end_sec + TIME_TOLERANCE_SEC
        ):
            errors.append("vehicle availability")
        return route_start, route_end

    def _check_windows(self, view: _RouteView, stop: _StopView, errors: List[str]) -> None:
        affected = {self.owner[cid] for cid in stop.loads + stop.unloads}
        physical = view.vehicle.source_vehicle_id or view.vehicle.id
        for order_id in affected:
            order = self.orders[order_id]
            if stop.stop_type == "PICKUP":
                start, end = order.pickup_window_start_sec, order.pickup_window_end_sec
            else:
                start, end = order.delivery_window_start_sec, order.delivery_window_end_sec
            if not (start - TIME_TOLERANCE_SEC <= stop.arrival_sec <= end + TIME_TOLERANCE_SEC):
                errors.append(f"window {order_id}")
            if order.allowed_source_vehicle_ids and physical not in order.allowed_source_vehicle_ids:
                errors.append(f"allowed vehicle {order_id}")

    # ------------------------------------------------------------------- cost
    def _route_cost(self, view: _RouteView, route_start: int, route_end: int) -> OptimizedRoute:
        nodes = [{"id": f"n{index}"} for index in range(len(self.request.distance_matrix_meters))]
        onboard_kg = 0.0
        scheduled: List[ScheduledStop] = []
        for sequence, stop in enumerate(view.stops, start=1):
            onboard_kg += sum(self.cargo[cid].weight_kg for cid in stop.loads)
            onboard_kg -= sum(self.cargo[cid].weight_kg for cid in stop.unloads)
            scheduled.append(
                ScheduledStop.model_construct(
                    sequence=sequence,
                    location_id=f"n{self._node_of(stop)}",
                    stop_type=stop.stop_type,
                    allocation_id=stop.request_id,
                    order_id=stop.request_id,
                    arrival_time_sec=stop.arrival_sec,
                    departure_time_sec=stop.departure_sec,
                    current_weight_kg=max(0.0, onboard_kg),
                )
            )
        base_fuel, load_fuel, holding, ton_km, ton_hours = calculate_route_economic_metrics(
            self.request, nodes, self.orders, view.vehicle, scheduled
        )
        late_penalty = sum(
            calculate_late_delivery_penalty(self.orders[s.request_id], s.arrival_sec, self.request.policy)
            for s in view.stops
            if s.stop_type == "DELIVERY"
        )
        distance_m = 0.0
        previous = view.vehicle_index
        for stop in view.stops:
            node = self._node_of(stop)
            distance_m += self.request.distance_matrix_meters[previous][node]
            previous = node
        distance_m += self.request.distance_matrix_meters[previous][view.vehicle_index]
        vehicle = view.vehicle
        fuel = base_fuel + load_fuel
        return OptimizedRoute.model_construct(
            route_id=vehicle.id,
            vehicle_id=vehicle.source_vehicle_id or vehicle.id,
            service_day_index=vehicle.service_day_index,
            total_distance_km=round(distance_m / 1000.0, 2),
            total_duration_minutes=round((route_end - route_start) / 60.0, 1),
            stops=scheduled,
            cost=RouteCostBreakdown(
                base_fuel_cost_vnd=base_fuel,
                load_fuel_surcharge_vnd=load_fuel,
                fuel_cost_vnd=fuel,
                cargo_holding_cost_vnd=holding,
                late_delivery_penalty_vnd=late_penalty,
                cargo_distance_ton_km=ton_km,
                cargo_time_ton_hours=ton_hours,
                vehicle_fixed_cost_vnd=vehicle.fixed_operating_cost_vnd,
                driver_fixed_salary_allocation_vnd=0,
                driver_trip_pay_vnd=0,
                total_cost_vnd=fuel + vehicle.fixed_operating_cost_vnd + holding + late_penalty,
            ),
        )

    def _uniform_cost(self, costed_routes: List[OptimizedRoute], errors: List[str]) -> Optional[int]:
        if not costed_routes:
            return 0
        try:
            matched = DriverMatcher(self.request).assign_drivers_to_routes(costed_routes)
        except ValueError as error:
            errors.append(f"driver assignment: {error}")
            return None
        return sum(route.cost.total_cost_vnd for route in matched)

    # ------------------------------------------------------------------ audit
    def audit(self, result, is_raw_hybrid: bool) -> dict:
        loaded, delivered = Counter(), Counter()
        parent_trips: Dict[str, set] = defaultdict(set)
        spatial_errors: List[str] = []
        schedule_errors: List[str] = []
        costed_routes: List[OptimizedRoute] = []
        used_slots: Counter = Counter()
        certificate_routes = 0
        search_routes = 0

        for route_number, route in enumerate(result.routes):
            vehicle_index = self._resolve_vehicle(route, is_raw_hybrid)
            if vehicle_index is None:
                spatial_errors.append("unknown vehicle slot")
                continue
            view = _RouteView(vehicle_index, self.request.vehicles[vehicle_index])
            used_slots[view.vehicle.id] += 1
            for stop in route.stops:
                stop_view = self._stop_view(stop, is_raw_hybrid)
                if stop_view is None:
                    continue
                if stop_view.request_id not in self.orders or any(
                    cid not in self.cargo for cid in stop_view.loads + stop_view.unloads
                ):
                    spatial_errors.append("unknown order or package ID")
                    continue
                view.stops.append(stop_view)
            if not view.stops:
                continue

            onboard: set = set()
            actions: List[StopAction] = []
            for stop in view.stops:
                for cid in stop.loads:
                    loaded[cid] += 1
                    order = self.orders[self.owner[cid]]
                    parent_trips[order.source_order_id or order.id].add(route_number)
                    onboard.add(cid)
                for cid in stop.unloads:
                    delivered[cid] += 1
                    if cid not in onboard:
                        schedule_errors.append("delivery without onboard pickup")
                    onboard.discard(cid)
                self._check_windows(view, stop, schedule_errors)
                actions.append(
                    StopAction(
                        stop_id=f"stop_{len(actions) + 1}",
                        sequence=len(actions) + 1,
                        stop_type=stop.stop_type,
                        items_to_load=[self.cargo[cid] for cid in stop.loads],
                        items_to_unload=stop.unloads,
                    )
                )
            if onboard:
                schedule_errors.append("cargo remains onboard")
            route_start, route_end = self._check_schedule(view, schedule_errors)
            if is_raw_hybrid:
                stops = [stop for stop in route.stops if stop.stop_type in ("PICKUP", "DELIVERY")]
                layouts = [stop.placed_items for stop in stops]
                sequences = [stop.items_unloaded for stop in stops]
                has_certificate = any(layouts)
            else:
                states = route.spatial_validation.step_states
                layouts = [state.placed_items for state in states]
                sequences = [state.unload_sequence for state in states]
                has_certificate = bool(states)
            if has_certificate:
                certificate_routes += 1
                error = verify_layout_certificate(view.vehicle, actions, layouts, sequences)
                if error is not None:
                    spatial_errors.append(error)
            else:
                search_routes += 1
                validation = SpatialValidator(view.vehicle, max_time_seconds=3).validate_plan(actions)
                if not validation.is_valid:
                    spatial_errors.append(validation.error_message or validation.violation_code)
            costed_routes.append(self._route_cost(view, route_start, route_end))

        if any(count > 1 for count in used_slots.values()):
            schedule_errors.append("vehicle slot used by several routes")

        unique_ok = all(n == 1 for n in loaded.values()) and all(n == 1 for n in delivered.values())
        balanced = loaded == delivered
        complete = unique_ok and balanced and set(delivered) == set(self.cargo)
        served = sum(
            all(delivered[item.id] == 1 for item in order.items) for order in self.request.orders
        )
        cost_errors: List[str] = []
        audited_cost = self._uniform_cost(costed_routes, cost_errors)
        schedule_errors.extend(cost_errors)
        objective = None
        if audited_cost is not None:
            # Costs, driver assignments and stop times were reconstructed for
            # every engine above. Do not trust an engine's reported score.
            cost_view = FleetOptimizationResponse(job_id=self.request.job_id,
                status="PARTIAL", routes=costed_routes, total_cost_vnd=audited_cost)
            objective = apply_planning_objective(self.request, cost_view)
        reported_cost = result.real_economic_cost_vnd if is_raw_hybrid else result.total_cost_vnd
        days_used = sorted({route.service_day_index for route in costed_routes})
        return {
            "objective_profile": PRODUCTION_PROFILE,
            "production_objective": objective.model_dump() if objective is not None else None,
            "served_requests": served,
            "total_requests": len(self.request.orders),
            "delivered_packages": len(delivered),
            "total_packages": len(self.cargo),
            "complete_manifest": complete,
            "unique_balanced_manifest": unique_ok and balanced,
            "spatial_valid": bool(costed_routes) and not spatial_errors,
            "basic_schedule_valid": not schedule_errors,
            "spatial_errors": spatial_errors,
            "spatial_certificate_routes": certificate_routes,
            "spatial_search_routes": search_routes,
            "schedule_errors": sorted(set(schedule_errors)),
            "routes": len(costed_routes),
            "physical_vehicles": len({route.vehicle_id for route in costed_routes}),
            "service_days_used": days_used,
            "extra_order_trips": sum(max(0, len(v) - 1) for v in parent_trips.values()),
            "cost_vnd": audited_cost,
            "reported_cost_vnd": reported_cost,
            "distance_km": round(sum(route.total_distance_km for route in costed_routes), 2),
        }


def audit_solution(
    request: FleetOptimizationRequest,
    result,
    is_raw_hybrid: bool,
    shift: DaytimeShift = DaytimeShift(),
) -> dict:
    return PlanAuditor(request, shift).audit(result, is_raw_hybrid)


__all__ = ["PlanAuditor", "audit_solution"]
