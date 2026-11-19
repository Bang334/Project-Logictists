import {
  assertFleetOptimizationBatchResult,
  assertFleetOptimizationResult,
} from '../../src/trips/optimizer-contract';

const validResult = () => ({
  job_id: 'job-1',
  status: 'SUCCESS',
  routes: [
    {
      route_id: 'vehicle-1::day:0',
      vehicle_id: 'vehicle-1',
      service_day_index: 0,
      start_time_sec: 28800,
      end_time_sec: 30000,
      plate_number: '51C-000.01',
      vehicle_length_cm: 430,
      vehicle_width_cm: 190,
      total_distance_km: 10,
      total_duration_minutes: 20,
      stops: [] as Array<Record<string, unknown>>,
      spatial_validation: { is_valid: true, step_states: [] },
      cost: {
        base_fuel_cost_vnd: 100,
        load_fuel_surcharge_vnd: 20,
        fuel_cost_vnd: 120,
        cargo_holding_cost_vnd: 30,
        late_delivery_penalty_vnd: 0,
        cargo_distance_ton_km: 2.5,
        cargo_time_ton_hours: 0.75,
        vehicle_fixed_cost_vnd: 50,
        driver_fixed_salary_allocation_vnd: 40,
        driver_trip_pay_vnd: 60,
        total_cost_vnd: 300,
      },
    },
  ],
  unassigned_orders: [] as Array<Record<string, unknown>>,
  total_distance_km: 10,
  total_duration_minutes: 20,
  total_cost_vnd: 300,
  benchmarks: {
    or_tools: benchmarkMetric(true),
    direct_dedicated: benchmarkMetric(true),
    savings_vs_direct_vnd: 100,
    savings_vs_direct_percent: 25,
  },
  diagnostics: [],
});

function benchmarkMetric(isFeasible: boolean) {
  return {
    method_name: 'Benchmark',
    description: 'Benchmark test',
    total_cost_vnd: 400,
    total_distance_km: 10,
    total_duration_minutes: 20,
    vehicles_used: 1,
    fuel_cost_vnd: 100,
    vehicle_fixed_cost_vnd: 100,
    driver_cost_vnd: 100,
    cargo_holding_cost_vnd: 100,
    late_delivery_penalty_vnd: 0,
    is_feasible: isFeasible,
    violations: isFeasible ? [] : ['SPATIAL:Không hợp lệ'],
  };
}

function validStop() {
  return {
    sequence: 1,
    location_id: 'pickup-1',
    location_name: 'Kho nhận',
    stop_type: 'PICKUP',
    order_id: 'order-1',
    allocation_id: 'allocation-1',
    order_stop_id: 'order-stop-1',
    latitude: 16,
    longitude: 108,
    arrival_time_sec: 29_400,
    departure_time_sec: 30_000,
    travel_time_sec: 300,
    waiting_time_sec: 300,
    service_time_sec: 600,
    items_loaded: ['package-1'],
    items_unloaded: [] as string[],
    current_weight_kg: 100,
  };
}

