from math import isfinite
from typing import Dict, List, Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator


class StrictContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WarehouseOperatingWindow(StrictContractModel):
    start_sec: int = Field(ge=0, lt=86400)
    end_sec: int = Field(gt=0, le=86400)

    @model_validator(mode="after")
    def validate_operating_window(self):
        if self.end_sec <= self.start_sec:
            raise ValueError("warehouse operating window must satisfy end_sec > start_sec")
        return self


class LocationPoint(StrictContractModel):
    id: str
    source_location_id: Optional[str] = None
    warehouse_location_id: Optional[str] = None
    name: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    province_code: Optional[str] = None
    province_name: Optional[str] = None
    warehouse_role: Optional[Literal["HUB", "WAREHOUSE", "TRANSIT"]] = None
    docking_time_sec: int = Field(default=0, ge=0)
    max_vehicle_payload_kg: Optional[float] = Field(default=None, gt=0)
    max_vehicle_length_cm: Optional[float] = Field(default=None, gt=0)
    has_forklift: Optional[bool] = None
    allows_hazmat: Optional[bool] = None
    operating_windows: List[WarehouseOperatingWindow] = Field(default_factory=list)
    handling_sec_per_ton: int = Field(default=0, ge=0)
    handling_sec_per_package: int = Field(default=0, ge=0)


class VehicleFloor(StrictContractModel):
    id: str
    plate_number: str
    length_cm: float = Field(gt=0, description="Chiều dài lọt lòng thùng xe (cm)")
    width_cm: float = Field(gt=0, description="Chiều rộng lọt lòng thùng xe (cm)")
    height_cm: float = Field(gt=0, description="Chiều cao lọt lòng thùng xe (cm)")
    payload_limit_kg: float = Field(gt=0)
    door_position: Literal["REAR"] = "REAR"
    door_width_cm: Optional[float] = Field(default=None, gt=0)
    temperature_mode: Literal["DRY", "CHILLED", "FROZEN", "ISOTHERMAL", "HAZMAT"] = "DRY"
    allows_hazmat: bool = False
    has_tail_lift: bool = False


class FleetVehicle(VehicleFloor):
    source_vehicle_id: Optional[str] = None
    service_day_index: int = Field(default=0, ge=0)
    available_start_sec: int = Field(default=0, ge=0)
    available_end_sec: int = Field(default=30 * 86400, gt=0)
    depot: LocationPoint
    return_to_depot: bool = True
    end_depot: Optional[LocationPoint] = None
    model: Optional[str] = None
    vehicle_type: Optional[str] = None
    toll_factor: float = Field(default=1.0, gt=0)
    fuel_consumption_liters_per_100_km: float = Field(
        ge=0, description="Baseline fuel consumption without cargo"
    )
    load_fuel_surcharge_percent_at_full_payload: float = Field(
        default=0, ge=0, description="Linear surcharge over baseline at full payload"
    )
    fixed_operating_cost_vnd: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_availability(self):
        if self.available_start_sec >= self.available_end_sec:
            raise ValueError("vehicle availability window is invalid")
        return self


class DriverOption(StrictContractModel):
    source_driver_id: Optional[str] = None
    service_day_index: int = Field(default=0, ge=0)
    id: str
    full_name: str
    license_class: str = "C"
    fixed_salary_monthly_vnd: int = Field(ge=0)
    trip_base_pay_vnd: int = Field(ge=0)
    per_km_pay_vnd: int = Field(ge=0)
    home_location_id: Optional[str] = None
    home_province_code: Optional[str] = None
    strict_home_location: bool = False
    initial_weekly_driving_sec: int = Field(default=0, ge=0)


