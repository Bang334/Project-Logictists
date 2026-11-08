import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DemoScenarioControlCard } from '../components/DemoScenarioControlCard';
import type { DemoCaseSummaryUI } from '../types';

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

const mockCases: DemoCaseSummaryUI[] = [
  {
    id: 'novel_1_mekong_hub_spoke',
    filename: 'novel_1_mekong_hub_spoke.json',
    name: 'Mê Kông 2 chiều (Star Topology)',
    category: 'NOVEL',
    category_name: 'Novel Nâng Cao',
    description: 'Tuyến mạng hình sao ĐBSCL',
    orders_count: 15,
    vehicles_count: 8,
    drivers_count: 8,
    total_weight_kg: 5000,
    total_volume_cbm: 12.5,
    suggested_time_limit_sec: 6.0,
  },
  {
    id: 'scenario_1_multi_item',
    filename: 'scenario_1_multi_item.json',
    name: 'Đa kiện hàng hóa',
    category: 'SCENARIO',
    category_name: 'Bài Toán Vận Tải Đặc Thù',
    description: 'Mỗi đơn nhiều kiện',
    orders_count: 10,
    vehicles_count: 6,
    drivers_count: 6,
    total_weight_kg: 3500,
    total_volume_cbm: 8.2,
    suggested_time_limit_sec: 5.0,
  },
];

describe('DemoScenarioControlCard', () => {
  it('hiển thị đúng tiêu đề, tóm tắt kịch bản và kích hoạt nút Chạy tối ưu Demo', () => {
    const handleRun = vi.fn();
    const handleSelect = vi.fn();

    render(
      <DemoScenarioControlCard
        stackingEnabled={true}
        onChangeStacking={vi.fn()}
        cases={mockCases}
        loadingCases={false}
        selectedCaseId="novel_1_mekong_hub_spoke"
        onSelectCaseId={handleSelect}
        timeBudgetSeconds={6}
        onChangeTimeBudget={vi.fn()}
        running={false}
        onRunDemo={handleRun}
        onClearDemo={vi.fn()}
        hasResult={false}
        isCustomUpload={false}
        onToggleCustomUpload={vi.fn()}
        onCustomJsonLoaded={vi.fn()}
      />,
    );

    expect(screen.getByText(/Thử Nghiệm Demo Kịch Bản Mẫu/)).toBeInTheDocument();
    expect(screen.getByText('Mê Kông 2 chiều (Star Topology)')).toBeInTheDocument();
    expect(screen.getByText('Tuyến mạng hình sao ĐBSCL')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();

    const runBtn = screen.getByRole('button', { name: /Chạy tối ưu Demo/i });
    expect(runBtn).toBeInTheDocument();
    fireEvent.click(runBtn);
    expect(handleRun).toHaveBeenCalledTimes(1);
  }, 15000);

  it('hiển thị thông báo khi có kết quả tối ưu demo', () => {
    const toggleStacking = vi.fn();
    render(
      <DemoScenarioControlCard
        stackingEnabled={true}
        onChangeStacking={toggleStacking}
        cases={mockCases.map(c => ({ ...c, supports_stacking: c.id === 'novel_1_mekong_hub_spoke' }))}
        loadingCases={false}
        selectedCaseId="novel_1_mekong_hub_spoke"
        onSelectCaseId={vi.fn()}
        timeBudgetSeconds={6}
        onChangeTimeBudget={vi.fn()}
        running={false}
        onRunDemo={vi.fn()}
        onClearDemo={vi.fn()}
        hasResult={true}
        isCustomUpload={false}
        onToggleCustomUpload={vi.fn()}
        onCustomJsonLoaded={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Đang hiển thị kết quả từ Chế độ Demo (Benchmark)'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Chế độ xếp chồng theo khách hàng', { selector: 'input' })).toBeInTheDocument();
    expect(screen.getByText('Chỉ kiện cùng khách hàng')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Cho phép xếp chồng demo'));
    expect(toggleStacking).toHaveBeenCalledWith(false);
  });
});
