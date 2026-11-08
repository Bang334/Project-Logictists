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

describe('buildNetworkMarkers', () => {
  it('maps branches to DEPOT markers for Mapbox', () => {
    expect(buildNetworkMarkers([branchA, branchB]).map((marker) => marker.type)).toEqual([
      'DEPOT',
      'DEPOT',
    ]);
  });

  it('does not put invalid coordinates on Mapbox', () => {
    const invalid = { ...branchA, id: 'invalid', latitude: 200 };
    expect(buildNetworkMarkers([invalid, branchB])).toHaveLength(1);
  });
});

describe('buildNetworkPointItems & filterNetworkPointItems', () => {
  it('builds network items for operational transport branches', () => {
    const items = buildNetworkPointItems([branchA, branchB]);
    expect(items.map((item) => item.typeLabel)).toEqual([
      'Chi nhánh',
      'Chi nhánh',
    ]);
    expect(items[0].vehicleCount).toBe(6);
    expect(items[0].driverCount).toBe(8);
  });

  it('filters branches by search query', () => {
    const items = buildNetworkPointItems([branchA, branchB]);
    expect(filterNetworkPointItems(items, 'ALL', '')).toHaveLength(2);
    expect(filterNetworkPointItems(items, 'ALL', 'Hải Phòng')).toHaveLength(1);
    expect(filterNetworkPointItems(items, 'ALL', 'HAN')).toHaveLength(1);
    expect(filterNetworkPointItems(items, 'ALL', 'Sài Gòn')).toHaveLength(0);
  });
});

describe('scopeDashboardEntities', () => {
  it('returns all entities when company scope (branchId is undefined)', () => {
    const scoped = scopeDashboardEntities({
      branches: [branchA, branchB],
      locations: [],
      trips: [],
      branchId: undefined,
    });
    expect(scoped.scopedBranches).toHaveLength(2);
  });

  it('restricts entities to selected branch when branchId is set', () => {
    const scoped = scopeDashboardEntities({
      branches: [branchA, branchB],
      locations: [],
      trips: [],
      branchId: 'branch-1',
    });
    expect(scoped.scopedBranches).toHaveLength(1);
    expect(scoped.scopedBranches[0].code).toBe('HAN');
  });
});

describe('computeDashboardKpis', () => {
  it('computes multi-tier breakdown and percentages safely without division by zero', () => {
    const vehicles: Vehicle[] = [
      { id: 'v1', plateNumber: '29H-1', model: '5T', status: 'AVAILABLE' } as any,
      { id: 'v2', plateNumber: '29H-2', model: '8T', status: 'ON_TRIP' } as any,
    ];
    const drivers: Driver[] = [
      { id: 'd1', fullName: 'Driver A', status: 'AVAILABLE' } as any,
      { id: 'd2', fullName: 'Driver B', status: 'ON_DUTY' } as any,
      { id: 'd3', fullName: 'Driver C', status: 'RESTING' } as any,
    ];
    const trips: Trip[] = [
      { id: 't1', status: 'IN_PROGRESS' } as any,
      { id: 't2', status: 'PLANNED' } as any,
      { id: 't3', status: 'COMPLETED' } as any,
    ];

    const kpis = computeDashboardKpis(vehicles, drivers, 12, trips);
    expect(kpis.vehicles.total).toBe(2);
    expect(kpis.vehicles.available).toBe(1);
    expect(kpis.vehicles.onTrip).toBe(1);
    expect(kpis.vehicles.availablePercent).toBe(50);

    expect(kpis.drivers.total).toBe(3);
    expect(kpis.drivers.available).toBe(1);
    expect(kpis.drivers.onDuty).toBe(1);
    expect(kpis.drivers.restingOrLeave).toBe(1);
    expect(kpis.drivers.availablePercent).toBe(33);

    expect(kpis.orders.pendingCount).toBe(12);

    expect(kpis.trips.total).toBe(3);
    expect(kpis.trips.active).toBe(1);
    expect(kpis.trips.planned).toBe(1);
    expect(kpis.trips.completed).toBe(1);
  });
});

describe('filterDashboardTrips & getTripStatusPresentation & formatTripWindow', () => {
  it('filters trips by status correctly', () => {
    const trips: Trip[] = [
      { id: 't1', status: 'IN_PROGRESS' } as any,
      { id: 't2', status: 'PLANNED' } as any,
      { id: 't3', status: 'COMPLETED' } as any,
    ];
    expect(filterDashboardTrips(trips, 'ALL')).toHaveLength(3);
    expect(filterDashboardTrips(trips, 'ACTIVE')).toHaveLength(1);
    expect(filterDashboardTrips(trips, 'PLANNED')).toHaveLength(1);
    expect(filterDashboardTrips(trips, 'COMPLETED')).toHaveLength(1);
  });

  it('translates status to standard Vietnamese labels', () => {
    expect(getTripStatusPresentation('IN_PROGRESS').label).toBe('Đang vận chuyển');
    expect(getTripStatusPresentation('DISPATCHED').label).toBe('Đã điều lệnh');
    expect(getTripStatusPresentation('COMPLETED').label).toBe('Hoàn thành');
  });

  it('formats trip window safely with duration', () => {
    const res = formatTripWindow('2026-11-08T08:00:00.000Z', '2026-11-08T11:30:00.000Z', 210);
    expect(res.durationLabel).toBe('210 phút');
    expect(res.timeRange).toContain('→');
  });
});
