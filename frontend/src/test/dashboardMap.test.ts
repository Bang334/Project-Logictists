import { describe, expect, it } from 'vitest';
import type { Branch, Driver, Location, Trip, Vehicle } from '../types';
import {
  buildNetworkMarkers,
  buildNetworkPointItems,
  computeDashboardKpis,
  filterDashboardTrips,
  filterNetworkPointItems,
  formatTripWindow,
  getTripStatusPresentation,
  scopeDashboardEntities,
} from '../utils/dashboardMap';

const branchA = {
  id: 'branch-1',
  code: 'HAN',
  name: 'Chi nhánh Hà Nội',
  address: 'Số 18 Phạm Hùng, Hà Nội',
  latitude: 21.02,
  longitude: 105.84,
  timezone: 'Asia/Ho_Chi_Minh',
  _count: { vehicles: 6, drivers: 8 },
} satisfies Branch;

const branchB = {
  id: 'branch-2',
  code: 'HPG',
  name: 'Chi nhánh Hải Phòng',
  address: 'Lê Hồng Phong, Hải Phòng',
  latitude: 20.84,
  longitude: 106.68,
  timezone: 'Asia/Ho_Chi_Minh',
  _count: { vehicles: 3, drivers: 4 },
} satisfies Branch;

const locations = [
  {
    id: 'warehouse',
    code: 'WH-1',
    name: 'Kho trung tâm Long Biên',
    type: 'CENTRAL_WAREHOUSE',
    managingBranchId: 'branch-1',
    address: 'Long Biên, Hà Nội',
    latitude: 21.03,
    longitude: 105.85,
    totalHoldingSlots: 0,
    availableHoldingSlots: 0,
  },
  {
    id: 'pickup',
    code: 'PP-1',
    name: 'Điểm nhận Cầu Giấy',
    type: 'PICKUP_POINT',
    managingBranchId: 'branch-1',
    address: '85 Xuân Thủy, Hà Nội',
    latitude: 21.04,
    longitude: 105.86,
    totalHoldingSlots: 20,
    availableHoldingSlots: 18,
  },
  {
    id: 'store',
    code: 'ST-1',
    name: 'Cửa hàng Ngô Quyền',
    type: 'STORE',
    managingBranchId: 'branch-2',
    address: 'Ngô Quyền, Hải Phòng',
    latitude: 20.85,
    longitude: 106.69,
    totalHoldingSlots: 10,
    availableHoldingSlots: 10,
  },
] satisfies Location[];

describe('buildNetworkMarkers', () => {
  it('maps branches, warehouses, pickup points and stores to distinct marker types', () => {
    expect(buildNetworkMarkers([branchA], locations).map((marker) => marker.type)).toEqual([
      'DEPOT',
      'WAREHOUSE',
      'PICKUP_POINT',
      'STORE',
    ]);
  });

  it('does not put invalid coordinates on Mapbox', () => {
    const invalid = { ...locations[0], id: 'invalid', latitude: 200 };
    expect(buildNetworkMarkers([branchA], [invalid])).toHaveLength(1);
  });
});

describe('buildNetworkPointItems & filterNetworkPointItems', () => {
  it('keeps distinct domain labels between Branch (Chi nhánh) and Warehouse (Kho trung tâm)', () => {
    const items = buildNetworkPointItems([branchA], locations);
    expect(items.map((item) => item.typeLabel)).toEqual([
      'Chi nhánh',
      'Kho trung tâm',
      'Điểm nhận',
      'Cửa hàng',
    ]);
  });

  it('filters network points by type and search query', () => {
    const items = buildNetworkPointItems([branchA, branchB], locations);
    expect(filterNetworkPointItems(items, 'DEPOT', '')).toHaveLength(2);
    expect(filterNetworkPointItems(items, 'PICKUP_POINT', '')).toHaveLength(1);
    expect(filterNetworkPointItems(items, 'ALL', 'xuân thủy')).toHaveLength(1);
    expect(filterNetworkPointItems(items, 'STORE', 'hà nội')).toHaveLength(0);
  });
});

describe('scopeDashboardEntities', () => {
  it('filters branches and managed locations when a specific branchId is active', () => {
    const scoped = scopeDashboardEntities({
      branches: [branchA, branchB],
      locations,
      trips: [],
      branchId: 'branch-1',
    });
    expect(scoped.scopedBranches.map((b) => b.id)).toEqual(['branch-1']);
    expect(scoped.scopedLocations.map((l) => l.id)).toEqual(['warehouse', 'pickup']);
  });
});

describe('computeDashboardKpis & trip helpers', () => {
  const sampleVehicles = [
    { status: 'AVAILABLE' },
    { status: 'ON_TRIP' },
    { status: 'MAINTENANCE' },
  ] as Vehicle[];

  const sampleDrivers = [
    { status: 'AVAILABLE' },
    { status: 'AVAILABLE' },
    { status: 'ON_DUTY' },
    { status: 'RESTING' },
  ] as Driver[];

  const sampleTrips = [
    { id: 't1', status: 'IN_PROGRESS' },
    { id: 't2', status: 'DISPATCHED' },
    { id: 't3', status: 'PLANNED' },
    { id: 't4', status: 'COMPLETED' },
  ] as Trip[];

  it('computes multi-tier KPI breakdown accurately', () => {
    const summary = computeDashboardKpis(sampleVehicles, sampleDrivers, 9, sampleTrips);
    expect(summary.vehicles).toEqual({
      total: 3,
      available: 1,
      onTrip: 1,
      maintenance: 1,
      decommissioned: 0,
      availablePercent: 33,
    });
    expect(summary.drivers).toEqual({
      total: 4,
      available: 2,
      onDuty: 1,
      restingOrLeave: 1,
      availablePercent: 50,
    });
    expect(summary.orders.pendingCount).toBe(9);
    expect(summary.trips).toEqual({
      total: 4,
      active: 2,
      planned: 1,
      completed: 1,
      cancelled: 0,
      activePercent: 50,
    });
  });

  it('filters trips by status category and formats Vietnamese status labels', () => {
    expect(filterDashboardTrips(sampleTrips, 'ACTIVE')).toHaveLength(2);
    expect(filterDashboardTrips(sampleTrips, 'PLANNED')).toHaveLength(1);
    expect(filterDashboardTrips(sampleTrips, 'COMPLETED')).toHaveLength(1);
    expect(getTripStatusPresentation('IN_PROGRESS')).toEqual({
      label: 'Đang vận chuyển',
      color: 'blue',
    });
    expect(formatTripWindow('2026-11-08T01:00:00.000Z', '2026-11-08T04:30:00.000Z', 210).durationLabel).toBe(
      '210 phút',
    );
  });
});