def can_driver_drive_vehicle(
    driver_license: str, payload_limit_kg: float, vehicle_type: str = ""
) -> bool:
    """
    Quy định tương thích GPLX theo Luật Giao thông đường bộ Việt Nam:
    - B2: Chỉ điều khiển xe ô tô tải có trọng tải thiết kế <= 3.500 kg.
    - C: Điều khiển xe ô tô tải > 3.500 kg (lên đến 16.000 kg) và toàn bộ xe của B2.
    - FC: Điều khiển xe đầu kéo rơ-moóc / Container và toàn bộ xe của C, B2.
    """
    lic = (driver_license or "C").strip().upper()
    v_type = (vehicle_type or "").lower()

    # Xe đầu kéo hoặc container bắt buộc bằng FC
    if any(keyword in v_type for keyword in ["container", "đầu kéo", "sơ mi", "rơ moóc"]):
        return lic in ["FC", "CE"]

    # Hạng FC điều khiển được mọi dòng xe tải
    if lic in ["FC", "CE"]:
        return True

    # Hạng C điều khiển được xe tải trên 3.5T và xe tải nhẹ <= 3.5T
    if lic == "C":
        return True

    # Hạng B2 chỉ được điều khiển xe tải có tải trọng thiết kế <= 3.500 kg
    if lic == "B2":
        return payload_limit_kg <= 3500.0

    return False


class DrivingRestPolicy(StrictContractModel):
    """Configurable driving-hour and mandatory-rest limits for long-haul routes."""

    policy_code: str = "VN_INTERPROVINCIAL_STANDARD"
    effective_from: str = "2026-01-01"
    jurisdiction: str = "VN"
    enabled: bool = True
    max_continuous_driving_sec: int = Field(default=4 * 3600, gt=0)
    short_rest_duration_sec: int = Field(default=15 * 60, ge=0)
    max_daily_driving_sec: int = Field(default=10 * 3600, gt=0)
    daily_rest_duration_sec: int = Field(default=8 * 3600, ge=0)
    max_weekly_driving_sec: Optional[int] = Field(default=48 * 3600, gt=0)
    min_inter_trip_rest_sec: int = Field(default=0, ge=0)
    overnight_allowance_vnd: int = Field(default=0, ge=0)
    rest_allowance_during_service: bool = True

    @model_validator(mode="after")
    def validate_rest_limits(self):
        if self.max_daily_driving_sec < self.max_continuous_driving_sec:
            raise ValueError("max_daily_driving_sec must be >= max_continuous_driving_sec")
        if (
            self.max_weekly_driving_sec is not None
            and self.max_weekly_driving_sec < self.max_daily_driving_sec
        ):
            raise ValueError("max_weekly_driving_sec must be >= max_daily_driving_sec")
        return self


class RestBreakRecord(StrictContractModel):
    leg_after_sequence: int = Field(ge=0)
    reason: Literal["CONTINUOUS_DRIVING", "DAILY_LIMIT"]
    start_time_sec: int = Field(ge=0)
    end_time_sec: int = Field(ge=0)
    duration_sec: int = Field(gt=0)


class CostPolicy(StrictContractModel):
    fuel_price_per_liter_vnd: int = Field(gt=0)
    monthly_working_minutes: int = Field(gt=0)
    cargo_holding_cost_vnd_per_ton_hour: int = Field(default=0, ge=0)
    unassigned_order_penalty_vnd: int = Field(default=1_000_000_000, gt=0)
    delivery_grace_days: int = Field(default=2, ge=0, le=365)
    late_delivery_penalty_mode: Literal[
        "NONE", "FIXED_PER_DAY", "PERCENT_ORDER_VALUE_PER_DAY"
    ] = "NONE"
    late_delivery_penalty_value: float = Field(default=0, ge=0)
    max_routes_per_day: Optional[int] = Field(default=None, ge=1, le=500)
    driving_rest_policy: Optional[DrivingRestPolicy] = None
    weight_balance_penalty_vnd_per_percent: int = Field(default=0, ge=0)
    enforce_weight_balance: bool = False
    max_lateral_imbalance_percent: Optional[float] = Field(default=None, gt=0, le=100)
    max_longitudinal_imbalance_percent: Optional[float] = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def validate_late_delivery_penalty(self):
        if (
            self.late_delivery_penalty_mode == "PERCENT_ORDER_VALUE_PER_DAY"
            and self.late_delivery_penalty_value > 100
        ):
            raise ValueError("percentage late-delivery penalty cannot exceed 100% per day")
        return self


