import {
  isFloorRotationLocked,
  normalizeAllowedOrientations,
  parseAllowedOrientationsInput,
} from './package-orientations';
import { validateOrderInput } from './order-contract';
import { packagesToCargoUnits } from '../trips/optimizer-payload';

describe('package-orientations & Part A payload mapping', () => {
  it('treats null, undefined, ["DEFAULT"], and ["LWH", "WLH"] as unlocked floor rotation', () => {
    expect(parseAllowedOrientationsInput(null)).toBeNull();
    expect(parseAllowedOrientationsInput(undefined)).toBeNull();
    expect(parseAllowedOrientationsInput(['DEFAULT'])).toBeNull();
    expect(parseAllowedOrientationsInput(['LWH', 'WLH'])).toEqual(['LWH', 'WLH']);
    expect(parseAllowedOrientationsInput(['lwh'])).toEqual(['LWH']);

    expect(isFloorRotationLocked(null)).toBe(false);
    expect(isFloorRotationLocked(['DEFAULT'])).toBe(false);
    expect(isFloorRotationLocked(['LWH', 'WLH'])).toBe(false);
    expect(isFloorRotationLocked(['LWH'])).toBe(true);
    expect(normalizeAllowedOrientations(['DEFAULT', 'LWH'])).toEqual(['LWH']);
  });

  it('rejects empty or invalid allowedOrientations values', () => {
    expect(() => parseAllowedOrientationsInput([])).toThrow();
    expect(() => parseAllowedOrientationsInput(['XYZ'])).toThrow();
    expect(() => parseAllowedOrientationsInput('LWH')).toThrow();
  });

  it('validates allowedOrientations in validateOrderInput for STANDARD and FRAGILE', () => {
    const baseInput = (allowedOrientations?: string[] | null) => ({
      branchId: 'b1',
      customerId: 'c1',
      stops: [
        {
          type: 'PICKUP' as const,
          address: 'Kho A',
          contactName: 'A',
          contactPhone: '0901234567',
          latitude: 10.77,
          longitude: 106.69,
          serviceDurationMinutes: 15,
        },
        {
          type: 'DELIVERY' as const,
          address: 'Kho B',
          contactName: 'B',
          contactPhone: '0901234568',
          latitude: 10.78,
          longitude: 106.7,
          serviceDurationMinutes: 15,
          windowStart: '2026-11-15T08:00:00Z',
          windowEnd: '2026-11-15T10:00:00Z',
        },
      ],
      items: [
        {
          description: 'Kien de vo khoa huong',
          packageType: 'THUNG',
          packages: [
            {
              lengthMm: 1000,
              widthMm: 600,
              heightMm: 500,
              weightG: '15000',
              cargoKind: 'FRAGILE' as const,
              allowedOrientations,
            },
          ],
        },
      ],
    });

    expect(() => validateOrderInput(baseInput(['LWH']), false)).not.toThrow();
    expect(() => validateOrderInput(baseInput(null), false)).not.toThrow();
    expect(() => validateOrderInput(baseInput(['INVALID']), false)).toThrow();
  });

  it('maps PhysicalPackageLine allowedOrientations into OptimizerCargoUnit can_rotate & allowed_orientations', () => {
    const units = packagesToCargoUnits([
      {
        id: 'item-1',
        orderId: 'order-1',
        description: 'Hang khoa xoay va hang tu do',
        quantity: 3,
        packages: [
          {
            id: 'pkg-locked',
            orderItemId: 'item-1',
            lengthMm: 1000,
            widthMm: 600,
            heightMm: 500,
            weightG: 40000n,
            cargoKind: 'FRAGILE',
            allowedOrientations: ['LWH'],
          },
          {
            id: 'pkg-default',
            orderItemId: 'item-1',
            lengthMm: 1000,
            widthMm: 600,
            heightMm: 500,
            weightG: 40000n,
            cargoKind: 'STANDARD',
            allowedOrientations: ['DEFAULT'],
          },
          {
            id: 'pkg-both',
            orderItemId: 'item-1',
            lengthMm: 1000,
            widthMm: 600,
            heightMm: 500,
            weightG: 40000n,
            cargoKind: 'STANDARD',
            allowedOrientations: ['LWH', 'WLH'],
          },
        ],
      },
    ]);

    expect(units[0].can_rotate).toBe(false);
    expect(units[0].allowed_orientations).toEqual(['LWH']);
    expect(units[0].cargo_kind).toBe('FRAGILE');

    expect(units[1].can_rotate).toBe(true);
    expect(units[1].allowed_orientations).toBeUndefined();

    expect(units[2].can_rotate).toBe(true);
    expect(units[2].allowed_orientations).toEqual(['LWH', 'WLH']);
  });
});
