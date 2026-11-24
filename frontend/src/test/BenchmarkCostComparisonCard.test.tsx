import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BenchmarkCostComparisonCard } from '../components/BenchmarkCostComparisonCard';
import type { BenchmarkComparisonUI, OptimizationCandidateSummaryUI } from '../types';

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

  it('mở rộng bảng phân rã chi tiết cho tất cả 4 phương án (#1, #2, #3 và Chuyến đơn lẻ)', () => {
    const fourPlanBenchmarks: BenchmarkComparisonUI = {
      or_tools: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 47_590_879,
        fuel_cost_vnd: 21_466_310,
        vehicle_fixed_cost_vnd: 2_550_000,
        driver_cost_vnd: 22_529_295,
        cargo_holding_cost_vnd: 1_045_274,
        late_delivery_penalty_vnd: 0,
        vehicles_used: 26,
        planning_span_days: 2,
        physical_vehicle_count: 19,
        driver_calendar_salary_vnd: 28_513_650,
        driver_idle_salary_allocation_vnd: 16_201_979,
        selection_score_vnd: 63_792_858,
      },
      direct_dedicated: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 89_760_987,
        fuel_cost_vnd: 31_044_938,
        vehicle_fixed_cost_vnd: 15_000_000,
        driver_cost_vnd: 42_811_535,
        cargo_holding_cost_vnd: 904_514,
        late_delivery_penalty_vnd: 0,
        vehicles_used: 150,
        planning_span_days: 2,
        physical_vehicle_count: 18,
        driver_calendar_salary_vnd: 28_513_650,
        driver_idle_salary_allocation_vnd: 12_480_046,
        selection_score_vnd: 102_241_033,
      },
      savings_vs_direct_vnd: 42_170_108,
      savings_vs_direct_percent: 46.98,
    };

    const candidates: OptimizationCandidateSummaryUI[] = [
      {
        candidateNumber: 1,
        rank: 1,
        searchStrategy: 'Packing-aware Hybrid ALNS (seed 2)',
        improvementSequence: 1,
        solverObjective: 63_792_858,
        planningSpanDays: 2,
        driverCalendarSalaryVnd: 28_513_650,
        driverIdleSalaryAllocationVnd: 16_201_979,
        operationalLatePenaltyVnd: 0,
        isBestFound: true,
        feasibilityStatus: 'FEASIBLE',
        totalCostVnd: 47_590_879,
        totalDistanceKm: 7610.32,
        totalDurationMinutes: 13020,
        routeCount: 26,
        unassignedOrderCount: 0,
        costBreakdown: {
          fuelCostVnd: 21_466_310,
          vehicleFixedCostVnd: 2_550_000,
          driverCostVnd: 22_529_295,
          cargoHoldingCostVnd: 1_045_274,
          lateDeliveryPenaltyVnd: 0,
        },
      },
      {
        candidateNumber: 2,
        rank: 2,
        searchStrategy: 'Packing-aware Hybrid ALNS (seed 7)',
        improvementSequence: 2,
        solverObjective: 64_303_021,
        planningSpanDays: 2,
        driverCalendarSalaryVnd: 28_513_650,
        driverIdleSalaryAllocationVnd: 16_116_278,
        operationalLatePenaltyVnd: 0,
        isBestFound: false,
        feasibilityStatus: 'FEASIBLE',
        totalCostVnd: 48_186_743,
        totalDistanceKm: 7693.82,
        totalDurationMinutes: 13110.5,
        routeCount: 27,
        unassignedOrderCount: 0,
        costBreakdown: {
          fuelCostVnd: 21_700_000,
          vehicleFixedCostVnd: 2_650_000,
          driverCostVnd: 22_750_000,
          cargoHoldingCostVnd: 1_086_743,
          lateDeliveryPenaltyVnd: 0,
        },
      },
      {
        candidateNumber: 3,
        rank: 3,
        searchStrategy: 'Packing-aware Hybrid ALNS (seed 6)',
        improvementSequence: 3,
        solverObjective: 66_880_500,
        planningSpanDays: 3,
        driverCalendarSalaryVnd: 42_000_000,
        driverIdleSalaryAllocationVnd: 15_657_321,
        operationalLatePenaltyVnd: 0,
        isBestFound: false,
        feasibilityStatus: 'FEASIBLE',
        totalCostVnd: 51_223_179,
        totalDistanceKm: 8112.76,
        totalDurationMinutes: 13480.9,
        routeCount: 28,
        unassignedOrderCount: 0,
        costBreakdown: {
          fuelCostVnd: 23_000_000,
          vehicleFixedCostVnd: 2_800_000,
          driverCostVnd: 24_200_000,
          cargoHoldingCostVnd: 1_223_179,
          lateDeliveryPenaltyVnd: 0,
        },
      },
    ];

    render(
      <BenchmarkCostComparisonCard
        benchmarks={fourPlanBenchmarks}
        optimizationStatus="SUCCESS"
        unassignedOrderCount={0}
        candidates={candidates}
        selectedCandidateNumber={2}
        displayedCandidateNumber={2}
      />,
    );

    // Thẻ đối chuẩn phía trên phản ánh đúng phương án #2 đang xem thay vì gắn nhãn tối ưu nhất
    expect(screen.getByText('Phương án #2 đang chọn')).toBeInTheDocument();

    const toggle = screen.getByText('▼ Xem chi tiết phân rã chi phí (4 phương án)');
    fireEvent.click(toggle);

    const table = screen.getByRole('table');
    const thead = table.querySelector('thead')!;
    expect(within(thead).getByText('Packing-aware Hybrid ALNS (seed 2)')).toBeInTheDocument();
    expect(within(thead).getByText('Packing-aware Hybrid ALNS (seed 7)')).toBeInTheDocument();
    expect(within(thead).getByText('Packing-aware Hybrid ALNS (seed 6)')).toBeInTheDocument();
    expect(within(thead).getByText('Chuyến đơn lẻ (Direct Dedicated)')).toBeInTheDocument();
    expect(within(thead).getByText('Đang xem')).toBeInTheDocument();

    // Kiểm tra chi tiết từng khoản mục cho cả #1, #2, #3 và Direct theo đúng dòng và cột
    const fuelRow = table.querySelector<HTMLTableRowElement>('tr[data-row-key="fuel"]')!;
    expect(fuelRow.cells).toHaveLength(5);
    expect(fuelRow.cells[1]).toHaveTextContent(/21\.466\.310/);
    expect(fuelRow.cells[2]).toHaveTextContent(/21\.700\.000/);
    expect(fuelRow.cells[3]).toHaveTextContent(/23\.000\.000/);
    expect(fuelRow.cells[4]).toHaveTextContent(/31\.044\.938/);

    const idleRow = table.querySelector<HTMLTableRowElement>('tr[data-row-key="idle-driver-salary"]')!;
    expect(idleRow.cells[3]).toHaveTextContent('3 ngày');

    const totalRow = table.querySelector<HTMLTableRowElement>('tr[data-row-key="total"]')!;
    expect(totalRow.cells[1]).toHaveTextContent(/63\.792\.858/);
    expect(totalRow.cells[1]).toHaveTextContent('Thấp nhất');
    expect(totalRow.cells[2]).toHaveTextContent(/\+510\.163/);
    expect(totalRow.cells[3]).toHaveTextContent(/\+3\.087\.642/);
    expect(totalRow.cells[4]).toHaveTextContent(/\+38\.448\.175/);
  });

  it('hiển thị dấu gạch ngang khi phương án cũ thiếu phân rã chi phí hoặc Direct không hợp lệ', () => {
    const partialBreakdownBenchmarks: BenchmarkComparisonUI = {
      or_tools: {
        ...metric,
        is_feasible: true,
        total_cost_vnd: 15_000_000,
      },
      direct_dedicated: {
        ...metric,
        is_feasible: false,
        total_cost_vnd: 0,
        vehicles_used: 0,
        violations: ['INSUFFICIENT_VEHICLES:Thiếu xe'],
      },
      savings_vs_direct_vnd: null,
      savings_vs_direct_percent: null,
    };

    const candidates: OptimizationCandidateSummaryUI[] = [
      {
        candidateNumber: 1,
        searchStrategy: 'Seed 1',
        improvementSequence: 1,
        solverObjective: 15_000_000,
        planningSpanDays: 1,
        driverCalendarSalaryVnd: 0,
        driverIdleSalaryAllocationVnd: 0,
        operationalLatePenaltyVnd: 0,
        isBestFound: true,
        feasibilityStatus: 'FEASIBLE',
        totalCostVnd: 15_000_000,
        totalDistanceKm: 100,
        totalDurationMinutes: 200,
        routeCount: 2,
        unassignedOrderCount: 0,
        costBreakdown: {
          fuelCostVnd: 5_000_000,
          vehicleFixedCostVnd: 3_000_000,
          driverCostVnd: 6_000_000,
          cargoHoldingCostVnd: 1_000_000,
          lateDeliveryPenaltyVnd: 0,
        },
      },
      {
        candidateNumber: 2,
        searchStrategy: 'Seed 2 (legacy)',
        improvementSequence: 2,
        solverObjective: 16_000_000,
        planningSpanDays: 1,
        driverCalendarSalaryVnd: 0,
        driverIdleSalaryAllocationVnd: 0,
        operationalLatePenaltyVnd: 0,
        isBestFound: false,
        feasibilityStatus: 'FEASIBLE',
        totalCostVnd: 16_000_000,
        totalDistanceKm: 110,
        totalDurationMinutes: 210,
        routeCount: 2,
        unassignedOrderCount: 0,
      },
    ];

    render(
      <BenchmarkCostComparisonCard
        benchmarks={partialBreakdownBenchmarks}
        optimizationStatus="SUCCESS"
        unassignedOrderCount={0}
        candidates={candidates}
        selectedCandidateNumber={1}
      />,
    );

    fireEvent.click(screen.getByText('▼ Xem chi tiết phân rã chi phí (3 phương án)'));
    const table = screen.getByRole('table');
    const fuelRow = table.querySelector<HTMLTableRowElement>('tr[data-row-key="fuel"]')!;
    expect(fuelRow.cells[1]).toHaveTextContent(/^5\.000\.000/);
    expect(fuelRow.cells[2]).toHaveTextContent('—');
    expect(fuelRow.cells[3]).toHaveTextContent('—');

    const totalRow = table.querySelector<HTMLTableRowElement>('tr[data-row-key="total"]')!;
    expect(totalRow.cells[1]).toHaveTextContent(/^15\.000\.000/);
    expect(totalRow.cells[2]).toHaveTextContent(/^16\.000\.000/);
    expect(totalRow.cells[3]).toHaveTextContent('—');
  });
});