class CargoItem(StrictContractModel):
    id: str
    order_id: str
    customer_id: Optional[str] = None
    order_item_id: Optional[str] = None
    description: str = ""
    length_cm: float = Field(gt=0)
    width_cm: float = Field(gt=0)
    height_cm: float = Field(gt=0)
    weight_kg: float = Field(gt=0)
    can_rotate: bool = True
    allowed_orientations: Optional[List[Literal["LWH", "WLH"]]] = None
    cargo_kind: Literal["UNCLASSIFIED", "STANDARD", "FRAGILE"] = "STANDARD"
    allow_upper_tier: bool = True
    no_top_load_requested: bool = False
    max_top_load_g: Optional[int] = Field(default=None, gt=0)
    required_temperature: Optional[Literal["DRY", "CHILLED", "FROZEN", "HAZMAT"]] = None
    cargo_group: Optional[str] = None
    incompatible_cargo_groups: List[str] = Field(default_factory=list)
    is_hazmat: bool = False
    requires_lift_equipment: bool = False

    @model_validator(mode="after")
    def validate_allowed_orientations(self):
        if "allow_upper_tier" not in self.model_fields_set:
            self.allow_upper_tier = (
                self.cargo_kind == "STANDARD" and not self.no_top_load_requested
            )
        if self.allowed_orientations is not None:
            deduped: List[Literal["LWH", "WLH"]] = []
            for entry in self.allowed_orientations:
                if entry not in deduped:
                    deduped.append(entry)
            if not deduped:
                raise ValueError("allowed_orientations cannot be empty")
            self.allowed_orientations = deduped
            if "WLH" not in deduped:
                self.can_rotate = False
        return self


class PlacedItem(StrictContractModel):
    item_id: str
    order_id: str
    x: float
    y: float
    length_cm: float
    width_cm: float
    height_cm: float
    weight_kg: float
    z: float = Field(default=0, ge=0)
    support_item_id: Optional[str] = None
    cargo_kind: Optional[Literal["UNCLASSIFIED", "STANDARD", "FRAGILE"]] = None
    no_top_load_requested: Optional[bool] = None
    floor_rotation_locked: Optional[bool] = None


class WeightBalanceMetrics(StrictContractModel):
    total_weight_kg: float = 0.0
    cg_x_cm: float = 0.0
    cg_y_cm: float = 0.0
    cg_x_percent: float = 50.0
    cg_y_percent: float = 50.0
    lateral_offset_cm: float = 0.0
    longitudinal_offset_cm: float = 0.0
    lateral_imbalance_percent: float = 0.0
    longitudinal_imbalance_percent: float = 0.0
    left_weight_kg: float = 0.0
    right_weight_kg: float = 0.0
    front_weight_kg: float = 0.0
    rear_weight_kg: float = 0.0
    status: Literal["EMPTY", "BALANCED", "MODERATE", "IMBALANCED"] = "EMPTY"


class MovementPoint(StrictContractModel):
    x: float
    y: float
    z: float = Field(default=0, ge=0)


class PackageAccessPath(StrictContractModel):
    item_id: str
    is_clear: bool
    points: List[MovementPoint] = Field(default_factory=list)
    blocker_item_ids: List[str] = Field(default_factory=list)


class StopAction(StrictContractModel):
    stop_id: str
    sequence: int = Field(ge=1)
    stop_type: Literal["PICKUP", "DELIVERY"]
    address: str = ""
    latitude: float = Field(default=0.0, ge=-90, le=90)
    longitude: float = Field(default=0.0, ge=-180, le=180)
    items_to_load: List[CargoItem] = Field(default_factory=list)
    items_to_unload: List[str] = Field(default_factory=list)


