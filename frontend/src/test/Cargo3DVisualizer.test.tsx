import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Cargo3DVisualizer from '../components/Cargo3DVisualizer';
import type { PlacedItemUI } from '../types';
import {
  buildSortedBoxes3D,
  CAMERA_3D_PRESETS,
  createProjectionContext,
} from '../utils/cargo3d';

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

const stackedItems: PlacedItemUI[] = [
  {
    item_id: 'KIEN-A',
    order_id: 'ord-1',
    x: 0,
    y: 0,
    z: 0,
    support_item_id: null,
    length_cm: 100,
    width_cm: 100,
    height_cm: 30,
    weight_kg: 100,
  },
  {
    item_id: 'KIEN-B',
    order_id: 'ord-1',
    x: 0,
    y: 0,
    z: 30,
    support_item_id: 'KIEN-A',
    length_cm: 100,
    width_cm: 100,
    height_cm: 30,
    weight_kg: 20,
  },
  {
    item_id: 'KIEN-C',
    order_id: 'ord-1',
    x: 0,
    y: 0,
    z: 60,
    support_item_id: 'KIEN-B',
    length_cm: 100,
    width_cm: 100,
    height_cm: 30,
    weight_kg: 5,
  },
];

describe('cargo3d projection and sorting', () => {
  it('draws lower tiers before upper tiers in iso camera', () => {
    const ctx = createProjectionContext(
      { lengthCm: 200, widthCm: 100, heightCm: 150 },
      CAMERA_3D_PRESETS.iso.camera,
      860,
      420,
    );
    const sorted = buildSortedBoxes3D(stackedItems, ctx, 0);
    expect(sorted.map((b) => b.item.item_id)).toEqual(['KIEN-A', 'KIEN-B', 'KIEN-C']);
    expect(sorted.map((b) => b.tierIndex)).toEqual([1, 2, 3]);
  });

  it('draws cabin-side cargo before rear-door cargo in rear camera view', () => {
    const frontAndBack: PlacedItemUI[] = [
      { ...stackedItems[0], item_id: 'CABIN-BOX', x: 0 },
      { ...stackedItems[0], item_id: 'DOOR-BOX', x: 100 },
    ];
    const ctx = createProjectionContext(
      { lengthCm: 200, widthCm: 100, heightCm: 150 },
      CAMERA_3D_PRESETS.rear.camera,
      860,
      420,
    );
    const sorted = buildSortedBoxes3D(frontAndBack, ctx, 0);
    expect(sorted.map((b) => b.item.item_id)).toEqual(['CABIN-BOX', 'DOOR-BOX']);
  });
});

describe('Cargo3DVisualizer', () => {
  it('renders all stacked tiers, presets, tier filters, and triggers selection callbacks', () => {
    const onSelect = vi.fn();
    render(
      <Cargo3DVisualizer
        lengthCm={200}
        widthCm={100}
        heightCm={150}
        items={stackedItems}
        showingUnload={true}
        nextUnloadId="KIEN-C"
        getItemColor={() => ({ bg: '#2563eb', border: '#1d4ed8' })}
        getItemShortLabel={(item) => item.item_id}
        isPathToDoorClear={(item) => item.item_id === 'KIEN-C'}
        onSelectItem={onSelect}
      />,
    );

    expect(screen.getByTestId('cargo-3d-visualizer')).toBeInTheDocument();
    expect(screen.getByText('Thùng: 200×100×150 cm')).toBeInTheDocument();
    expect(screen.getByText('3 tầng · Cao đỉnh 90 cm')).toBeInTheDocument();
    expect(screen.getByText('KIEN-A · T1')).toBeInTheDocument();
    expect(screen.getByText('KIEN-B · T2')).toBeInTheDocument();
    expect(screen.getByText('KIEN-C · T3')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Nhìn ngang X-Z'));
    fireEvent.click(screen.getByText('Cửa sau Y-Z'));
    fireEvent.click(screen.getByText('KIEN-B · T2'));
    expect(onSelect).toHaveBeenCalledWith('KIEN-B');
  });

  it('renders Part A center-of-gravity HUD, 3D CG marker, and focused handling badges', () => {
    const partAItems: PlacedItemUI[] = [
      {
        ...stackedItems[0],
        item_id: 'KIEN-FRAGILE',
        x: 50,
        y: 0,
        z: 0,
        length_cm: 100,
        width_cm: 100,
        weight_kg: 50,
        cargo_kind: 'FRAGILE',
        no_top_load_requested: true,
        floor_rotation_locked: true,
      },
    ];

    render(
      <Cargo3DVisualizer
        lengthCm={200}
        widthCm={100}
        heightCm={150}
        items={partAItems}
        selectedItemId="KIEN-FRAGILE"
        getItemColor={() => ({ bg: '#2563eb', border: '#1d4ed8' })}
        getItemShortLabel={(item) => item.item_id}
        isPathToDoorClear={() => true}
      />,
    );

    expect(screen.getByTestId('cargo-3d-cg')).toBeInTheDocument();
    expect(screen.getByText(/Trọng tâm:/)).toBeInTheDocument();
    expect(screen.getByText('Dễ vỡ')).toBeInTheDocument();
    expect(screen.getByText('Cấm đè')).toBeInTheDocument();
    expect(screen.getByText('Khóa xoay 90°')).toBeInTheDocument();
  });
});
