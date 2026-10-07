export type OptimizerStop = {
  sequence: number;
  location_id: string;
  location_name: string;
  stop_type: 'PICKUP' | 'DELIVERY';
  order_id: string;
  allocation_id: string;
  order_stop_id: string;
  latitude: number;
  longitude: number;
  arrival_time_sec: number;
  departure_time_sec: number;
  travel_time_sec?: number;
  waiting_time_sec?: number;
  service_time_sec?: number;
  items_loaded: string[];
  items_unloaded: string[];
  current_weight_kg: number;
};

export type OptimizedRouteResult = {
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
  return_travel_time_sec?: number;
  return_waiting_time_sec?: number;
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
    step_states: Array<{
      step_index: number;
      stop_id: string;
      stop_type: string;
      action_description: string;
      placed_items: Array<{
        item_id: string;
        order_id: string;
        x: number;
        y: number;
        length_cm: number;
        width_cm: number;
        height_cm: number;
        weight_kg: number;
      }>;
      current_weight_kg: number;
      current_occupied_area_cm2: number;
      floor_area_cm2: number;
      weight_utilization_percent: number;
      area_utilization_percent: number;
      is_valid: boolean;
      unload_sequence?: string[];
      package_access_paths: Array<{
        item_id: string;
        is_clear: boolean;
        points: Array<{ x: number; y: number }>;
        blocker_item_ids: string[];
      }>;
      error_code?: string;
      error_message?: string;
    }>;
  };
  cost: {
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
  late_delivery_penalty_vnd: number;
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

export type FleetOptimizationCandidateResult = {
  rank: number;
  search_strategy: string;
  solver_objective: number;
  is_best_found: boolean;
  result: FleetOptimizationResult;
};

export type FleetOptimizationBatchResult = {
  job_id: string;
  solver_run_count: number;
  fully_served_candidate_count: number;
  candidates: FleetOptimizationCandidateResult[];
  diagnostics?: string[];
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
      typeof route.route_id !== 'string' ||
      typeof route.vehicle_id !== 'string' ||
      !Array.isArray(route.stops) ||
      !isRecord(route.spatial_validation) ||
      route.spatial_validation.is_valid !== true
    ) {
      throw new Error('Optimizer trả route thiếu dữ liệu hoặc chưa vượt spatial validator');
    }
    for (const field of [
      'service_day_index',
      'start_time_sec',
      'end_time_sec',
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
      !Number.isInteger(route.service_day_index) ||
      Number(route.end_time_sec) <= Number(route.start_time_sec)
    ) {
      throw new Error('Optimizer trả khung thời gian tuyến không hợp lệ');
    }
    if (
      typeof route.plate_number !== 'string' ||
      (route.driver_id !== undefined && typeof route.driver_id !== 'string') ||
      (route.driver_name !== undefined && typeof route.driver_name !== 'string') ||
      !Array.isArray(route.spatial_validation.step_states)
    ) {
      throw new Error('Optimizer trả thông tin xe/tài xế/spatial không hợp lệ');
    }
    for (const step of route.spatial_validation.step_states) {
      if (
        !isRecord(step) ||
        !Number.isInteger(step.step_index) ||
        typeof step.stop_id !== 'string' ||
        typeof step.stop_type !== 'string' ||
        typeof step.action_description !== 'string' ||
        !Array.isArray(step.placed_items) ||
        (step.unload_sequence !== undefined &&
          (!Array.isArray(step.unload_sequence) ||
            !step.unload_sequence.every((itemId) => typeof itemId === 'string'))) ||
        !Array.isArray(step.package_access_paths) ||
        step.is_valid !== true
      ) {
        throw new Error('Optimizer trả spatial step không hợp lệ');
      }
      for (const placed of step.placed_items) {
        if (!isRecord(placed) || typeof placed.item_id !== 'string') {
          throw new Error('Optimizer trả placement không hợp lệ');
        }
        for (const field of [
          'x',
          'y',
          'length_cm',
          'width_cm',
          'height_cm',
          'weight_kg',
        ]) {
          if (!isFiniteNumber(placed[field]) || Number(placed[field]) < 0) {
            throw new Error(`Optimizer trả placement.${field} không hợp lệ`);
          }
        }
      }
    }
    let previousDepartureSec = Number(route.start_time_sec);
    for (const stop of route.stops) {
      if (
        !isRecord(stop) ||
        !Number.isInteger(stop.sequence) ||
        typeof stop.location_id !== 'string' ||
        typeof stop.location_name !== 'string' ||
        !['PICKUP', 'DELIVERY'].includes(String(stop.stop_type)) ||
        typeof stop.order_id !== 'string' ||
        typeof stop.allocation_id !== 'string' ||
        typeof stop.order_stop_id !== 'string' ||
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
      for (const field of ['arrival_time_sec', 'departure_time_sec']) {
        if (!Number.isInteger(stop[field]) || Number(stop[field]) < 0) {
          throw new Error(`Optimizer trả stop.${field} không hợp lệ`);
        }
      }
      const breakdownFields = [
        stop.travel_time_sec,
        stop.waiting_time_sec,
        stop.service_time_sec,
      ];
      const breakdownFieldCount = breakdownFields.filter(
        (field) => field !== undefined,
      ).length;
      if (breakdownFieldCount !== 0 && breakdownFieldCount !== 3) {
        throw new Error('Optimizer trả thiếu trường phân rã thời gian chặng');
      }
      if (breakdownFieldCount === 3) {
        if (
          !breakdownFields.every(
            (field) => Number.isInteger(field) && Number(field) >= 0,
          )
        ) {
          throw new Error('Optimizer trả phân rã thời gian chặng không hợp lệ');
        }
        if (
          Number(stop.arrival_time_sec) - previousDepartureSec !==
            Number(stop.travel_time_sec) + Number(stop.waiting_time_sec) ||
          Number(stop.departure_time_sec) - Number(stop.arrival_time_sec) !==
            Number(stop.service_time_sec)
        ) {
          throw new Error(
            'Optimizer trả phân rã thời gian chặng không khớp mốc điểm dừng',
          );
        }
      }
      previousDepartureSec = Number(stop.departure_time_sec);
    }
    const returnBreakdownFields = [
      route.return_travel_time_sec,
      route.return_waiting_time_sec,
    ];
    const returnBreakdownFieldCount = returnBreakdownFields.filter(
      (field) => field !== undefined,
    ).length;
    if (returnBreakdownFieldCount !== 0 && returnBreakdownFieldCount !== 2) {
      throw new Error('Optimizer trả thiếu trường phân rã chặng về bến');
    }
    if (returnBreakdownFieldCount === 2) {
      if (
        !returnBreakdownFields.every(
          (field) => Number.isInteger(field) && Number(field) >= 0,
        ) ||
        Number(route.end_time_sec) - previousDepartureSec !==
          Number(route.return_travel_time_sec) +
            Number(route.return_waiting_time_sec)
      ) {
        throw new Error('Optimizer trả phân rã chặng về bến không hợp lệ');
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
      'late_delivery_penalty_vnd',
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
        'late_delivery_penalty_vnd',
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

export function assertFleetOptimizationBatchResult(
  value: unknown,
): asserts value is FleetOptimizationBatchResult {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.solver_run_count) ||
    Number(value.solver_run_count) < 1
  ) {
    throw new Error('Optimizer batch phải có solver_run_count hợp lệ (>= 1)');
  }
  if (
    !Number.isInteger(value.fully_served_candidate_count) ||
    Number(value.fully_served_candidate_count) < 0
  ) {
    throw new Error('Optimizer batch phải có fully_served_candidate_count hợp lệ (>= 0)');
  }
  if (typeof value.job_id !== 'string' || !Array.isArray(value.candidates)) {
    throw new Error('Optimizer batch thiếu job_id/candidates hợp lệ');
  }
  if (value.candidates.length < 1 || value.candidates.length > 10) {
    throw new Error('Optimizer batch phải có từ 1 đến 10 nghiệm');
  }

  let bestCount = 0;
  const ranks = new Set<number>();

  for (let index = 0; index < value.candidates.length; index += 1) {
    const candidate = value.candidates[index];
    if (
      !isRecord(candidate) ||
      !Number.isInteger(candidate.rank) ||
      Number(candidate.rank) < 1 ||
      typeof candidate.search_strategy !== 'string' ||
      !candidate.search_strategy.trim() ||
      !Number.isInteger(candidate.solver_objective) ||
      Number(candidate.solver_objective) < 0 ||
      typeof candidate.is_best_found !== 'boolean'
    ) {
      throw new Error('Metadata phương án tối ưu của optimizer không hợp lệ');
    }
    const rank = Number(candidate.rank);
    if (ranks.has(rank)) {
      throw new Error('Optimizer trả trùng thứ hạng phương án');
    }
    ranks.add(rank);
    if (rank !== index + 1) {
      throw new Error('Thứ hạng phương án (rank) phải liên tục bắt đầu từ 1');
    }
    if (candidate.is_best_found) bestCount += 1;
    assertFleetOptimizationResult(candidate.result);
    if (candidate.result.job_id !== value.job_id) {
      throw new Error('Optimizer batch chứa kết quả của job khác');
    }
  }

  if (bestCount !== 1 || value.candidates[0].is_best_found !== true) {
    throw new Error('Optimizer batch phải đặt đúng một nghiệm tốt nhất ở vị trí đầu (rank 1)');
  }

  // Nếu có từ 2 phương án trở lên thì tất cả các phương án phải giao đủ 100% đơn
  if (value.candidates.length >= 2) {
    for (const candidate of value.candidates) {
      if (
        candidate.result.status !== 'SUCCESS' ||
        candidate.result.unassigned_orders.length > 0
      ) {
        throw new Error(
          `Phương án rank #${candidate.rank} không giao đủ 100% đơn (${candidate.result.unassigned_orders.length} đơn chưa xếp); không được xuất hiện trong danh sách so sánh`,
        );
      }
    }
  }

  // Các phương án phải được xếp theo tổng chi phí vận hành tăng dần (hoặc bằng nhau)
  for (let index = 1; index < value.candidates.length; index += 1) {
    if (
      value.candidates[index].result.total_cost_vnd <
      value.candidates[index - 1].result.total_cost_vnd
    ) {
      throw new Error('Danh sách phương án chưa được sắp xếp theo tổng chi phí tăng dần');
    }
  }
}
