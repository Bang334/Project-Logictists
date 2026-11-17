from collections import defaultdict
from decimal import Decimal
from typing import Any, Callable, Mapping, Optional, Sequence

from .models import (
    CargoItem,
    DemoStackingPolicy,
    FleetOptimizationBatchResponse,
    FleetOptimizationResponse,
    OptimizedRoute,
    OrderPair,
    ScheduledStop,
    SpatialValidationResult,
    StopAction,
    VehicleFloor,
)
from .packing_rules import (
    build_weight_balance_metrics,
    is_floor_rotation_locked,
    resolve_can_rotate,
)
from .spatial_validator import SpatialValidator
from .stacking_unequal import (
    fast_validate_unequal_stacked_route,
    has_unequal_stack_potential,
    validate_unequal_stacked_stops,
)

_EPS = 0.01


def effective_floor_capacity_cm2(
    vehicle: Any, demo_stacking: Optional[DemoStackingPolicy]
) -> float:
    """Upper bound on cumulative footprint area allowed simultaneously."""
    floor_area = float(vehicle.length_cm) * float(vehicle.width_cm)
    if demo_stacking is None:
        return floor_area
    return floor_area * demo_stacking.max_tiers


def _envelope_footprint(
    chain: Sequence[Any], candidate: Any
) -> Optional[tuple[float, float, bool]]:
    """Resolve unified (length_cm, width_cm, can_rotate) when stacking candidate onto chain."""
    all_layers = [*chain, candidate]
    cand_pair = tuple(sorted((round(float(candidate.length_cm), 2), round(float(candidate.width_cm), 2))))
    base_pair = tuple(sorted((round(float(chain[0].length_cm), 2), round(float(chain[0].width_cm), 2))))
    if abs(cand_pair[0] - base_pair[0]) > _EPS or abs(cand_pair[1] - base_pair[1]) > _EPS:
        return None
    fixed = {
        (round(float(layer.length_cm), 2), round(float(layer.width_cm), 2))
        for layer in all_layers
        if not resolve_can_rotate(layer)
        and abs(float(layer.length_cm) - float(layer.width_cm)) > _EPS
    }
    if len(fixed) > 1:
        return None
    if len(fixed) == 1:
        fixed_l, fixed_w = next(iter(fixed))
        return fixed_l, fixed_w, False
    return float(chain[0].length_cm), float(chain[0].width_cm), True


def _same_customer(layer: Any, item: Any) -> bool:
    if layer.order_id == item.order_id:
        return True
    layer_customer = getattr(layer, "customer_id", None)
    item_customer = getattr(item, "customer_id", None)
    return bool(layer_customer) and layer_customer == item_customer


