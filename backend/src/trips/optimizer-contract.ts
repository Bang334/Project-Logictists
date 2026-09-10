export type OptimizerStop = {
  sequence: number;
  location_id: string;
  location_name: string;
  stop_type: 'PICKUP' | 'DELIVERY';
  order_id: string;
  latitude: number;
  longitude: number;
  arrival_time_sec: number;
  departure_time_sec: number;
  items_loaded: string[];
  items_unloaded: string[];
  current_weight_kg: number;
};

export type OptimizedRouteResult = {
  vehicle_id: string;
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
  stops: OptimizerStop[];
  spatial_validation: {
    is_valid: boolean;
    violation_code?: string;
    violation_scenario?: string;
    error_message?: string;
    max_weight_kg: number;
    max_area_cm2: number;
    step_states: unknown[];
  };
  cost: {
    base_fuel_cost_vnd: number;
    load_fuel_surcharge_vnd: number;
    fuel_cost_vnd: number;
    cargo_holding_cost_vnd: number;
    cargo_distance_ton_km: number;
    cargo_time_ton_hours: number;
    vehicle_fixed_cost_vnd: number;
    driver_fixed_salary_allocation_vnd: number;
    driver_trip_pay_vnd: number;
    total_cost_vnd: number;
  };
  route_geometry?: { type: string; coordinates: number[][] };
};

export type FleetOptimizationResult = {
  job_id: string;
  status: 'SUCCESS' | 'PARTIAL' | 'INFEASIBLE' | 'TIMEOUT' | 'ERROR';
  routes: OptimizedRouteResult[];
  unassigned_orders: Array<{
    order_id: string;
    order_number: string;
    reason_code: string;
    reason_message: string;
  }>;
  total_distance_km: number;
  total_duration_minutes: number;
  total_cost_vnd: number;
  diagnostics: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertFleetOptimizationResult(
  value: unknown,
): asserts value is FleetOptimizationResult {
  if (!isRecord(value)) throw new Error('Optimizer response phải là object');
  const validStatuses = ['SUCCESS', 'PARTIAL', 'INFEASIBLE', 'TIMEOUT', 'ERROR'];
  if (typeof value.job_id !== 'string' || !validStatuses.includes(String(value.status))) {
    throw new Error('Optimizer response thiếu job_id/status hợp lệ');
  }
  if (!Array.isArray(value.routes) || !Array.isArray(value.unassigned_orders)) {
    throw new Error('Optimizer response thiếu routes/unassigned_orders');
  }
  for (const route of value.routes) {
    if (
      !isRecord(route) ||
      typeof route.vehicle_id !== 'string' ||
      !Array.isArray(route.stops) ||
      !isRecord(route.spatial_validation) ||
      route.spatial_validation.is_valid !== true
    ) {
      throw new Error('Optimizer trả route thiếu dữ liệu hoặc chưa vượt spatial validator');
    }
    if (!isRecord(route.cost)) {
      throw new Error('Optimizer trả route thiếu bảng phân rã chi phí');
    }
    for (const field of [
      'base_fuel_cost_vnd',
      'load_fuel_surcharge_vnd',
      'fuel_cost_vnd',
      'cargo_holding_cost_vnd',
      'cargo_distance_ton_km',
      'cargo_time_ton_hours',
      'vehicle_fixed_cost_vnd',
      'driver_fixed_salary_allocation_vnd',
      'driver_trip_pay_vnd',
      'total_cost_vnd',
    ]) {
      const fieldValue = route.cost[field];
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        throw new Error(`Optimizer trả trường chi phí ${field} không hợp lệ`);
      }
    }
  }
}
