from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


class LocationPoint(BaseModel):
    id: str
    name: str
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class VehicleFloor(BaseModel):
    id: str
    plate_number: str
    length_cm: float = Field(gt=0, description="Chiều dài lọt lòng thùng xe (cm)")
    width_cm: float = Field(gt=0, description="Chiều rộng lọt lòng thùng xe (cm)")
    height_cm: float = Field(gt=0, description="Chiều cao lọt lòng thùng xe (cm)")
    payload_limit_kg: float = Field(gt=0)
    door_position: Literal["REAR"] = "REAR"
    door_width_cm: Optional[float] = Field(default=None, gt=0)


class FleetVehicle(VehicleFloor):
    depot: LocationPoint
    model: Optional[str] = None
    vehicle_type: Optional[str] = None
    fuel_consumption_liters_per_100_km: float = Field(
        ge=0, description="Baseline fuel consumption without cargo"
    )
    load_fuel_surcharge_percent_at_full_payload: float = Field(
        default=0, ge=0, description="Linear surcharge over baseline at full payload"
    )
    fixed_operating_cost_vnd: int = Field(ge=0)


class DriverOption(BaseModel):
    id: str
    full_name: str
    license_class: str = "C"
    fixed_salary_monthly_vnd: int = Field(ge=0)
    trip_base_pay_vnd: int = Field(ge=0)
    per_km_pay_vnd: int = Field(ge=0)


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


class CostPolicy(BaseModel):
    fuel_price_per_liter_vnd: int = Field(gt=0)
    monthly_working_minutes: int = Field(gt=0)
    cargo_holding_cost_vnd_per_ton_hour: int = Field(default=0, ge=0)
    unassigned_order_penalty_vnd: int = Field(default=1_000_000_000, gt=0)


class CargoItem(BaseModel):
    id: str
    order_id: str
    order_item_id: Optional[str] = None
    description: str = ""
    length_cm: float = Field(gt=0)
    width_cm: float = Field(gt=0)
    height_cm: float = Field(gt=0)
    weight_kg: float = Field(gt=0)
    can_rotate: bool = True


class PlacedItem(BaseModel):
    item_id: str
    order_id: str
    x: float
    y: float
    length_cm: float
    width_cm: float
    height_cm: float
    weight_kg: float


class StopAction(BaseModel):
    stop_id: str
    sequence: int = Field(ge=1)
    stop_type: Literal["PICKUP", "DELIVERY"]
    address: str = ""
    latitude: float = Field(default=0.0, ge=-90, le=90)
    longitude: float = Field(default=0.0, ge=-180, le=180)
    items_to_load: List[CargoItem] = Field(default_factory=list)
    items_to_unload: List[str] = Field(default_factory=list)


class FloorState(BaseModel):
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
    error_code: Optional[str] = None
    error_message: Optional[str] = None


class SpatialValidationResult(BaseModel):
    is_valid: bool
    violation_code: Optional[str] = None
    violation_scenario: Optional[str] = None
    error_message: Optional[str] = None
    max_weight_kg: float = 0.0
    max_area_cm2: float = 0.0
    step_states: List[FloorState] = Field(default_factory=list)


class OrderPair(BaseModel):
    id: str
    order_number: str
    pickup_location: LocationPoint
    delivery_location: LocationPoint
    items: List[CargoItem] = Field(min_length=1)
    pickup_window_start_sec: int = Field(default=0, ge=0)
    pickup_window_end_sec: int = Field(default=604800, ge=0)
    delivery_window_start_sec: int = Field(default=0, ge=0)
    delivery_window_end_sec: int = Field(default=604800, ge=0)
    service_time_sec: int = Field(default=1200, ge=0)

    @model_validator(mode="after")
    def validate_windows(self):
        if self.pickup_window_start_sec > self.pickup_window_end_sec:
            raise ValueError("pickup time window is invalid")
        if self.delivery_window_start_sec > self.delivery_window_end_sec:
            raise ValueError("delivery time window is invalid")
        return self