def _can_stack_layer(
    chain: Sequence[Any],
    item: Any,
    policy: DemoStackingPolicy,
    max_height_cm: float,
    max_payload_kg: Decimal,
    compatible_stops: Optional[Callable[[Any, Any], bool]] = None,
) -> bool:
    if not bool(getattr(item, "allow_upper_tier", False)) or getattr(item, "cargo_kind", "UNCLASSIFIED") != "STANDARD":
        return False
    if _envelope_footprint(chain, item) is None:
        return False
    if (
        len(chain) >= policy.max_tiers
        or sum(float(layer.height_cm) for layer in chain) + float(item.height_cm) + policy.lift_clearance_cm > max_height_cm + 1e-6
    ):
        return False
    above = Decimal(str(item.weight_kg))
    for layer in reversed(chain):
        weight = Decimal(str(layer.weight_kg))
        max_top_load_g = getattr(layer, "max_top_load_g", None)
        if (
            (policy.owner_mode == "SAME_CUSTOMER" and not _same_customer(layer, item))
            or (compatible_stops is not None and not compatible_stops(layer, item))
            or getattr(layer, "cargo_kind", "UNCLASSIFIED") != "STANDARD"
            or bool(getattr(layer, "no_top_load_requested", False))
            or max_top_load_g is None
            or above * 10 >= weight * 3
            or above * 1000 > max_top_load_g
        ):
            return False
        above += weight
    return above <= max_payload_kg + Decimal("0.001")


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
        self.height_cm = max(vehicle.height_cm for vehicle in vehicles)
        self.payload_kg = Decimal(str(max(vehicle.payload_limit_kg for vehicle in vehicles)))
        self.members: dict[str, tuple[CargoItem, ...]] = {}
        self.cargo: dict[str, CargoItem] = {}
        self.intervals: dict[str, tuple[int, int]] = {}

    def _limits_for_order(self, order: OrderPair) -> tuple[float, Decimal]:
        allowed_ids = set(getattr(order, "allowed_source_vehicle_ids", None) or [])
        order_weight = sum(float(item.weight_kg) for item in order.items)

        def _floor_fits_order(vehicle: VehicleFloor) -> bool:
            for item in order.items:
                fits_normal = item.length_cm <= vehicle.length_cm + _EPS and item.width_cm <= vehicle.width_cm + _EPS
                fits_rot = resolve_can_rotate(item) and item.width_cm <= vehicle.length_cm + _EPS and item.length_cm <= vehicle.width_cm + _EPS
                if not (fits_normal or fits_rot) or item.height_cm > vehicle.height_cm + _EPS:
                    return False
            return True

        eligible = [
            v for v in self.vehicles
            if (not allowed_ids or (getattr(v, "source_vehicle_id", None) or v.id) in allowed_ids)
            and _floor_fits_order(v)
        ]
        weight_capable = [v for v in eligible if v.payload_limit_kg + _EPS >= order_weight]
        pool = weight_capable or eligible or self.vehicles
        return (
            max(v.height_cm for v in pool),
            Decimal(str(max(v.payload_limit_kg for v in pool))),
        )

    def bundle(
        self,
        items: list[CargoItem],
        compatible_stops: Callable[[CargoItem, CargoItem], bool] | None = None,
        *,
        max_height_cm: Optional[float] = None,
        max_payload_kg: Optional[Decimal] = None,
    ) -> list[CargoItem]:
        if len({item.id for item in items}) != len(items):
            return items
        height_limit = self.height_cm if max_height_cm is None else max_height_cm
        payload_limit = self.payload_kg if max_payload_kg is None else max_payload_kg
        groups: dict[tuple[str, float, float], list[CargoItem]] = defaultdict(list)
        for item in items:
            if item.cargo_kind == "STANDARD":
                key_l, key_w = sorted((round(item.length_cm, 2), round(item.width_cm, 2)))
                groups['' if compatible_stops else item.order_id, key_l, key_w].append(item)
        envelopes: dict[str, CargoItem] = {}
        upper_ids: set[str] = set()
        for group in groups.values():
            chains: list[list[CargoItem]] = []
            for item in sorted(group, key=lambda item: (-item.weight_kg, item.id)):
                chain = (
                    next(
                        (
                            c
                            for c in chains
                            if _can_stack_layer(
                                c, item, self.policy, height_limit, payload_limit, compatible_stops
                            )
                        ),
                        None,
                    )
                    if item.allow_upper_tier
                    else None
                )
                if chain is None:
                    chains.append([item])
                else:
                    chain.append(item)
            for chain in chains:
                base = chain[0]
                if len(chain) == 1:
                    continue
                resolved = _envelope_footprint(chain[:-1], chain[-1])
                env_l, env_w, env_rot = resolved or (
                    base.length_cm,
                    base.width_cm,
                    all(resolve_can_rotate(it) for it in chain),
                )
                has_explicit_orientation = any(
                    getattr(it, "allowed_orientations", None) is not None for it in chain
                )
                self.members[base.id] = tuple(chain)
                upper_ids.update(item.id for item in chain[1:])
                envelopes[base.id] = base.model_copy(update={
                    "length_cm": env_l,
                    "width_cm": env_w,
                    "height_cm": sum(item.height_cm for item in chain) + self.policy.lift_clearance_cm,
                    "weight_kg": float(sum(Decimal(str(item.weight_kg)) for item in chain)),
                    "can_rotate": env_rot,
                    **(
                        {"allowed_orientations": ["LWH"]}
                        if (not env_rot and has_explicit_orientation)
                        else {}
                    ),
                })
        return [envelopes.get(item.id, item) for item in items if item.id not in upper_ids]

    def bundle_orders(self, orders: list[OrderPair]) -> list[OrderPair]:
        ids = [item.id for order in orders for item in order.items]
        if len(ids) != len(set(ids)):
            return orders
        self.cargo = {item.id: item for order in orders for item in order.items}
        bundled: list[OrderPair] = []
        for order in orders:
            h_lim, p_lim = self._limits_for_order(order)
            bundled.append(
                order.model_copy(
                    update={"items": self.bundle(order.items, max_height_cm=h_lim, max_payload_kg=p_lim)}
                )
            )
        return bundled

    def _can_add(self, chain: list[CargoItem], item: CargoItem, compatible_stops: Callable[[CargoItem, CargoItem], bool] | None) -> bool:
        return _can_stack_layer(chain, item, self.policy, self.height_cm, self.payload_kg, compatible_stops)

    def bundle_stops(
        self,
        stops: list[StopAction],
        *,
        max_height_cm: Optional[float] = None,
        max_payload_kg: Optional[Decimal] = None,
    ) -> list[StopAction]:
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

        envelopes = {
            item.id: item
            for item in self.bundle(
                [item for stop in stops for item in stop.items_to_load],
                contains_interval,
                max_height_cm=max_height_cm,
                max_payload_kg=max_payload_kg,
            )
        }
        return [stop.model_copy(update={
            "items_to_load": [envelopes[item.id] for item in stop.items_to_load if item.id in envelopes],
            "items_to_unload": [item_id for item_id in stop.items_to_unload if item_id in envelopes],
        }) for stop in stops]

    def validate_stops(self, validator: SpatialValidator, stops: list[StopAction]) -> SpatialValidationResult:
        v_height = getattr(validator, "floor_height", None) or getattr(validator.vehicle, "height_cm", self.height_cm)
        v_payload = Decimal(str(getattr(validator.vehicle, "payload_limit_kg", self.payload_kg)))
        self.members = {}
        bundled = self.bundle_stops(stops, max_height_cm=v_height, max_payload_kg=v_payload)
        result = validator.validate_plan(bundled)

        equal_result: SpatialValidationResult
        if not self.members:
            equal_result = result
        elif not result.is_valid or len(result.step_states) != len(stops):
            equal_result = validator.validate_plan(stops)
        else:
            early_unloads: dict[int, list[str]] = defaultdict(list)
            door_clear = True
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
                            door_clear = False
                            break
                    if not door_clear:
                        break
                    if delivery < base_delivery:
                        early_unloads[delivery].append(item.id)
                if not door_clear:
                    break
            if door_clear:
                equal_result = self.expand_layout(
                    result,
                    early_unloads,
                    payload_limit_kg=float(v_payload),
                    floor_length_cm=getattr(validator.vehicle, "length_cm", None),
                    floor_width_cm=getattr(validator.vehicle, "width_cm", None),
                )
            else:
                equal_result = validator.validate_plan(stops)

        if has_unequal_stack_potential(self.policy, validator.vehicle, stops):
            should_try_unequal = (not equal_result.is_valid) or (not self.members)
            if not should_try_unequal:
                stacked_ids = {item.id for chain in self.members.values() for item in chain}
                should_try_unequal = any(
                    it.id not in stacked_ids and it.allow_upper_tier and it.cargo_kind == "STANDARD"
                    for st in stops
                    for it in st.items_to_load
                )
            if should_try_unequal:
                unequal_result = validate_unequal_stacked_stops(
                    self.policy,
                    validator.vehicle,
                    stops,
                    validator,
                )
                if unequal_result.is_valid and (
                    not equal_result.is_valid
                    or unequal_result.max_area_cm2 < equal_result.max_area_cm2 - _EPS
                    or (
                        not self.members
                        and unequal_result.max_area_cm2 <= equal_result.max_area_cm2 + _EPS
                        and any(
                            p.support_item_id is not None
                            for state in unequal_result.step_states
                            for p in state.placed_items
                        )
                    )
                ):
                    return unequal_result
        return equal_result

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

    def expand_layout(
        self,
        result: SpatialValidationResult,
        early_unloads: dict[int, list[str]] | None = None,
        *,
        payload_limit_kg: Optional[float] = None,
        floor_length_cm: Optional[float] = None,
        floor_width_cm: Optional[float] = None,
    ) -> SpatialValidationResult:
        if not self.members:
            return result
        payload_denom = float(payload_limit_kg) if payload_limit_kg is not None else float(self.payload_kg)
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
                        "cargo_kind": item.cargo_kind,
                        "no_top_load_requested": item.no_top_load_requested,
                        "floor_rotation_locked": is_floor_rotation_locked(item),
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
            weight_balance = (
                build_weight_balance_metrics(placements, floor_length_cm, floor_width_cm)
                if floor_length_cm is not None and floor_width_cm is not None
                else state.weight_balance
            )
            states.append(state.model_copy(update={
                "placed_items": placements, "package_access_paths": paths,
                "unload_sequence": unloaded,
                "weight_balance": weight_balance,
                **({"current_weight_kg": round(weight, 3), "weight_utilization_percent": round(weight / payload_denom * 100, 1) if payload_denom > 0 else 0.0} if early_unloads is not None else {}),
            }))
        max_lat_imb = max(
            (
                s.weight_balance.lateral_imbalance_percent
                for s in states
                if s.weight_balance is not None and s.weight_balance.status != "EMPTY"
            ),
            default=result.max_lateral_imbalance_percent,
        )
        return result.model_copy(update={
            "step_states": states, "demo_stacking": self.policy,
            "max_weight_kg": max((state.current_weight_kg for state in states), default=0) if early_unloads is not None else result.max_weight_kg,
            "max_lateral_imbalance_percent": round(max_lat_imb, 1),
        })

    def expand_route(self, route: OptimizedRoute) -> OptimizedRoute:
        stops = self.expand_stops(route.stops)
        vehicle = next((vehicle for vehicle in self.vehicles if vehicle.id == route.vehicle_id or (
            getattr(vehicle, 'source_vehicle_id', None) == route.vehicle_id and
            getattr(vehicle, 'service_day_index', None) == route.service_day_index
        )), None)
        layout = self.expand_layout(
            route.spatial_validation,
            payload_limit_kg=vehicle.payload_limit_kg if vehicle is not None else None,
            floor_length_cm=vehicle.length_cm if vehicle is not None else None,
            floor_width_cm=vehicle.width_cm if vehicle is not None else None,
        )
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


