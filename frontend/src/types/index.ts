export interface User {
  id: string;
  username: string;
  fullName: string;
  role: 'ADMIN' | 'DISPATCHER' | 'DRIVER' | 'STAFF' | 'CUSTOMER';
  branchId?: string;
  locationId?: string;
  phone?: string;
  branch?: Branch;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  phone?: string;
  timezone: string;
  fuelPricePerLiter?: string;
  monthlyWorkingMinutes?: number;
  cargoHoldingCostVndPerTonHour?: string;
  deliveryGraceDays?: number;
  lateDeliveryPenaltyMode?: 'NONE' | 'FIXED_PER_DAY' | 'PERCENT_ORDER_VALUE_PER_DAY';
  lateDeliveryPenaltyValue?: string;
  _count?: {
    vehicles: number;
    drivers: number;
  };
}

export interface Location {
  id: string;
  code: string;
  name: string;
  type: 'STORE' | 'CENTRAL_WAREHOUSE' | 'PICKUP_POINT';
  managingBranchId?: string | null;
  address: string;
  latitude: number;
  longitude: number;
  capabilities?: string[] | null;
  totalHoldingSlots: number;
  availableHoldingSlots: number;
}

export interface Vehicle {
  id: string;
  plateNumber: string;
  model: string;
  vehicleType: string;
  homeBranchId: string;
  homeBranch?: Branch;
  payloadCapacityKg: number;
  volumeCapacityM3: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  fuelConsumptionLitersPer100Km?: string;
  loadFuelSurchargePercentAtFullPayload?: string;
  fixedOperatingCostPerTrip?: string;
  status: 'AVAILABLE' | 'MAINTENANCE' | 'ON_TRIP' | 'DECOMMISSIONED';
  homeDepotLocationId?: string;
  homeDepotLocation?: Location;
  currentLatitude?: number;
  currentLongitude?: number;
  lastLocationAt?: string;
}

export interface Driver {
  id: string;
  fullName: string;
  citizenId: string;
  phone: string;
  licenseNumber: string;
  licenseClass: string;
  licenseExpiry: string;
  homeBranchId: string;
  homeBranch?: Branch;
  status: 'AVAILABLE' | 'ON_DUTY' | 'ON_LEAVE' | 'RESTING';
  fixedSalaryMonthly?: string;
  tripBasePay?: string;
  perKmPay?: string;
}

export interface OrderItem {
  id: string;
  sku?: string;
  description: string;
  packageType: string;
  quantity: number;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  volumeM3: number;
}

export interface OrderStop {
  id: string;
  orderId: string;
  type: 'PICKUP' | 'DELIVERY';
  sequence: number;
  address: string;
  latitude: number;
  longitude: number;
  contactName: string;
  contactPhone: string;
  serviceDurationMinutes: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  customerId: string;
  branchId: string;
  branch?: {
    id: string;
    code: string;
    name: string;
  };
  customer: {
    id: string;
    code: string;
    name: string;
    phone?: string;
  };
  status: 'DRAFT' | 'CONFIRMED' | 'ASSIGNED' | 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED';
  totalWeightKg: number;
  totalVolumeM3: number;
  totalPackages: number;
  version: number;
  notes?: string;
  orderedAt: string;
  totalAmount: string;
  stops: OrderStop[];
  items: OrderItem[];
  createdAt: string;
}

export interface TripStop {
  id: string;
  sequence: number;
  stopType: 'DEPOT_START' | 'PICKUP' | 'DELIVERY' | 'DEPOT_END';
  address: string;
  latitude: number;
  longitude: number;
  contactName?: string;
  contactPhone?: string;
  plannedArrivalTime?: string;
  plannedDepartureTime?: string;
  status: string;
  tasks: Array<{
    id: string;
    orderId?: string;
    orderStopId?: string;
    action: 'LOAD' | 'UNLOAD';
    plannedQuantity: number;
    actualQuantity?: number;
    order?: Pick<Order, 'id' | 'orderNumber' | 'customer' | 'items'>;
  }>;
}

export interface Trip {
  id: string;
  tripNumber: string;
  version: number;
  vehicleId: string;
  vehicle: Vehicle;
  status: 'DRAFT' | 'PLANNED' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  plannedStartTime: string;
  plannedEndTime: string;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  routeGeometry?: string;
  notes?: string;
  planningSnapshot?: {
    startLocation?: { address: string; latitude: number; longitude: number };
    endLocation?: { address: string; latitude: number; longitude: number };
  };
  stops: TripStop[];
  assignments: Array<{
    id: string;
    driver: Driver;
    role: string;
  }>;
  createdAt: string;
}

export interface LegLoadStatus {
  stopIndex: number;
  stopAddress: string;
  stopType: 'PICKUP' | 'DELIVERY';
  action: 'LOAD' | 'UNLOAD';
  deltaWeightKg: number;
  deltaVolumeM3: number;
  currentWeightKg: number;
  currentVolumeM3: number;
  weightUtilizationPercent: number;
  volumeUtilizationPercent: number;
}

export interface LoadProfileResult {
  isValid: boolean;
  loadProfile: LegLoadStatus[];
  maxWeightKg: number;
  maxVolumeM3: number;
  errors: string[];
}

export interface PlacedItemUI {
  item_id: string;
  order_id: string;
  x: number;
  y: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  weight_kg: number;
}

export interface PackageAccessPathUI {
  item_id: string;
  is_clear: boolean;
  points: Array<{ x: number; y: number }>;
  blocker_item_ids: string[];
}

