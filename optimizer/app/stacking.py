from collections import defaultdict
from decimal import Decimal
from typing import Callable

from .models import (
    CargoItem, DemoStackingPolicy, FleetOptimizationBatchResponse, FleetOptimizationResponse, OptimizedRoute, OrderPair, ScheduledStop,
    SpatialValidationResult, StopAction, VehicleFloor,
)
from .spatial_validator import SpatialValidator


class DemoStacks:
    """Equal footprints reserve a full rear-door corridor at every tier.

    A stack reserves its footprint for the lifetime of the bottom package. Its envelope
    includes lifting clearance and never moves while the stack is aboard.
    The demo assumes a rear opening as high as the vehicle interior and a
    lift that can transport each upper package at its handling elevation.
    """

    def __init__(self, policy: DemoStackingPolicy, vehicles: list[VehicleFloor]):
        self.policy = policy
        self.vehicles = vehicles
        self.height_cm = min(vehicle.height_cm for vehicle in vehicles)
        self.payload_kg = Decimal(str(min(vehicle.payload_limit_kg for vehicle in vehicles)))
        self.members: dict[str, tuple[CargoItem, ...]] = {}
        self.cargo: dict[str, CargoItem] = {}
        self.intervals: dict[str, tuple[int, int]] = {}

    def bundle(self, items: list[CargoItem], compatible_stops: Callable[[CargoItem, CargoItem], bool] | None = None) -> list[CargoItem]:
        if len({item.id for item in items}) != len(items):
            return items
        groups: dict[tuple[str, float, float], list[CargoItem]] = defaultdict(list)
        for item in items:
            if item.cargo_kind == "STANDARD":
                groups['' if compatible_stops else item.order_id, item.length_cm, item.width_cm].append(item)
        envelopes: dict[str, CargoItem] = {}
        upper_ids: set[str] = set()
        for group in groups.values():
            chains: list[list[CargoItem]] = []
            for item in sorted(group, key=lambda item: (-item.weight_kg, item.id)):
                chain = next((chain for chain in chains if self._can_add(chain, item, compatible_stops)), None) if item.allow_upper_tier else None
                if chain is None:
                    chains.append([item])
                else:
                    chain.append(item)
            for chain in chains:
                base = chain[0]
                if len(chain) == 1:
                    continue
                self.members[base.id] = tuple(chain)
                upper_ids.update(item.id for item in chain[1:])
                envelopes[base.id] = base.model_copy(update={
                    "height_cm": sum(item.height_cm for item in chain) + self.policy.lift_clearance_cm,
                    "weight_kg": float(sum(Decimal(str(item.weight_kg)) for item in chain)),
                    "can_rotate": all(item.can_rotate for item in chain),
                })
        return [envelopes.get(item.id, item) for item in items if item.id not in upper_ids]

    def bundle_orders(self, orders: list[OrderPair]) -> list[OrderPair]:
        ids = [item.id for order in orders for item in order.items]
        if len(ids) != len(set(ids)):
            return orders
        self.cargo = {item.id: item for order in orders for item in order.items}
        return [order.model_copy(update={"items": self.bundle(order.items)}) for order in orders]

    def _can_add(self, chain: list[CargoItem], item: CargoItem, compatible_stops: Callable[[CargoItem, CargoItem], bool] | None) -> bool:
        if (
            len(chain) >= self.policy.max_tiers
            or sum(layer.height_cm for layer in chain) + item.height_cm + self.policy.lift_clearance_cm > self.height_cm
        ):
            return False
        above = Decimal(str(item.weight_kg))
        for layer in reversed(chain):
            weight = Decimal(str(layer.weight_kg))
            if (
                (self.policy.owner_mode == "SAME_CUSTOMER" and not (
                    layer.order_id == item.order_id or (
                        bool(layer.customer_id) and layer.customer_id == item.customer_id
                    )
                ))
                or (compatible_stops is not None and not compatible_stops(layer, item))
                or layer.cargo_kind != "STANDARD" or layer.no_top_load_requested
                or layer.max_top_load_g is None
                or above * 10 >= weight * 3
                or above * 1000 > layer.max_top_load_g
            ):
                return False
            above += weight
        return above <= self.payload_kg

    def bundle_stops(self, stops: list[StopAction]) -> list[StopAction]:
        loads: dict[str, list[int]] = defaultdict(list)
        unloads: dict[str, list[int]] = defaultdict(list)
        for index, stop in enumerate(stops):
            for item in stop.items_to_load:
                loads[item.id].append(index)
            for item_id in stop.items_to_unload:
                unloads[item_id].append(index)
        for item_id, indices in loads.items():
            if len(indices) != 1 or len(unloads[item_id]) != 1 or unloads[item_id][0] <= indices[0]:
                return stops
        if loads.keys() != unloads.keys():
            return stops
        self.intervals = {item_id: (indices[0], unloads[item_id][0]) for item_id, indices in loads.items()}

        def contains_interval(base: CargoItem, upper: CargoItem) -> bool:
            base_pickup, base_delivery = self.intervals[base.id]
            pickup, delivery = self.intervals[upper.id]
            return base_pickup <= pickup and delivery <= base_delivery

        envelopes = {item.id: item for item in self.bundle([item for stop in stops for item in stop.items_to_load], contains_interval)}
        return [stop.model_copy(update={
            "items_to_load": [envelopes[item.id] for item in stop.items_to_load if item.id in envelopes],
            "items_to_unload": [item_id for item_id in stop.items_to_unload if item_id in envelopes],
        }) for stop in stops]

    def validate_stops(self, validator: SpatialValidator, stops: list[StopAction]) -> SpatialValidationResult:
        bundled = self.bundle_stops(stops)
        result = validator.validate_plan(bundled)
        if not self.members:
            return result
        if not result.is_valid or len(result.step_states) != len(stops):
            return validator.validate_plan(stops)

        early_unloads: dict[int, list[str]] = defaultdict(list)
        for base_id, chain in self.members.items():
            base_pickup, base_delivery = self.intervals[base_id]
            for item in reversed(chain[1:]):
                pickup, delivery = self.intervals[item.id]
                # The virtual base reserves the entire shared footprint. At a different
                # stop, require a clear corridor with every other footprint still aboard.
                for step in ([pickup] if pickup > base_pickup else []) + ([delivery - 1] if delivery < base_delivery else []):
                    layout = result.step_states[step].placed_items
                    base = next((placed for placed in layout if placed.item_id == base_id), None)
                    if base is None or not validator.is_path_to_door_clear(base, [p for p in layout if p.item_id != base_id])[0]:
                        return validator.validate_plan(stops)
                if delivery < base_delivery:
                    early_unloads[delivery].append(item.id)
        return self.expand_layout(result, early_unloads)

    def expand_ids(self, item_ids: list[str], *, unloading: bool = False) -> list[str]:
        result: list[str] = []
        for item_id in item_ids:
            chain = self.members.get(item_id)
            if chain:
                result.extend(item.id for item in (reversed(chain) if unloading else chain))
            else:
                result.append(item_id)
        return result

    def expand_stops(self, stops: list[ScheduledStop]) -> list[ScheduledStop]:
        return [stop.model_copy(update={
            "items_loaded": self.expand_ids(stop.items_loaded),
            "items_unloaded": self.expand_ids(stop.items_unloaded, unloading=True),
        }) for stop in stops]

    def expand_layout(self, result: SpatialValidationResult, early_unloads: dict[int, list[str]] | None = None) -> SpatialValidationResult:
        if not self.members:
            return result
        states = []
        for index, state in enumerate(result.step_states):
            placements = []
            paths = []
            chains = self.members if early_unloads is None else {
                base: tuple(item for item in chain if self.intervals[item.id][0] <= index < self.intervals[item.id][1])
                for base, chain in self.members.items()
            }
            for placement in state.placed_items:
                chain = chains.get(placement.item_id)
                if chain is None:
                    placements.append(placement)
                    continue
                z = 0.0
                for level, item in enumerate(chain):
                    placements.append(placement.model_copy(update={
                        "item_id": item.id, "height_cm": item.height_cm, "weight_kg": item.weight_kg,
                        "order_id": item.order_id,
                        "z": z, "support_item_id": chain[level - 1].id if level else None,
                    }))
                    z += item.height_cm
            placement_by_id = {placement.item_id: placement for placement in placements}
            for path in state.package_access_paths:
                chain = chains.get(path.item_id)
                if chain is None:
                    paths.append(path.model_copy(update={"blocker_item_ids": self.expand_ids(path.blocker_item_ids)}))
                    continue
                for level, item in enumerate(chain):
                    above = [upper.id for upper in chain[level + 1:]]
                    z = placement_by_id[item.id].z
                    points = []
                    if path.is_clear and not above and path.points:
                        points = [path.points[0].model_copy(update={"z": z})]
                        points.extend(point.model_copy(update={"z": z + self.policy.lift_clearance_cm}) for point in path.points)
                    paths.append(path.model_copy(update={
                        "item_id": item.id, "is_clear": path.is_clear and not above,
                        "points": points, "blocker_item_ids": above + self.expand_ids(path.blocker_item_ids),
                    }))
            unloaded = self.expand_ids(state.unload_sequence, unloading=True)
            if early_unloads is not None:
                unloaded = early_unloads.get(index, []) + [item_id for item_id in unloaded if self.intervals[item_id][1] == index]
            weight = sum(item.weight_kg for item in placements)
            states.append(state.model_copy(update={
                "placed_items": placements, "package_access_paths": paths,
                "unload_sequence": unloaded,
                **({"current_weight_kg": round(weight, 3), "weight_utilization_percent": round(weight / float(self.payload_kg) * 100, 1)} if early_unloads is not None else {}),
            }))
        return result.model_copy(update={
            "step_states": states, "demo_stacking": self.policy,
            "max_weight_kg": max((state.current_weight_kg for state in states), default=0) if early_unloads is not None else result.max_weight_kg,
        })

    def expand_route(self, route: OptimizedRoute) -> OptimizedRoute:
        stops = self.expand_stops(route.stops)
        layout = self.expand_layout(route.spatial_validation)
        vehicle = next((vehicle for vehicle in self.vehicles if vehicle.id == route.vehicle_id or (
            getattr(vehicle, 'source_vehicle_id', None) == route.vehicle_id and
            getattr(vehicle, 'service_day_index', None) == route.service_day_index
        )), None)
        if vehicle is not None:
            layout = self.improve_route_layout(stops, layout, vehicle)
        return route.model_copy(update={
            "stops": stops,
            "spatial_validation": layout,
        })

    def improve_route_layout(self, stops: list[ScheduledStop], baseline: SpatialValidationResult, vehicle: VehicleFloor) -> SpatialValidationResult:
        if not baseline.is_valid:
            return baseline
        ids = {item_id for stop in stops for item_id in stop.items_loaded}
        if not ids or not ids.issubset(self.cargo):
            return baseline
        owners: dict[str, set[str]] = defaultdict(set)
        for item_id in ids:
            item = self.cargo[item_id]
            if item.cargo_kind == 'STANDARD':
                key = '*' if self.policy.owner_mode == 'ANY_CUSTOMER' else item.customer_id or item.order_id
                owners[key].add(item.order_id)
        if not any(len(orders) > 1 for orders in owners.values()):
            return baseline
        actions = [StopAction(
            stop_id=stop.location_id, sequence=index + 1, stop_type=stop.stop_type,
            address=stop.location_name, latitude=stop.latitude, longitude=stop.longitude,
            items_to_load=[self.cargo[item_id] for item_id in stop.items_loaded], items_to_unload=stop.items_unloaded,
        ) for index, stop in enumerate(stops)]
        trial = DemoStacks(self.policy, [vehicle]).validate_stops(
            SpatialValidator(vehicle, max_search_nodes=2000, max_time_seconds=0.5), actions,
        )
        if trial.is_valid and any(
            item.support_item_id and self.cargo[item.item_id].order_id != self.cargo[item.support_item_id].order_id
            for state in trial.step_states for item in state.placed_items
        ) and trial.max_area_cm2 <= baseline.max_area_cm2:
            return trial
        return baseline

    def expand_fleet(self, response: FleetOptimizationResponse) -> FleetOptimizationResponse:
        benchmarks = response.benchmarks
        if benchmarks is not None and self.members:
            benchmarks = benchmarks.model_copy(update={
                key: metric.model_copy(update={"routes": [self.expand_route(route) for route in metric.routes]})
                for key, metric in (("or_tools", benchmarks.or_tools), ("direct_dedicated", benchmarks.direct_dedicated))
            })
        return response.model_copy(update={
            "routes": [self.expand_route(route) for route in response.routes], "benchmarks": benchmarks,
        })

    def expand_batch(self, batch: FleetOptimizationBatchResponse) -> FleetOptimizationBatchResponse:
        return batch.model_copy(update={"candidates": [candidate.model_copy(update={
            "result": self.expand_fleet(candidate.result),
        }) for candidate in batch.candidates]})