describe('assertFleetOptimizationResult', () => {
  it('accepts the load-sensitive cost contract', () => {
    expect(() => assertFleetOptimizationResult(validResult())).not.toThrow();
  });

  it('validates Chuyến đơn lẻ routes when the benchmark includes them', () => {
    const result = validResult();
    const route = { ...result.routes[0], route_id: 'direct:vehicle-1', stops: [validStop()] };
    const direct = { ...result.benchmarks.direct_dedicated, routes: [route] };
    const response = { ...result, benchmarks: { ...result.benchmarks, direct_dedicated: direct } };

    expect(() => assertFleetOptimizationResult(response)).not.toThrow();
    route.spatial_validation = { ...route.spatial_validation, is_valid: false };
    expect(() => assertFleetOptimizationResult(response)).toThrow('spatial validator');
  });

  it('accepts a dedicated trip that ends at its delivery point', () => {
    const result = validResult();
    const end = { id: 'delivery', name: 'Điểm giao', longitude: 105, latitude: 21 };
    const route = { ...result.routes[0], route_id: 'direct:vehicle-1:order-1', end_location: end };
    const direct = { ...result.benchmarks.direct_dedicated, routes: [route] };
    const response = { ...result, benchmarks: { ...result.benchmarks, direct_dedicated: direct } };

    expect(() => assertFleetOptimizationResult(response)).not.toThrow();
    end.latitude = Number.NaN;
    expect(() => assertFleetOptimizationResult(response)).toThrow('điểm kết thúc tuyến');
  });

  it('accepts a consistent planning objective breakdown', () => {
    const result = {
      ...validResult(),
      planning_objective: {
        planning_span_days: 3,
        operating_cost_vnd: 300,
        driver_active_salary_allocation_vnd: 40,
        driver_calendar_salary_vnd: 100,
        driver_idle_salary_allocation_vnd: 60,
        operational_late_penalty_vnd: 25,
        selection_score_vnd: 385,
      },
    };

    expect(() => assertFleetOptimizationResult(result)).not.toThrow();
  });

  it('rejects an internally inconsistent planning objective breakdown', () => {
    const result = {
      ...validResult(),
      planning_objective: {
        planning_span_days: 3,
        operating_cost_vnd: 300,
        driver_active_salary_allocation_vnd: 40,
        driver_calendar_salary_vnd: 100,
        driver_idle_salary_allocation_vnd: 59,
        operational_late_penalty_vnd: 25,
        selection_score_vnd: 385,
      },
    };

    expect(() => assertFleetOptimizationResult(result)).toThrow(
      'breakdown lương tài xế không khớp',
    );
  });

  it('rejects a response that omits a load-sensitive cost field', () => {
    const result = validResult();
    delete (result.routes[0].cost as Partial<typeof result.routes[0]['cost']>)
      .load_fuel_surcharge_vnd;

    expect(() => assertFleetOptimizationResult(result)).toThrow(
      'load_fuel_surcharge_vnd',
    );
  });

  it('rejects a benchmark without an explicit feasibility verdict', () => {
    const result = validResult();
    delete (result.benchmarks.direct_dedicated as Partial<
      typeof result.benchmarks.direct_dedicated
    >).is_feasible;

    expect(() => assertFleetOptimizationResult(result)).toThrow(
      'is_feasible',
    );
  });

  it('accepts a stop whose travel, waiting and service durations match its timestamps', () => {
    const result = validResult();
    result.routes[0].stops = [validStop()];
    Object.assign(result.routes[0], {
      return_travel_time_sec: 0,
      return_waiting_time_sec: 0,
    });

    expect(() => assertFleetOptimizationResult(result)).not.toThrow();
  });

  it('accepts a historical stop that predates the leg breakdown fields', () => {
    const result = validResult();
    const stop = validStop();
    delete (stop as Partial<typeof stop>).travel_time_sec;
    delete (stop as Partial<typeof stop>).waiting_time_sec;
    delete (stop as Partial<typeof stop>).service_time_sec;
    result.routes[0].stops = [stop];

    expect(() => assertFleetOptimizationResult(result)).not.toThrow();
  });

  it('rejects a partial leg breakdown', () => {
    const result = validResult();
    const stop = validStop();
    delete (stop as Partial<typeof stop>).waiting_time_sec;
    result.routes[0].stops = [stop];

    expect(() => assertFleetOptimizationResult(result)).toThrow(
      'thiếu trường phân rã thời gian chặng',
    );
  });

  it('rejects a stop whose leg breakdown leaves an unexplained timeline gap', () => {
    const result = validResult();
    result.routes[0].stops = [{ ...validStop(), waiting_time_sec: 0 }];

    expect(() => assertFleetOptimizationResult(result)).toThrow(
      'phân rã thời gian chặng',
    );
  });

  it('accepts optional positive vehicle_height_cm and rejects non-positive height', () => {
    const valid = validResult();
    Object.assign(valid.routes[0], { vehicle_height_cm: 185 });
    expect(() => assertFleetOptimizationResult(valid)).not.toThrow();

    const zeroHeight = validResult();
    Object.assign(zeroHeight.routes[0], { vehicle_height_cm: 0 });
    expect(() => assertFleetOptimizationResult(zeroHeight)).toThrow(
      'route.vehicle_height_cm',
    );
  });
});

