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

  it('hiển thị lý do thiếu xe và ẩn chi phí Direct khi đội xe không đủ', () => {
    const reason = 'Cần 14 xe thực để chạy từng đơn riêng, hiện chỉ có 3 xe trong đợt.';
    render(<BenchmarkCostComparisonCard benchmarks={{
      ...benchmarks,
      or_tools: { ...metric, is_feasible: true },
      direct_dedicated: {
        ...metric, total_cost_vnd: 0, vehicles_used: 0, is_feasible: false,
        violations: [`INSUFFICIENT_VEHICLES:${reason}`],
      },
    }} />);

    expect(screen.getByText(reason, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('0 lượt')).not.toBeInTheDocument();
    expect(screen.queryByText(/Tiết kiệm .* so với Direct/)).not.toBeInTheDocument();
  });

  it('gom thông tin Điểm xếp hạng và lương tài xế chờ lịch trực tiếp vào thẻ đối chuẩn chi phí ở trên', () => {
    const feasibleBenchmarks: BenchmarkComparisonUI = {
      or_tools: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 15_837_428,
        vehicles_used: 4,
      },
      direct_dedicated: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 24_687_268,
        vehicles_used: 14,
      },
      savings_vs_direct_vnd: 8_849_840,
      savings_vs_direct_percent: 35.85,
    };

    render(
      <BenchmarkCostComparisonCard
        benchmarks={feasibleBenchmarks}
        optimizationStatus="SUCCESS"
        unassignedOrderCount={0}
        planningObjective={{
          planning_span_days: 2,
          driver_calendar_salary_vnd: 4_850_000,
          driver_idle_salary_allocation_vnd: 3_038_186,
          operational_late_penalty_vnd: 0,
          selection_score_vnd: 18_875_614,
          physical_vehicle_count: 3,
          active_route_count: 4,
        }}
      />,
    );

    expect(screen.getByText('Tổng chi phí toàn đội (Điểm xếp hạng)')).toBeInTheDocument();
    expect(screen.getByText(/18\.875\.614/)).toBeInTheDocument();
    expect(screen.getByText(/Chi phí vận hành 4 chuyến:/)).toBeInTheDocument();
    expect(screen.getByText(/15\.837\.428/)).toBeInTheDocument();
    expect(screen.getByText(/\+ Lương cứng tài xế chờ lịch \(2 ngày\):/)).toBeInTheDocument();
    expect(screen.getByText(/\+3\.038\.186/)).toBeInTheDocument();
    expect(screen.getByText(/Hoàn tất trong 2 ngày \(4 chuyến \/ 3 xe\)/)).toBeInTheDocument();
    expect(screen.getByText(/Tiết kiệm 23\.54% so với Direct hợp lệ/)).toBeInTheDocument();
  });

  it('so sánh 2 bên khi Chuyến Đơn Lẻ chạy luân phiên nhiều xe qua nhiều ngày', () => {
    const multiDayDirectBenchmarks: BenchmarkComparisonUI = {
      or_tools: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 15_837_428,
        vehicles_used: 4,
        planning_span_days: 2,
        physical_vehicle_count: 3,
        driver_calendar_salary_vnd: 4_850_000,
        driver_idle_salary_allocation_vnd: 3_038_186,
        selection_score_vnd: 18_875_614,
      },
      direct_dedicated: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 21_620_562,
        vehicles_used: 14,
        planning_span_days: 5,
        physical_vehicle_count: 3,
        driver_calendar_salary_vnd: 12_272_725,
        driver_idle_salary_allocation_vnd: 9_851_788,
        selection_score_vnd: 31_472_350,
      },
      savings_vs_direct_vnd: 5_783_134,
      savings_vs_direct_percent: 26.75,
    };

    render(
      <BenchmarkCostComparisonCard
        benchmarks={multiDayDirectBenchmarks}
        optimizationStatus="SUCCESS"
        unassignedOrderCount={0}
      />,
    );

    expect(screen.getAllByText('Tổng chi phí toàn đội (Điểm xếp hạng)')).toHaveLength(2);
    expect(screen.getByText(/18\.875\.614/)).toBeInTheDocument();
    expect(screen.getByText(/31\.472\.350/)).toBeInTheDocument();
    expect(screen.getByText(/Hoàn tất trong 2 ngày \(4 chuyến \/ 3 xe\)/)).toBeInTheDocument();
    expect(screen.getByText(/Hoàn tất trong 5 ngày \(14 chuyến \/ 3 xe\)/)).toBeInTheDocument();
    expect(screen.getByText(/\+ Lương cứng tài xế chờ lịch \(5 ngày\):/)).toBeInTheDocument();
    expect(screen.getByText(/\+9\.851\.788/)).toBeInTheDocument();
    expect(screen.getByText(/Tiết kiệm 40\.02% so với Direct hợp lệ/)).toBeInTheDocument();
  });
});