def validate_stop_actions(
    policy: Optional[DemoStackingPolicy],
    vehicle: Any,
    actions: list[StopAction],
    *,
    max_search_nodes: Optional[int] = None,
    max_time_seconds: Optional[float] = None,
) -> SpatialValidationResult:
    """Validate StopAction sequence honoring optional demo_stacking policy."""
    floor = vehicle if isinstance(vehicle, VehicleFloor) else VehicleFloor(
        id=vehicle.id,
        plate_number=vehicle.plate_number,
        length_cm=vehicle.length_cm,
        width_cm=vehicle.width_cm,
        height_cm=vehicle.height_cm,
        payload_limit_kg=vehicle.payload_limit_kg,
        door_position=getattr(vehicle, "door_position", "REAR"),
        door_width_cm=getattr(vehicle, "door_width_cm", None),
    )
    kwargs: dict[str, Any] = {}
    if max_search_nodes is not None:
        kwargs["max_search_nodes"] = max_search_nodes
    if max_time_seconds is not None:
        kwargs["max_time_seconds"] = max_time_seconds
    validator = SpatialValidator(floor, **kwargs)
    if policy is None:
        return validator.validate_plan(actions)
    return DemoStacks(policy, [floor]).validate_stops(validator, actions)


def sync_route_stacking_unloads(
    stops: list[ScheduledStop],
    spatial: SpatialValidationResult,
) -> list[ScheduledStop]:
    """Synchronize DELIVERY stop unload ordering with validated top-first unload_sequence."""
    if len(stops) != len(spatial.step_states):
        return stops
    synced: list[ScheduledStop] = []
    for stop, state in zip(stops, spatial.step_states):
        if (
            stop.stop_type == "DELIVERY"
            and state.unload_sequence
            and len(state.unload_sequence) == len(stop.items_unloaded)
            and set(state.unload_sequence) == set(stop.items_unloaded)
        ):
            synced.append(stop.model_copy(update={"items_unloaded": list(state.unload_sequence)}))
        else:
            synced.append(stop)
    return synced


