import { assertFleetOptimizationResult } from './optimizer-contract';

const validResult = () => ({
  job_id: 'job-1',
  status: 'SUCCESS',
  routes: [
    {
      vehicle_id: 'vehicle-1',
      stops: [],
      spatial_validation: { is_valid: true },
      cost: {
        base_fuel_cost_vnd: 100,
        load_fuel_surcharge_vnd: 20,
        fuel_cost_vnd: 120,
        cargo_holding_cost_vnd: 30,
        cargo_distance_ton_km: 2.5,
        cargo_time_ton_hours: 0.75,
        vehicle_fixed_cost_vnd: 50,
        driver_fixed_salary_allocation_vnd: 40,
        driver_trip_pay_vnd: 60,
        total_cost_vnd: 300,
      },
    },
  ],
  unassigned_orders: [],
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
