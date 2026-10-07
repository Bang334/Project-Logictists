import { describe, expect, it } from 'vitest';
import {
  parseFinancialSummary,
  parseOccupancyRows,
} from '../utils/retailAnalytics';

describe('retail analytics API normalization', () => {
  it('wraps the singular occupancy contract in a table-safe array', () => {
    expect(parseOccupancyRows({
      locationId: 'location-1',
      totalSlots: 20,
      occupiedSlots: 3,
      availableSlots: 17,
      occupancyRate: 15,
    })).toEqual([{
      locationId: 'location-1',
      totalSlots: 20,
      occupiedSlots: 3,
      availableSlots: 17,
      occupancyRate: 15,
    }]);
  });

  it('accepts a future multi-location occupancy response', () => {
    expect(parseOccupancyRows([
      { locationId: 'a', totalSlots: 10, occupiedSlots: 1, availableSlots: 9, occupancyRate: 10 },
      { locationId: 'b', totalSlots: 20, occupiedSlots: 4, availableSlots: 16, occupancyRate: 20 },
    ])).toHaveLength(2);
  });

  it('rejects malformed occupancy data instead of crashing inside Ant Design', () => {
    expect(() => parseOccupancyRows({ locationId: 'location-1' })).toThrow(
      'occupancy.totalSlots phải là số hữu hạn',
    );
  });

  it('normalizes decimal strings returned by Prisma', () => {
    expect(parseFinancialSummary({
      orderCount: 2,
      grossSales: '150000.50',
      payments: '100000',
      refunds: '5000',
      netRevenue: '95000',
    })).toEqual({
      orderCount: 2,
      grossSales: 150000.5,
      payments: 100000,
      refunds: 5000,
      netRevenue: 95000,
    });
  });
});