class FloorState(StrictContractModel):
    step_index: int
    stop_id: str
    stop_type: str
    action_description: str
    placed_items: List[PlacedItem]
    current_weight_kg: float
    current_occupied_area_cm2: float
    floor_area_cm2: float
    weight_utilization_percent: float
    area_utilization_percent: float
    is_valid: bool
    unload_sequence: List[str] = Field(default_factory=list)
    package_access_paths: List[PackageAccessPath] = Field(default_factory=list)
    weight_balance: Optional[WeightBalanceMetrics] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class DemoStackingPolicy(StrictContractModel):
    max_tiers: int = Field(ge=2, le=20)
    lift_clearance_cm: float = Field(gt=0, allow_inf_nan=False)
    owner_mode: Literal["SAME_CUSTOMER", "ANY_CUSTOMER"] = "SAME_CUSTOMER"
    max_top_load_percent: int = Field(default=30, ge=1, le=100)
    enforce_weight_balance: bool = False
    max_lateral_imbalance_percent: Optional[float] = Field(default=None, gt=0, le=100)
    max_longitudinal_imbalance_percent: Optional[float] = Field(default=None, gt=0, le=100)

    @model_serializer(mode="wrap")
    def _serialize_preserving_legacy_shape(self, handler):
        data = handler(self)
        if (
            not self.enforce_weight_balance
            and self.max_lateral_imbalance_percent is None
            and self.max_longitudinal_imbalance_percent is None
        ):
            data.pop("enforce_weight_balance", None)
            data.pop("max_lateral_imbalance_percent", None)
            data.pop("max_longitudinal_imbalance_percent", None)
        return data


def default_stacking_policy() -> DemoStackingPolicy:
    """Default production 3D multi-tier stacking policy when not explicitly disabled."""
    return DemoStackingPolicy(
        max_tiers=3,
        lift_clearance_cm=5.0,
        owner_mode="ANY_CUSTOMER",
        max_top_load_percent=30,
    )


class SpatialValidationResult(StrictContractModel):
    is_valid: bool
    violation_code: Optional[str] = None
    violation_scenario: Optional[str] = None
    error_message: Optional[str] = None
    max_weight_kg: float = 0.0
    max_area_cm2: float = 0.0
    max_lateral_imbalance_percent: Optional[float] = None
    step_states: List[FloorState] = Field(default_factory=list)
    demo_stacking: Optional[DemoStackingPolicy] = None


class CurfewWindow(StrictContractModel):
    max_payload_kg: float = Field(gt=0)
    start_sec: int = Field(ge=0)
    end_sec: int = Field(gt=0)


def advance_past_curfews(
    arrival_sec: float,
    service_sec: int,
    vehicle_payload_kg: float,
    curfews: Sequence[object],
) -> float:
    """Shift arrival past any curfew window overlapping [t, t + service_sec) for heavy vehicles."""
    if not curfews:
        return arrival_sec
    t = arrival_sec
    svc = max(0, int(service_sec))
    changed = True
    while changed:
        changed = False
        for cw in curfews:
            if vehicle_payload_kg <= float(cw.max_payload_kg) + 1e-6:
                continue
            overlaps = (
                (t < cw.end_sec and (t + svc) > cw.start_sec)
                if svc > 0
                else (cw.start_sec <= t < cw.end_sec)
            )
            if overlaps:
                t = float(cw.end_sec)
                changed = True
    return t


