"""Data models for TMS Algorithm Lab."""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class LocationPoint:
    id: str
    name: str = ""
    latitude: float = 0.0
    longitude: float = 0.0
    source_location_id: Optional[str] = None
    warehouse_location_id: Optional[str] = None
    province_code: Optional[str] = None
    province_name: Optional[str] = None
    warehouse_role: Optional[str] = None
    docking_time_sec: int = 0
    max_vehicle_payload_kg: Optional[float] = None
    max_vehicle_length_cm: Optional[float] = None
    has_forklift: Optional[bool] = None
    allows_hazmat: Optional[bool] = None
    operating_windows: List[object] = field(default_factory=list)
    handling_sec_per_ton: int = 0
    handling_sec_per_package: int = 0


@dataclass
class CargoItem:
    id: str
    order_id: str
    length_cm: float
    width_cm: float
    height_cm: float
    weight_kg: float
    can_rotate: bool = True
    description: str = ""
    customer_id: Optional[str] = None
    allowed_orientations: Optional[List[str]] = None
    cargo_kind: str = "STANDARD"
    allow_upper_tier: bool = True
    no_top_load_requested: bool = False
    max_top_load_g: Optional[int] = None
    required_temperature: Optional[str] = None
    cargo_group: Optional[str] = None
    incompatible_cargo_groups: List[str] = field(default_factory=list)
    is_hazmat: bool = False
    requires_lift_equipment: bool = False


@dataclass
class OrderPair:
    id: str
    order_number: str
    pickup_location: LocationPoint
    delivery_location: LocationPoint
    items: List[CargoItem]
    service_time_sec: int = 1200
    pickup_window_start_sec: int = 0
    pickup_window_end_sec: int = 86400
    delivery_window_start_sec: int = 0
    delivery_window_end_sec: int = 86400
    order_value_vnd: int = 0
    ordered_at_sec: int = 0
    allowed_source_vehicle_ids: List[str] = field(default_factory=list)
    source_order_id: Optional[str] = None
    split_group_id: Optional[str] = None
    pickup_service_time_sec: Optional[int] = None
    delivery_service_time_sec: Optional[int] = None
    pickup_curfew_windows: List[object] = field(default_factory=list)
    delivery_curfew_windows: List[object] = field(default_factory=list)

    def service_seconds(self, stop_type: str) -> int:
        duration = (
            self.pickup_service_time_sec
            if stop_type == "PICKUP"
            else self.delivery_service_time_sec
        )
        return self.service_time_sec if duration is None else duration

    @property
    def total_weight_kg(self) -> float:
        return sum(item.weight_kg for item in self.items)

    @property
    def total_volume_m3(self) -> float:
        return sum(
            (item.length_cm * item.width_cm * item.height_cm) / 1_000_000
            for item in self.items
        )


@dataclass
class FleetVehicle:
    id: str
    plate_number: str
    length_cm: float
    width_cm: float
    height_cm: float
    payload_limit_kg: float
    depot: LocationPoint
    end_depot: Optional[LocationPoint] = None
    door_position: str = "REAR"
    fuel_consumption_liters_per_100_km: float = 14.0
    load_fuel_surcharge_percent_at_full_payload: float = 20.0
    fixed_operating_cost_vnd: int = 100000
    source_vehicle_id: Optional[str] = None
    service_day_index: int = 0
    available_start_sec: int = 0
    available_end_sec: int = 30 * 86400
    return_to_depot: bool = True
    vehicle_type: Optional[str] = None
    model: Optional[str] = None
    temperature_mode: str = "DRY"
    allows_hazmat: bool = False
    has_tail_lift: bool = False
    toll_factor: float = 1.0
    door_width_cm: Optional[float] = None


@dataclass
class DriverOption:
    id: str
    full_name: str
    license_class: str = "C"
    fixed_salary_monthly_vnd: int = 12000000
    trip_base_pay_vnd: int = 150000
    per_km_pay_vnd: int = 1200
    source_driver_id: Optional[str] = None
    service_day_index: int = 0
    home_location_id: Optional[str] = None
    home_province_code: Optional[str] = None
    strict_home_location: bool = False
    initial_weekly_driving_sec: int = 0


@dataclass
class CostPolicy:
    delivery_grace_days: int = 2
    fuel_price_per_liter_vnd: int = 23800
    monthly_working_minutes: int = 10560
    cargo_holding_cost_vnd_per_ton_hour: int = 15000
    unassigned_order_penalty_vnd: int = 10_000_000  # 10 tr VND / đơn bị bỏ rơi
    late_delivery_penalty_mode: str = "FIXED_PER_DAY"
    late_delivery_penalty_value: float = 500000.0
    demo_stacking: Optional[object] = None
    driving_rest_policy: Optional[object] = None
    toll_matrix_vnd: Optional[List[List[float]]] = None
    weight_balance_penalty_vnd_per_percent: int = 0
    enforce_weight_balance: bool = False
    max_lateral_imbalance_percent: Optional[float] = None
    max_longitudinal_imbalance_percent: Optional[float] = None


@dataclass
class PlacedItem:
    item_id: str
    order_id: str
    x: float
    y: float
    length_cm: float
    width_cm: float
    weight_kg: Optional[float] = None
    cargo_kind: str = "UNCLASSIFIED"


@dataclass
class ScheduledStop:
    sequence: int
    stop_type: str  # "DEPOT_START", "PICKUP", "DELIVERY", "DEPOT_END"
    location_id: str
    location_name: str
    order_id: Optional[str] = None
    order_number: Optional[str] = None
    arrival_time_sec: int = 0
    departure_time_sec: int = 0
    current_weight_kg: float = 0.0
    items_loaded: List[str] = field(default_factory=list)
    items_unloaded: List[str] = field(default_factory=list)
    placed_items: List[PlacedItem] = field(default_factory=list)
    travel_time_sec: int = 0
    waiting_time_sec: int = 0
    service_time_sec: int = 0


@dataclass
class RouteCostBreakdown:
    base_fuel_cost_vnd: int = 0
    load_fuel_surcharge_vnd: int = 0
    fuel_cost_vnd: int = 0
    fixed_vehicle_cost_vnd: int = 0
    driver_salary_allocation_vnd: int = 0
    driver_trip_pay_vnd: int = 0
    driver_total_pay_vnd: int = 0
    cargo_holding_cost_vnd: int = 0
    late_delivery_penalty_vnd: int = 0
    toll_cost_vnd: int = 0
    overnight_allowance_vnd: int = 0
    weight_balance_penalty_vnd: int = 0
    total_cost_vnd: int = 0


@dataclass
class OptimizedRoute:
    vehicle: FleetVehicle
    driver: DriverOption
    stops: List[ScheduledStop]
    total_distance_km: float
    total_duration_minutes: float
    cost_breakdown: RouteCostBreakdown
    total_driving_sec: int = 0


@dataclass
class OptimizationSolution:
    solver_name: str
    execution_time_sec: float
    routes: List[OptimizedRoute]
    unassigned_orders: List[str]
    real_economic_cost_vnd: int
    penalized_objective_vnd: int
    total_distance_km: float
    fulfillment_rate: float
    is_spatial_valid: bool
    spatial_notes: str = ""
    is_temporally_valid: bool = True
    is_contract_valid: bool = True
    validation_notes: List[str] = field(default_factory=list)
    random_seed: Optional[int] = None
    solution_audited: bool = False
