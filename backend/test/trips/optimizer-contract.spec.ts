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
      stops: [],
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
  unassigned_orders: [] as any[],
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

describe('assertFleetOptimizationResult', () => {
  it('accepts the load-sensitive cost contract', () => {
    expect(() => assertFleetOptimizationResult(validResult())).not.toThrow();
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

  it('rejects candidates not sorted by total cost ascending', () => {
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

    expect(() => assertFleetOptimizationBatchResult(batch)).toThrow(
      'chưa được sắp xếp theo tổng chi phí tăng dần',
    );
  });
});