def _boxes_overlap(
    x1: float, y1: float, l1: float, w1: float,
    x2: float, y2: float, l2: float, w2: float,
) -> bool:
    return not (
        x1 + l1 <= x2 + _EPS
        or x2 + l2 <= x1 + _EPS
        or y1 + w1 <= y2 + _EPS
        or y2 + w2 <= y1 + _EPS
    )


def _col_corridor_clear(
    x: float, y: float, l_dim: float, w_dim: float,
    bed_l: float, other_cols: Sequence[dict[str, Any]],
) -> bool:
    path_x = x + l_dim
    path_len = bed_l - path_x
    if path_len <= _EPS:
        return True
    return not any(
        _boxes_overlap(path_x, y, path_len, w_dim, col["x"], col["y"], col["l"], col["w"])
        for col in other_cols
    )


def _footprint_matches_column(col: dict[str, Any], item: Any) -> bool:
    l_eq = abs(col["l"] - float(item.length_cm)) <= _EPS and abs(col["w"] - float(item.width_cm)) <= _EPS
    if l_eq:
        return True
    if resolve_can_rotate(item):
        return abs(col["l"] - float(item.width_cm)) <= _EPS and abs(col["w"] - float(item.length_cm)) <= _EPS
    return False


def fast_validate_stacked_route(
    vehicle: Any,
    stops: Sequence[Any],
    cargo_by_id: Mapping[str, Any],
    policy: DemoStackingPolicy,
    *,
    allow_layout_search: bool = True,
) -> tuple[bool, str]:
    """Fast LIFO + unequal-footprint vertical tree-stacking pre-check."""
    return fast_validate_unequal_stacked_route(
        vehicle,
        stops,
        cargo_by_id,
        policy,
        allow_layout_search=allow_layout_search,
        validate_fallback=validate_stop_actions,
    )