class OrderPair(StrictContractModel):
    ordered_at_sec: int = 0
    order_value_vnd: int = Field(default=0, ge=0)
    id: str
    source_order_id: Optional[str] = None
    source_order_number: Optional[str] = None
    split_group_id: Optional[str] = None
    allowed_source_vehicle_ids: List[str] = Field(default_factory=list)
    order_number: str
    pickup_location: LocationPoint
    delivery_location: LocationPoint
    items: List[CargoItem] = Field(min_length=1)
    pickup_window_start_sec: int = Field(default=0, ge=0)
    pickup_window_end_sec: int = Field(default=604800, ge=0)
    delivery_window_start_sec: int = Field(default=0, ge=0)
    delivery_window_end_sec: int = Field(default=604800, ge=0)
    # Legacy scalar remains for old snapshots; v1 producers send both explicit durations.
    service_time_sec: int = Field(default=1200, ge=0)
    pickup_service_time_sec: Optional[int] = Field(default=None, ge=0)
    delivery_service_time_sec: Optional[int] = Field(default=None, ge=0)
    pickup_curfew_windows: List[CurfewWindow] = Field(default_factory=list)
    delivery_curfew_windows: List[CurfewWindow] = Field(default_factory=list)
    time_window_basis: Literal["SERVICE_START"] = "SERVICE_START"
    package_contract_version: Optional[Literal["1"]] = None

    def service_seconds(self, stop_type: str) -> int:
        duration = self.pickup_service_time_sec if stop_type == "PICKUP" else self.delivery_service_time_sec
        return self.service_time_sec if duration is None else duration

    @property
    def total_weight_kg(self) -> float:
        return sum(it.weight_kg for it in self.items)


    @model_validator(mode="after")
    def validate_windows(self):
        if self.package_contract_version == "1" and (self.pickup_service_time_sec is None or self.delivery_service_time_sec is None):
            raise ValueError("Package v1 requires both service durations")
        if self.pickup_window_start_sec > self.pickup_window_end_sec:
            raise ValueError("pickup time window is invalid")
        if self.delivery_window_start_sec > self.delivery_window_end_sec:
            raise ValueError("delivery time window is invalid")
        return self


class OptimizationRequest(StrictContractModel):
    job_id: str
    vehicle: VehicleFloor
    depot: LocationPoint
    end_depot: Optional[LocationPoint] = None
    return_to_depot: bool = True
    driving_rest_policy: Optional[DrivingRestPolicy] = None
    orders: List[OrderPair] = Field(min_length=1)
    demo_stacking: Optional[DemoStackingPolicy] = Field(
        default_factory=default_stacking_policy
    )
    max_time_seconds: int = Field(default=10, ge=1, le=120)
    distance_matrix_meters: List[List[float]]
    duration_matrix_seconds: List[List[float]]


