import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FloorPackingVisualizer from '../components/FloorPackingVisualizer';
import type { FloorStepStateUI, PlacedItemUI } from '../types';
import { getStepIndexForDistance } from '../utils/geoSimulation';

vi.mock('../components/MapboxMap', () => ({ MAP_ROUTE_COLORS: ['#2563eb'] }));

const base: PlacedItemUI = {
  item_id: 'base', order_id: 'order', x: 0, y: 0, z: 0,
  length_cm: 25, width_cm: 20, height_cm: 20, weight_kg: 20,
};
const top: PlacedItemUI = { ...base, item_id: 'top', z: 20, support_item_id: base.item_id, weight_kg: 5 };
const pickup: FloorStepStateUI = {
  step_index: 1, stop_id: 'pickup', stop_type: 'PICKUP', action_description: 'Nhận kiện',
  placed_items: [base, top], current_weight_kg: 25, current_occupied_area_cm2: 500,
  floor_area_cm2: 80_000, weight_utilization_percent: 1, area_utilization_percent: 0.625, is_valid: true,
};
const delivery: FloorStepStateUI = {
  ...pickup, step_index: 2, stop_id: 'delivery', stop_type: 'DELIVERY', action_description: 'Giao kiện',
  placed_items: [], current_weight_kg: 0, current_occupied_area_cm2: 0,
  weight_utilization_percent: 0, area_utilization_percent: 0, unload_sequence: [top.item_id, base.item_id],
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('defaults to the post-stop plan and can replay the validated top-first unload sequence', () => {
  const props = {
    stepStates: [pickup, delivery], isValid: true, selectedStepIndex: 2,
    vehicleDimensions: { lengthCm: 400, widthCm: 200 },
  };
  const { rerender } = render(<FloorPackingVisualizer {...props} />);
  expect(screen.getByText('Xếp chồng demo')).toBeInTheDocument();
  expect(screen.getByText('Còn 0 kiện trên xe')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Xem dỡ từ đầu'));
  expect(screen.getByText('Còn 2 kiện trên xe')).toBeInTheDocument();
  expect(screen.getByText('Tiến độ dỡ mô phỏng')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Dỡ kiện tiếp theo'));
  expect(screen.getByText('Còn 1 kiện trên xe')).toBeInTheDocument();
  expect(screen.getByText('20', { selector: 'div' })).toBeInTheDocument();
  fireEvent.click(screen.getByText('Dỡ kiện tiếp theo'));
  expect(screen.getByText('Còn 0 kiện trên xe')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Xem dỡ từ đầu'));
  rerender(<FloorPackingVisualizer {...props} isSimulating />);
  expect(screen.getByText('Còn 0 kiện trên xe')).toBeInTheDocument();
  expect(screen.queryByText('Dỡ kiện tiếp theo')).not.toBeInTheDocument();
  expect(screen.getByText('Chiếu').closest('button')).toBeDisabled();
}, 20_000);

it('keeps pre-stop cargo until the truck reaches a nearby stop', () => {
  expect(getStepIndexForDistance([0.1, 0.14], 0)).toBe(0);
  expect(getStepIndexForDistance([0.1, 0.14], 0.1)).toBe(1);
  expect(getStepIndexForDistance([0.1, 0.14], 0.14)).toBe(2);
});

it('defaults stacked plans to 3D container view, shows vehicle height, and toggles cleanly to 2D', () => {
  render(
    <FloorPackingVisualizer
      stepStates={[pickup, delivery]}
      isValid={true}
      selectedStepIndex={2}
      vehicleDimensions={{ lengthCm: 400, widthCm: 200, heightCm: 150 }}
    />,
  );

  expect(screen.getByText('400 × 200 × 150 cm')).toBeInTheDocument();
  expect(screen.getByTestId('cargo-3d-visualizer')).toBeInTheDocument();
  expect(screen.queryByLabelText('Sơ đồ kiện trong thùng xe')).not.toBeInTheDocument();

  fireEvent.click(screen.getByText('2D Mặt sàn'));
  expect(screen.queryByTestId('cargo-3d-visualizer')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Sơ đồ kiện trong thùng xe')).toBeInTheDocument();
});

it('shows the 2D unload exit path during unload replay and advances with auto-unload playback', () => {
  vi.useFakeTimers();
  try {
    render(
      <FloorPackingVisualizer
        stepStates={[pickup, delivery]}
        isValid={true}
        selectedStepIndex={2}
        vehicleDimensions={{ lengthCm: 400, widthCm: 200, heightCm: 150 }}
      />,
    );

    fireEvent.click(screen.getByText('2D Mặt sàn'));
    fireEvent.click(screen.getByText('Xem dỡ từ đầu'));
    expect(screen.getByText('ĐƯỜNG RA 2D')).toBeInTheDocument();
    expect(screen.queryByText('KHÔNG CÓ ĐƯỜNG 2D')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Phát dỡ tự động'));
    expect(screen.getByText('Tạm dừng dỡ')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1150);
    });
    expect(screen.getByText('Còn 1 kiện trên xe')).toBeInTheDocument();
    expect(screen.getByText('ĐƯỜNG RA 2D')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1150);
    });
    expect(screen.getByText('Còn 0 kiện trên xe')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('displays weight balance, CG marker, Part A badges, updates balance on unload, and locks rotation for LWH-only items', () => {
  const lockedFragile: PlacedItemUI = {
    item_id: 'LOCKED-BOX',
    order_id: 'order-a',
    x: 160,
    y: 0,
    z: 0,
    length_cm: 80,
    width_cm: 40,
    height_cm: 40,
    weight_kg: 100,
    cargo_kind: 'FRAGILE',
    no_top_load_requested: true,
    floor_rotation_locked: true,
  };
  const centeredUnlocked: PlacedItemUI = {
    item_id: 'CENTERED',
    order_id: 'order-b',
    x: 160,
    y: 80,
    z: 0,
    length_cm: 80,
    width_cm: 40,
    height_cm: 40,
    weight_kg: 20,
    cargo_kind: 'STANDARD',
    floor_rotation_locked: false,
  };

  const pickupImbalanced: FloorStepStateUI = {
    step_index: 1,
    stop_id: 'pickup-imbalanced',
    stop_type: 'PICKUP',
    action_description: 'Nhận 2 kiện',
    placed_items: [lockedFragile, centeredUnlocked],
    current_weight_kg: 120,
    current_occupied_area_cm2: 6400,
    floor_area_cm2: 80_000,
    weight_utilization_percent: 12,
    area_utilization_percent: 8,
    is_valid: true,
  };
  const deliveryAfterUnload: FloorStepStateUI = {
    ...pickupImbalanced,
    step_index: 2,
    stop_id: 'delivery-after',
    stop_type: 'DELIVERY',
    action_description: 'Giao kiện dễ vỡ trước',
    placed_items: [],
    current_weight_kg: 0,
    current_occupied_area_cm2: 0,
    weight_utilization_percent: 0,
    area_utilization_percent: 0,
    unload_sequence: ['LOCKED-BOX', 'CENTERED'],
  };

  const { container, rerender } = render(
    <FloorPackingVisualizer
      stepStates={[pickupImbalanced, deliveryAfterUnload]}
      isValid={true}
      selectedStepIndex={1}
      vehicleDimensions={{ lengthCm: 400, widthCm: 200, heightCm: 150 }}
    />,
  );

  expect(screen.getByTestId('floor-weight-balance-bar')).toHaveTextContent('Lệch tải cao');
  expect(screen.getByTestId('floor-2d-cg')).toBeInTheDocument();

  screen.getAllByText('Xem kiện con').forEach((btn) => fireEvent.click(btn));
  expect(screen.getByText('Dễ vỡ')).toBeInTheDocument();
  expect(screen.getByText('Cấm đè')).toBeInTheDocument();
  expect(screen.getByText('Khóa xoay')).toBeInTheDocument();

  fireEvent.click(screen.getByText('Di chuyển hàng thủ công'));
  const lockedRotateBtn = container.querySelector('button[aria-label="Xoay 90° LOCKED-BOX"]');
  const unlockedRotateBtn = container.querySelector('button[aria-label="Xoay 90° CENTERED"]');
  expect(lockedRotateBtn).toBeInstanceOf(HTMLButtonElement);
  expect(lockedRotateBtn).toBeDisabled();
  expect(unlockedRotateBtn).toBeInstanceOf(HTMLButtonElement);
  expect(unlockedRotateBtn).not.toBeDisabled();

  fireEvent.click(screen.getByText('Thoát di chuyển'));
  rerender(
    <FloorPackingVisualizer
      stepStates={[pickupImbalanced, deliveryAfterUnload]}
      isValid={true}
      selectedStepIndex={2}
      vehicleDimensions={{ lengthCm: 400, widthCm: 200, heightCm: 150 }}
    />,
  );

  fireEvent.click(screen.getByText('Xem dỡ từ đầu'));
  expect(screen.getByTestId('floor-weight-balance-bar')).toHaveTextContent('Lệch tải cao');

  fireEvent.click(screen.getByText('Dỡ kiện tiếp theo'));
  expect(screen.getByTestId('floor-weight-balance-bar')).toHaveTextContent('Cân bằng tốt');
}, 20_000);
