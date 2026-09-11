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

export type BenchmarkMetric = {
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
  is_feasible: boolean;
  violations: string[];
};

export type BenchmarkComparison = {
  or_tools: BenchmarkMetric;
  direct_dedicated: BenchmarkMetric;
  savings_vs_direct_vnd: number | null;
  savings_vs_direct_percent: number | null;
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
  benchmarks?: BenchmarkComparison;
  diagnostics: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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
  for (const field of [
    'total_distance_km',
    'total_duration_minutes',
    'total_cost_vnd',
  ]) {
    if (!isFiniteNumber(value[field]) || Number(value[field]) < 0) {
      throw new Error(`Optimizer response có ${field} không hợp lệ`);
    }
  }
  if (
    !Array.isArray(value.diagnostics) ||
    !value.diagnostics.every((item) => typeof item === 'string')
  ) {
    throw new Error('Optimizer response thiếu diagnostics hợp lệ');
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
    for (const field of [
      'vehicle_length_cm',
      'vehicle_width_cm',
      'total_distance_km',
      'total_duration_minutes',
    ]) {
      if (!isFiniteNumber(route[field]) || Number(route[field]) < 0) {
        throw new Error(`Optimizer trả route.${field} không hợp lệ`);
      }
    }
    if (
      typeof route.plate_number !== 'string' ||
      (route.driver_id !== undefined && typeof route.driver_id !== 'string') ||
      (route.driver_name !== undefined && typeof route.driver_name !== 'string') ||
      !Array.isArray(route.spatial_validation.step_states)
    ) {
      throw new Error('Optimizer trả thông tin xe/tài xế/spatial không hợp lệ');
    }
    for (const stop of route.stops) {
      if (
        !isRecord(stop) ||
        !Number.isInteger(stop.sequence) ||
        typeof stop.location_id !== 'string' ||
        typeof stop.location_name !== 'string' ||
        !['PICKUP', 'DELIVERY'].includes(String(stop.stop_type)) ||
        typeof stop.order_id !== 'string' ||
        !isFiniteNumber(stop.latitude) ||
        !isFiniteNumber(stop.longitude) ||
        !isFiniteNumber(stop.arrival_time_sec) ||
        !isFiniteNumber(stop.departure_time_sec) ||
        !Array.isArray(stop.items_loaded) ||
        !Array.isArray(stop.items_unloaded) ||
        !isFiniteNumber(stop.current_weight_kg)
      ) {
        throw new Error('Optimizer trả điểm dừng không hợp lệ');
      }
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
  for (const order of value.unassigned_orders) {
    if (
      !isRecord(order) ||
      typeof order.order_id !== 'string' ||
      typeof order.order_number !== 'string' ||
      typeof order.reason_code !== 'string' ||
      typeof order.reason_message !== 'string'
    ) {
      throw new Error('Optimizer trả unassigned_orders không hợp lệ');
    }
  }
  if (value.benchmarks !== undefined) {
    if (!isRecord(value.benchmarks)) {
      throw new Error('Optimizer benchmarks phải là object');
    }
    for (const method of [
      'or_tools',
      'direct_dedicated',
    ]) {
      const metric = value.benchmarks[method];
      if (!isRecord(metric)) {
        throw new Error(`Optimizer benchmark ${method} không hợp lệ`);
      }
      if (typeof metric.is_feasible !== 'boolean') {
        throw new Error(`Optimizer benchmark ${method} thiếu is_feasible`);
      }
      if (
        !Array.isArray(metric.violations) ||
        !metric.violations.every((violation) => typeof violation === 'string')
      ) {
        throw new Error(`Optimizer benchmark ${method} thiếu violations hợp lệ`);
      }
      for (const field of [
        'total_cost_vnd',
        'total_distance_km',
        'total_duration_minutes',
        'vehicles_used',
        'fuel_cost_vnd',
        'vehicle_fixed_cost_vnd',
        'driver_cost_vnd',
        'cargo_holding_cost_vnd',
      ]) {
        const fieldValue = metric[field];
        if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
          throw new Error(`Optimizer benchmark ${method}.${field} không hợp lệ`);
        }
      }
    }
    for (const field of [
      'savings_vs_direct_vnd',
      'savings_vs_direct_percent',
    ]) {
      const fieldValue = value.benchmarks[field];
      if (
        fieldValue !== null &&
        (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))
      ) {
        throw new Error(`Optimizer benchmark ${field} không hợp lệ`);
      }
    }
  }
}