export interface FloorStepStateUI {
  step_index: number;
  stop_id: string;
  stop_type: string;
  action_description: string;
  placed_items: PlacedItemUI[];
  current_weight_kg: number;
  current_occupied_area_cm2: number;
  floor_area_cm2: number;
  weight_utilization_percent: number;
  area_utilization_percent: number;
  is_valid: boolean;
  package_access_paths?: PackageAccessPathUI[];
}

export interface SpatialValidationUI {
  is_valid: boolean;
  violation_code?: string;
  violation_scenario?: string;
  error_message?: string;
  max_weight_kg: number;
  max_area_cm2: number;
  step_states: FloorStepStateUI[];
}

export interface OptimizedStopUI {
  location_id: string;
  location_name: string;
  order_id?: string;
  stop_type: 'PICKUP' | 'DELIVERY';
  sequence: number;
  latitude: number;
  longitude: number;
  arrival_time_sec: number;
  departure_time_sec: number;
  items_loaded: string[];
  items_unloaded: string[];
  current_weight_kg: number;
}

export interface OptimizationResultUI {
  job_id: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'INFEASIBLE' | 'TIMEOUT';
  total_distance_km: number;
  total_duration_minutes: number;
  stops: OptimizedStopUI[];
  unassigned_order_ids: string[];
  spatial_validation?: SpatialValidationUI;
  diagnostics: string[];
}

export interface RouteCostBreakdownUI {
  base_fuel_cost_vnd: number;
  load_fuel_surcharge_vnd: number;
  fuel_cost_vnd: number;
  cargo_holding_cost_vnd: number;
  late_delivery_penalty_vnd: number;
  cargo_distance_ton_km: number;
  cargo_time_ton_hours: number;
  vehicle_fixed_cost_vnd: number;
  driver_fixed_salary_allocation_vnd: number;
  driver_trip_pay_vnd: number;
  total_cost_vnd: number;
}

export interface OptimizedRouteUI {
  route_id: string;
  vehicle_id: string;
  service_day_index: number;
  start_time_sec: number;
  end_time_sec: number;
  plate_number: string;
  vehicle_length_cm: number;
  vehicle_width_cm: number;
  driver_id?: string;
  driver_name?: string;
  driver_license_class?: string;
  total_distance_km: number;
  total_duration_minutes: number;
  depot?: {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
  };
  stops: OptimizedStopUI[];
  spatial_validation: SpatialValidationUI;
  cost?: RouteCostBreakdownUI;
  route_geometry?: { type: 'LineString'; coordinates: [number, number][] };
}

export interface BenchmarkMetricUI {
  method_name: string;
  description: string;
  total_cost_vnd: number;
  total_distance_km: number;
  total_duration_minutes: number;
  vehicles_used: number;
  fuel_cost_vnd: number;
  vehicle_fixed_cost_vnd: number;
  driver_cost_vnd: number;
  cargo_holding_cost_vnd: number;
  late_delivery_penalty_vnd: number;
  is_feasible: boolean;
  violations: string[];
}

export interface BenchmarkComparisonUI {
  or_tools: BenchmarkMetricUI;
  direct_dedicated: BenchmarkMetricUI;
  savings_vs_direct_vnd: number | null;
  savings_vs_direct_percent: number | null;
}

export interface FleetOptimizationResultUI {
  job_id: string;
  status: 'SUCCESS' | 'PARTIAL' | 'INFEASIBLE' | 'TIMEOUT' | 'ERROR';
  routes: OptimizedRouteUI[];
  unassigned_orders: Array<{
    order_id: string;
    order_number: string;
    reason_code: string;
    reason_message: string;
  }>;
  total_distance_km: number;
  total_duration_minutes: number;
  total_cost_vnd: number;
  benchmarks?: BenchmarkComparisonUI;
  diagnostics: string[];
}

export type AutomaticDispatchScheduleModeUI = 'CURRENT_TIME' | 'NEXT_DAY';

export interface RunAutomaticOptimizationPayloadUI {
  idempotencyKey: string;
  branchId: string;
  scheduleMode?: AutomaticDispatchScheduleModeUI;
  customStartTime?: string;
}

export interface OptimizationProposalUI {
  branchId: string;
  planningEpochIso: string;
  scheduleMode?: AutomaticDispatchScheduleModeUI;
  expiresAt: string;
  resources: {
    orders: Array<{ id: string; version: number }>;
    vehicles: Array<{ id: string; updatedAt: string }>;
    drivers: Array<{ id: string; updatedAt: string }>;
  };
  result: FleetOptimizationResultUI;
}

export type OptimizationJobStatusUI =
  | 'PENDING'
  | 'RUNNING'
  | 'RETRYING'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'INFEASIBLE'
  | 'TIMEOUT'
  | 'FAILED'
  | 'APPLYING'
  | 'APPLIED';

export interface AutomaticOptimizationResponseUI {
  id: string;
  branchId: string;
  status: OptimizationJobStatusUI;
  schemaVersion: string;
  planningEpochIso: string | null;
  scheduleMode: AutomaticDispatchScheduleModeUI | null;
  result: FleetOptimizationResultUI | null;
  error: { code: string; message: string | null } | null;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyOptimizationResponseUI {
  jobId: string;
  status: 'APPLIED';
  appliedAt: string;
  trips: Array<{
    id: string;
    tripNumber: string;
    vehicleId: string;
    driverId: string;
    orderIds: string[];
    plannedStartTime: string;
    plannedEndTime: string;
  }>;
}