class OptimizationRequest(BaseModel):
    job_id: str
    vehicle: VehicleFloor
    depot: LocationPoint
    orders: List[OrderPair] = Field(min_length=1)
    max_time_seconds: int = Field(default=10, ge=1, le=120)
    distance_matrix_meters: List[List[float]]
    duration_matrix_seconds: List[List[float]]


class FleetOptimizationRequest(BaseModel):
    job_id: str
    vehicles: List[FleetVehicle] = Field(min_length=1)
    drivers: List[DriverOption] = Field(min_length=1)
    orders: List[OrderPair] = Field(min_length=1)
    policy: CostPolicy
    max_time_seconds: int = Field(default=15, ge=1, le=120)
    distance_matrix_meters: List[List[float]]
    duration_matrix_seconds: List[List[float]]

    @model_validator(mode="after")
    def validate_matrix_shape(self):
        expected = len(self.vehicles) + 2 * len(self.orders)
        for name, matrix in (
            ("distance_matrix_meters", self.distance_matrix_meters),
            ("duration_matrix_seconds", self.duration_matrix_seconds),
        ):
            if len(matrix) != expected or any(len(row) != expected for row in matrix):
                raise ValueError(f"{name} must be a {expected}x{expected} matrix")
            if any(value < 0 for row in matrix for value in row):
                raise ValueError(f"{name} cannot contain negative values")
        if len(self.vehicles) > len(self.drivers):
            raise ValueError("Each candidate vehicle requires an available driver")
        return self


class ScheduledStop(BaseModel):
    sequence: int
    location_id: str
    location_name: str
    stop_type: Literal["PICKUP", "DELIVERY"]
    order_id: Optional[str] = None
    latitude: float
    longitude: float
    arrival_time_sec: int
    departure_time_sec: int
    items_loaded: List[str] = Field(default_factory=list)
    items_unloaded: List[str] = Field(default_factory=list)
    current_weight_kg: float = 0.0


class RouteCostBreakdown(BaseModel):
    base_fuel_cost_vnd: int
    load_fuel_surcharge_vnd: int
    fuel_cost_vnd: int
    cargo_holding_cost_vnd: int
    cargo_distance_ton_km: float
    cargo_time_ton_hours: float
    vehicle_fixed_cost_vnd: int
    driver_fixed_salary_allocation_vnd: int
    driver_trip_pay_vnd: int
    total_cost_vnd: int


class OptimizedRoute(BaseModel):
    vehicle_id: str
    plate_number: str
    vehicle_length_cm: float
    vehicle_width_cm: float
    driver_id: Optional[str] = None
    driver_name: Optional[str] = None
    driver_license_class: Optional[str] = None
    total_distance_km: float
    total_duration_minutes: float
    stops: List[ScheduledStop]
    spatial_validation: SpatialValidationResult
    cost: Optional[RouteCostBreakdown] = None
    route_geometry: Optional[Dict] = None


class UnassignedOrder(BaseModel):
    order_id: str
    order_number: str
    reason_code: str
    reason_message: str


class FleetOptimizationResponse(BaseModel):
    job_id: str
    status: Literal["SUCCESS", "PARTIAL", "INFEASIBLE", "TIMEOUT", "ERROR"]
    routes: List[OptimizedRoute] = Field(default_factory=list)
    unassigned_orders: List[UnassignedOrder] = Field(default_factory=list)
    total_distance_km: float = 0.0
    total_duration_minutes: float = 0.0
    total_cost_vnd: int = 0
    diagnostics: List[str] = Field(default_factory=list)


class OptimizationResponse(BaseModel):
    job_id: str
    status: Literal["SUCCESS", "PARTIAL", "FAILED", "INFEASIBLE", "TIMEOUT"]
    total_distance_km: float = 0.0
    total_duration_minutes: float = 0.0
    stops: List[ScheduledStop] = Field(default_factory=list)
    unassigned_order_ids: List[str] = Field(default_factory=list)
    spatial_validation: Optional[SpatialValidationResult] = None
    diagnostics: List[str] = Field(default_factory=list)