class FleetOptimizationRequest(StrictContractModel):
    job_id: str
    vehicles: List[FleetVehicle] = Field(min_length=1)
    drivers: List[DriverOption] = Field(min_length=1)
    orders: List[OrderPair] = Field(min_length=1)
    demo_stacking: Optional[DemoStackingPolicy] = Field(
        default_factory=default_stacking_policy
    )
    policy: CostPolicy
    max_time_seconds: int = Field(
        default=15, ge=1, le=1000,
        description="Upper limit for the fleet solver budget used by search policy.",
    )
    search_time_seconds: Optional[int] = Field(
        default=None, ge=1, le=1000,
        description=(
            "Requested search budget. Time spent preparing input, computing a direct "
            "delivery baseline, and checking candidates can affect total response time."
        ),
    )
    early_stop_patience: int = Field(default=0, ge=0, le=1000)
    hybrid_seed_count: int = Field(default=0, ge=0, le=20)
    distance_matrix_meters: List[List[float]]
    duration_matrix_seconds: List[List[float]]
    toll_matrix_vnd: Optional[List[List[float]]] = None

    @model_validator(mode="after")
    def validate_matrix_shape(self):
        expected = len(self.vehicles) + 2 * len(self.orders)
        known_location_keys = set()
        known_coords = set()
        for vehicle in self.vehicles:
            known_location_keys.add(vehicle.depot.id)
            if vehicle.depot.source_location_id:
                known_location_keys.add(vehicle.depot.source_location_id)
            if vehicle.depot.warehouse_location_id:
                known_location_keys.add(vehicle.depot.warehouse_location_id)
            known_coords.add((round(vehicle.depot.latitude, 6), round(vehicle.depot.longitude, 6)))
        for order in self.orders:
            for loc in (order.pickup_location, order.delivery_location):
                known_location_keys.add(loc.id)
                if loc.source_location_id:
                    known_location_keys.add(loc.source_location_id)
                if loc.warehouse_location_id:
                    known_location_keys.add(loc.warehouse_location_id)
                known_coords.add((round(loc.latitude, 6), round(loc.longitude, 6)))

        extra_end_keys: List[str] = []
        for vehicle in self.vehicles:
            end_depot = vehicle.end_depot
            if end_depot is None:
                continue
            key = end_depot.warehouse_location_id or end_depot.source_location_id or end_depot.id
            end_keys = {
                k
                for k in (end_depot.id, end_depot.source_location_id, end_depot.warehouse_location_id)
                if k
            }
            coord = (round(end_depot.latitude, 6), round(end_depot.longitude, 6))
            if (
                not (end_keys & known_location_keys)
                and coord not in known_coords
                and key not in extra_end_keys
            ):
                extra_end_keys.append(key)

        expected_with_extra = expected + len(extra_end_keys)
        allowed_sizes = {expected}
        if extra_end_keys:
            allowed_sizes = {expected_with_extra}
        elif any(v.end_depot is not None for v in self.vehicles):
            allowed_sizes = {expected, expected_with_extra}

        matrices_to_validate: List[tuple[str, List[List[float]]]] = [
            ("distance_matrix_meters", self.distance_matrix_meters),
            ("duration_matrix_seconds", self.duration_matrix_seconds),
        ]
        if self.toll_matrix_vnd is not None:
            matrices_to_validate.append(("toll_matrix_vnd", self.toll_matrix_vnd))

        for name, matrix in matrices_to_validate:
            if len(matrix) not in allowed_sizes or any(len(row) != len(matrix) for row in matrix):
                target_size = expected_with_extra if extra_end_keys else expected
                raise ValueError(f"{name} must be a {target_size}x{target_size} matrix")
            if self.distance_matrix_meters and len(matrix) != len(self.distance_matrix_meters):
                raise ValueError(f"{name} must match distance_matrix_meters shape")
            if any(not isfinite(value) or value < 0 for row in matrix for value in row):
                raise ValueError(f"{name} must contain finite nonnegative values")
        for name, identifiers in (
            ("orders", [order.id for order in self.orders]),
            ("vehicles", [vehicle.id for vehicle in self.vehicles]),
            ("drivers", [driver.id for driver in self.drivers]),
            ("items", [item.id for order in self.orders for item in order.items]),
        ):
            if len(identifiers) != len(set(identifiers)):
                raise ValueError(f"{name} must have unique IDs")
        return self


class ScheduledStop(StrictContractModel):
    sequence: int
    location_id: str
    location_name: str
    stop_type: Literal["PICKUP", "DELIVERY"]
    order_id: Optional[str] = None
    allocation_id: Optional[str] = None
    order_stop_id: Optional[str] = None
    latitude: float
    longitude: float
    arrival_time_sec: int
    departure_time_sec: int
    travel_time_sec: int = Field(default=0, ge=0)
    waiting_time_sec: int = Field(default=0, ge=0)
    service_time_sec: int = Field(default=0, ge=0)
    items_loaded: List[str] = Field(default_factory=list)
    items_unloaded: List[str] = Field(default_factory=list)
    current_weight_kg: float = 0.0


class RouteCostBreakdown(StrictContractModel):
    base_fuel_cost_vnd: int
    load_fuel_surcharge_vnd: int
    fuel_cost_vnd: int
    cargo_holding_cost_vnd: int
    late_delivery_penalty_vnd: int = 0
    cargo_distance_ton_km: float
    cargo_time_ton_hours: float
    vehicle_fixed_cost_vnd: int
    driver_fixed_salary_allocation_vnd: int
    driver_trip_pay_vnd: int
    toll_cost_vnd: int = 0
    overnight_allowance_vnd: int = 0
    weight_balance_penalty_vnd: int = 0
    total_cost_vnd: int


