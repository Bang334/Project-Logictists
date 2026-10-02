import { describe, expect, it } from 'vitest';
import type { Branch, Location } from '../types';
import { buildNetworkMarkers } from '../utils/dashboardMap';

const branch = {
  id: 'branch-1', code: 'HAN', name: 'Kho Hà Nội', address: 'Hà Nội',
  latitude: 21.02, longitude: 105.84, timezone: 'Asia/Ho_Chi_Minh',
} satisfies Branch;

const locations = [
  { id: 'warehouse', code: 'WH-1', name: 'Kho trung tâm', type: 'CENTRAL_WAREHOUSE', address: 'Hà Nội', latitude: 21.03, longitude: 105.85, totalHoldingSlots: 0, availableHoldingSlots: 0 },
  { id: 'pickup', code: 'PP-1', name: 'Điểm nhận', type: 'PICKUP_POINT', address: 'Hà Nội', latitude: 21.04, longitude: 105.86, totalHoldingSlots: 20, availableHoldingSlots: 18 },
  { id: 'store', code: 'ST-1', name: 'Cửa hàng', type: 'STORE', address: 'Hà Nội', latitude: 21.05, longitude: 105.87, totalHoldingSlots: 10, availableHoldingSlots: 10 },
] satisfies Location[];

describe('buildNetworkMarkers', () => {
  it('maps branches, warehouses, pickup points and stores to distinct marker types', () => {
    expect(buildNetworkMarkers([branch], locations).map((marker) => marker.type)).toEqual([
      'DEPOT', 'WAREHOUSE', 'PICKUP_POINT', 'STORE',
    ]);
  });

  it('does not put invalid coordinates on Mapbox', () => {
    const invalid = { ...locations[0], id: 'invalid', latitude: 200 };
    expect(buildNetworkMarkers([branch], [invalid])).toHaveLength(1);
  });
});