describe('assertFleetOptimizationBatchResult', () => {
  it('accepts a valid ranked batch of fully-served candidates', () => {
    const res1 = validResult();
    res1.total_cost_vnd = 1_000_000;
    const res2 = validResult();
    res2.total_cost_vnd = 1_200_000;

    const batch = {
      job_id: 'job-1',
      solver_run_count: 6,
      fully_served_candidate_count: 2,
      candidates: [
        {
          rank: 1,
          search_strategy: 'Chèn rẻ nhất song song + GLS',
          solver_objective: 80,
          is_best_found: true,
          result: res1,
        },
        {
          rank: 2,
          search_strategy: 'Chèn rẻ nhất cục bộ + GLS',
          solver_objective: 90,
          is_best_found: false,
          result: res2,
        },
      ],
    };

    expect(() => assertFleetOptimizationBatchResult(batch)).not.toThrow();
  });

  it('rejects a batch where a secondary candidate has unassigned orders', () => {
    const res1 = validResult();
    res1.total_cost_vnd = 1_000_000;
    const res2 = validResult();
    res2.total_cost_vnd = 1_200_000;
    res2.unassigned_orders = [
      {
        order_id: 'o-bad',
        order_number: 'ORD-BAD',
        reason_code: 'NO_FIT',
        reason_message: 'Không vừa',
      },
    ];

    const batch = {
      job_id: 'job-1',
      solver_run_count: 6,
      fully_served_candidate_count: 1,
      candidates: [
        {
          rank: 1,
          search_strategy: 'Strategy 1',
          solver_objective: 80,
          is_best_found: true,
          result: res1,
        },
        {
          rank: 2,
          search_strategy: 'Strategy 2',
          solver_objective: 90,
          is_best_found: false,
          result: res2,
        },
      ],
    };

    expect(() => assertFleetOptimizationBatchResult(batch)).toThrow(
      'không giao đủ 100% đơn',
    );
  });

  it('accepts higher operating cost when the shared planning objective is lower', () => {
    const res1 = validResult();
    res1.total_cost_vnd = 2_000_000;
    const res2 = validResult();
    res2.total_cost_vnd = 1_000_000;

    const batch = {
      job_id: 'job-1',
      solver_run_count: 6,
      fully_served_candidate_count: 2,
      candidates: [
        {
          rank: 1,
          search_strategy: 'Strategy 1',
          solver_objective: 80,
          is_best_found: true,
          result: res1,
        },
        {
          rank: 2,
          search_strategy: 'Strategy 2',
          solver_objective: 90,
          is_best_found: false,
          result: res2,
        },
      ],
    };

    expect(() => assertFleetOptimizationBatchResult(batch)).not.toThrow();
  });

  it('rejects candidates not sorted by the shared planning objective', () => {
    const res1 = validResult();
    const res2 = validResult();
    const batch = {
      job_id: 'job-1',
      solver_run_count: 6,
      fully_served_candidate_count: 2,
      candidates: [
        {
          rank: 1,
          search_strategy: 'Strategy 1',
          solver_objective: 90,
          is_best_found: true,
          result: res1,
        },
        {
          rank: 2,
          search_strategy: 'Strategy 2',
          solver_objective: 80,
          is_best_found: false,
          result: res2,
        },
      ],
    };

    expect(() => assertFleetOptimizationBatchResult(batch)).toThrow(
      'chưa được sắp xếp theo objective tăng dần',
    );
  });

  it('accepts lexicographic candidate ranking when extra_order_trips is lower despite higher solver_objective', () => {
    const res1 = {
      ...validResult(),
      planning_objective: {
        planning_span_days: 1,
        operating_cost_vnd: 300,
        driver_active_salary_allocation_vnd: 40,
        driver_calendar_salary_vnd: 240,
        driver_idle_salary_allocation_vnd: 200,
        operational_late_penalty_vnd: 0,
        selection_score_vnd: 500,
        extra_order_trips: 0,
        split_order_count: 0,
        active_route_count: 1,
        physical_vehicle_count: 1,
        delivery_visit_count: 1,
      },
    };
    const res2 = {
      ...validResult(),
      planning_objective: {
        planning_span_days: 1,
        operating_cost_vnd: 300,
        driver_active_salary_allocation_vnd: 40,
        driver_calendar_salary_vnd: 40,
        driver_idle_salary_allocation_vnd: 0,
        operational_late_penalty_vnd: 0,
        selection_score_vnd: 300,
        extra_order_trips: 1,
        split_order_count: 1,
        active_route_count: 2,
        physical_vehicle_count: 2,
        delivery_visit_count: 2,
      },
    };
    const batch = {
      job_id: 'job-1',
      solver_run_count: 2,
      fully_served_candidate_count: 2,
      candidates: [
        {
          rank: 1,
          search_strategy: 'Grouped',
          solver_objective: 500,
          is_best_found: true,
          result: res1,
        },
        {
          rank: 2,
          search_strategy: 'Split',
          solver_objective: 300,
          is_best_found: false,
          result: res2,
        },
      ],
    };

    expect(() => assertFleetOptimizationBatchResult(batch)).not.toThrow();
  });

  it('validates Part A weight_balance, max_lateral_imbalance_percent, and placement handling fields', () => {
    const result = validResult();
    const placed: Record<string, unknown> = {
      item_id: 'pkg-1',
      order_id: 'order-1',
      x: 0,
      y: 0,
      length_cm: 100,
      width_cm: 60,
      height_cm: 50,
      weight_kg: 100,
      cargo_kind: 'FRAGILE',
      no_top_load_requested: true,
      floor_rotation_locked: true,
    };
    const step: Record<string, unknown> = {
      step_index: 1,
      stop_id: 'stop-1',
      stop_type: 'PICKUP',
      action_description: 'Nhận kiện 1',
      placed_items: [placed],
      current_weight_kg: 100,
      current_occupied_area_cm2: 6000,
      floor_area_cm2: 20000,
      weight_utilization_percent: 10,
      area_utilization_percent: 30,
      is_valid: true,
      package_access_paths: [],
      weight_balance: {
        total_weight_kg: 100,
        cg_x_cm: 120,
        cg_y_cm: 95,
        cg_x_percent: 40,
        cg_y_percent: 47.5,
        lateral_offset_cm: -5,
        longitudinal_offset_cm: -30,
        lateral_imbalance_percent: 5,
        longitudinal_imbalance_percent: 20,
        left_weight_kg: 52.5,
        right_weight_kg: 47.5,
        front_weight_kg: 60,
        rear_weight_kg: 40,
        status: 'BALANCED',
      },
    };
    (result.routes[0].spatial_validation as Record<string, unknown>).max_lateral_imbalance_percent = 5;
    (result.routes[0].spatial_validation.step_states as Array<Record<string, unknown>>) = [step];

    expect(() => assertFleetOptimizationResult(result)).not.toThrow();

    (step.weight_balance as Record<string, unknown>).status = 'UNKNOWN_STATUS';
    expect(() => assertFleetOptimizationResult(result)).toThrow('weight_balance.status');

    (step.weight_balance as Record<string, unknown>).status = 'BALANCED';
    placed.cargo_kind = 'INVALID_KIND';
    expect(() => assertFleetOptimizationResult(result)).toThrow('cargo_kind');
  });
});

it('accepts an explicitly unknown lateral imbalance from the Python contract', () => {
  const result = validResult();
  Object.assign(result.routes[0].spatial_validation, { max_lateral_imbalance_percent: null });
  expect(() => assertFleetOptimizationResult(result)).not.toThrow();
});

it.each([-1, NaN, Infinity, 'unknown'])('rejects invalid lateral imbalance %s', value => {
  const result = validResult();
  Object.assign(result.routes[0].spatial_validation, { max_lateral_imbalance_percent: value });
  expect(() => assertFleetOptimizationResult(result)).toThrow('max_lateral_imbalance_percent');
});

it('accepts null when the optimizer omitted optional benchmark calculation', () => {
  const result = { ...validResult(), benchmarks: null };
  expect(() => assertFleetOptimizationResult(result)).not.toThrow();
});