class OptimizedRoute(StrictContractModel):
    route_id: Optional[str] = None
    vehicle_id: str
    service_day_index: int = Field(default=0, ge=0)
    start_time_sec: int = Field(default=0, ge=0)
    end_time_sec: int = Field(default=0, ge=0)
    plate_number: str
    vehicle_length_cm: float
    vehicle_width_cm: float
    vehicle_height_cm: Optional[float] = None
    driver_id: Optional[str] = None
    driver_name: Optional[str] = None
    driver_license_class: Optional[str] = None
    total_distance_km: float
    total_duration_minutes: float
    return_travel_time_sec: int = Field(default=0, ge=0)
    return_waiting_time_sec: int = Field(default=0, ge=0)
    mandatory_rest_sec: int = Field(default=0, ge=0)
    total_driving_sec: int = Field(default=0, ge=0)
    rest_breaks: List[RestBreakRecord] = Field(default_factory=list)
    province_hops: List[str] = Field(default_factory=list)
    stops: List[ScheduledStop]
    spatial_validation: SpatialValidationResult
    cost: Optional[RouteCostBreakdown] = None
    route_geometry: Optional[Dict] = None
    depot: Optional[LocationPoint] = None
    end_location: Optional[LocationPoint] = None


class UnassignedOrder(StrictContractModel):
    order_id: str
    order_number: str
    reason_code: str
    reason_message: str


class BenchmarkMetric(StrictContractModel):
    method_name: str
    description: str
    total_cost_vnd: int
    total_distance_km: float
    total_duration_minutes: float
    vehicles_used: int
    fuel_cost_vnd: int
    vehicle_fixed_cost_vnd: int
    driver_cost_vnd: int
    cargo_holding_cost_vnd: int = 0
    late_delivery_penalty_vnd: int = 0
    planning_span_days: int = 0
    physical_vehicle_count: int = 0
    driver_calendar_salary_vnd: int = 0
    driver_idle_salary_allocation_vnd: int = 0
    operational_late_penalty_vnd: int = 0
    selection_score_vnd: int = 0
    is_feasible: bool = True
    violations: List[str] = Field(default_factory=list)
    routes: List[OptimizedRoute] = Field(default_factory=list)


class BenchmarkComparisonResponse(StrictContractModel):
    or_tools: BenchmarkMetric
    direct_dedicated: BenchmarkMetric
    savings_vs_direct_vnd: Optional[int] = None
    savings_vs_direct_percent: Optional[float] = None


class PlanningObjectiveBreakdown(StrictContractModel):
    planning_span_days: int = Field(default=0, ge=0)
    operating_cost_vnd: int = Field(default=0, ge=0)
    driver_active_salary_allocation_vnd: int = Field(default=0, ge=0)
    driver_calendar_salary_vnd: int = Field(default=0, ge=0)
    driver_idle_salary_allocation_vnd: int = Field(default=0, ge=0)
    operational_late_penalty_vnd: int = Field(default=0, ge=0)
    selection_score_vnd: int = Field(default=0, ge=0)
    extra_order_trips: int = Field(default=0, ge=0)
    split_order_count: int = Field(default=0, ge=0)
    max_trips_per_order: int = Field(default=0, ge=0)
    extra_request_trips: int = Field(default=0, ge=0)
    active_route_count: int = Field(default=0, ge=0)
    physical_vehicle_count: int = Field(default=0, ge=0)
    delivery_visit_count: int = Field(default=0, ge=0)


class FleetOptimizationResponse(StrictContractModel):
    package_contract_version: Literal["1"] = "1"
    job_id: str
    status: Literal["SUCCESS", "PARTIAL", "INFEASIBLE", "TIMEOUT", "ERROR"]
    routes: List[OptimizedRoute] = Field(default_factory=list)
    unassigned_orders: List[UnassignedOrder] = Field(default_factory=list)
    total_distance_km: float = 0.0
    total_duration_minutes: float = 0.0
    total_cost_vnd: int = 0
    planning_objective: Optional[PlanningObjectiveBreakdown] = None
    benchmarks: Optional[BenchmarkComparisonResponse] = None
    diagnostics: List[str] = Field(default_factory=list)


class FleetOptimizationCandidate(StrictContractModel):
    rank: int = Field(ge=1)
    search_strategy: str
    solver_objective: int = Field(ge=0)
    is_best_found: bool = False
    result: FleetOptimizationResponse


