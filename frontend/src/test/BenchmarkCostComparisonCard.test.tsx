import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BenchmarkCostComparisonCard } from '../components/BenchmarkCostComparisonCard';
import type { BenchmarkComparisonUI } from '../types';

const metric = {
  method_name: 'test',
  description: 'test',
  total_cost_vnd: 100,
  total_distance_km: 10,
  total_duration_minutes: 20,
  vehicles_used: 2,
  fuel_cost_vnd: 20,
  vehicle_fixed_cost_vnd: 20,
  driver_cost_vnd: 20,
  cargo_holding_cost_vnd: 20,
  late_delivery_penalty_vnd: 0,
  violations: [],
};

const benchmarks: BenchmarkComparisonUI = {
  or_tools: { ...metric, is_feasible: false },
  direct_dedicated: { ...metric, total_cost_vnd: 200, is_feasible: true },
  savings_vs_direct_vnd: 100,
  savings_vs_direct_percent: 50,
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(cleanup);

describe('BenchmarkCostComparisonCard', () => {
  it('hiển thị PARTIAL là phương án một phần và không quảng bá tiết kiệm', () => {
    render(
      <BenchmarkCostComparisonCard
        benchmarks={benchmarks}
        optimizationStatus="PARTIAL"
        unassignedOrderCount={2}
      />,
    );

    expect(screen.getByText('Phương án một phần (còn 2 đơn)')).toBeInTheDocument();
    expect(screen.getByText('Không so sánh chi phí khi còn đơn chưa xếp')).toBeInTheDocument();
    expect(screen.queryByText(/Tiết kiệm 50/)).not.toBeInTheDocument();
  });

  it('vẫn hiển thị không hợp lệ cho lỗi không phải PARTIAL', () => {
    render(
      <BenchmarkCostComparisonCard
        benchmarks={benchmarks}
        optimizationStatus="INFEASIBLE"
        unassignedOrderCount={2}
      />,
    );

    expect(screen.getByText('Không hợp lệ')).toBeInTheDocument();
  });
});