class FleetOptimizationBatchResponse(StrictContractModel):
    job_id: str
    solver_run_count: int = Field(ge=1)
    fully_served_candidate_count: int = Field(ge=0, default=0)
    rank_by_objective_first: bool = False
    no_plan_status: Optional[Literal["TIMEOUT", "NO_COMPLETE_PLAN"]] = None
    candidates: List[FleetOptimizationCandidate]
    diagnostics: List[str] = Field(default_factory=list)


class OptimizationResponse(StrictContractModel):
    package_contract_version: Literal["1"] = "1"
    job_id: str
    status: Literal["SUCCESS", "PARTIAL", "FAILED", "INFEASIBLE", "TIMEOUT"]
    total_distance_km: float = 0.0
    total_duration_minutes: float = 0.0
    stops: List[ScheduledStop] = Field(default_factory=list)
    unassigned_order_ids: List[str] = Field(default_factory=list)
    spatial_validation: Optional[SpatialValidationResult] = None
    diagnostics: List[str] = Field(default_factory=list)


class PlacedOnboardItem(StrictContractModel):
    item: CargoItem
    retained: bool = False
    unload_stop_id: Optional[str] = None
    x: Optional[float] = Field(default=None, ge=0)
    y: Optional[float] = Field(default=None, ge=0)
    z: Optional[float] = Field(default=None, ge=0)
    placed_length_cm: Optional[float] = Field(default=None, gt=0)
    placed_width_cm: Optional[float] = Field(default=None, gt=0)
    placed_height_cm: Optional[float] = Field(default=None, gt=0)
    support_item_id: Optional[str] = None


class RemainingRouteStop(StrictContractModel):
    stop_id: str
    sequence: int = Field(ge=1)
    stop_type: Literal["PICKUP", "DELIVERY"]
    order_id: str
    order_number: Optional[str] = None
    item_ids: List[str] = Field(min_length=1)
    items_to_load: List[CargoItem] = Field(default_factory=list)
    estimated_arrival_epoch_sec: Optional[int] = Field(default=None, ge=0)
    window_end_epoch_sec: Optional[int] = Field(default=None, ge=0)
    service_duration_sec: int = Field(default=900, ge=0)


class InProgressEvaluationRequest(StrictContractModel):
    trip_id: str
    vehicle: VehicleFloor
    demo_stacking: Optional[DemoStackingPolicy] = Field(
        default_factory=default_stacking_policy
    )
    shift_end_epoch_sec: Optional[int] = Field(default=None, ge=0)
    return_to_hub_travel_sec: int = Field(default=0, ge=0)
    onboard_items: List[PlacedOnboardItem] = Field(default_factory=list)
    remaining_stops: List[RemainingRouteStop] = Field(default_factory=list)


class EvaluatedStopDecision(StrictContractModel):
    stop_id: str
    sequence: int
    stop_type: Literal["PICKUP", "DELIVERY"]
    order_id: str
    decision: Literal[
        "KEEP_DELIVER",
        "KEEP_PICKUP",
        "RETURN_TO_HUB",
        "DETACH_TO_FREE_VEHICLE",
    ]
    reason_code: Optional[
        Literal[
            "CLEAR",
            "BLOCKED_BY_RETAINED_CARGO",
            "OUTSIDE_SHIFT_WINDOW",
            "INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO",
        ]
    ] = None
    blocker_item_ids: List[str] = Field(default_factory=list)
    unload_sequence: List[str] = Field(default_factory=list)
    reason_message: Optional[str] = None


class InProgressEvaluationResponse(StrictContractModel):
    trip_id: str
    used_exact_placements: bool
    stop_decisions: List[EvaluatedStopDecision] = Field(default_factory=list)
    keep_delivery_stop_ids: List[str] = Field(default_factory=list)
    return_to_hub_stop_ids: List[str] = Field(default_factory=list)
    return_to_hub_item_ids: List[str] = Field(default_factory=list)
    detached_order_ids: List[str] = Field(default_factory=list)
    diagnostics: List[str] = Field(default_factory=list)

