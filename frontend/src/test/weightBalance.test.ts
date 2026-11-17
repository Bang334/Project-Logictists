import { describe, expect, it } from 'vitest';
import {
  computeWeightBalance,
  getWeightBalanceMeta,
  isFloorRotationLocked,
} from '../utils/weightBalance';

describe('weightBalance utilities', () => {
  it('detects floor rotation lock only when LWH is allowed without WLH', () => {
    expect(isFloorRotationLocked(null)).toBe(false);
    expect(isFloorRotationLocked(undefined)).toBe(false);
    expect(isFloorRotationLocked([])).toBe(false);
    expect(isFloorRotationLocked(['DEFAULT'])).toBe(false);
    expect(isFloorRotationLocked(['LWH', 'WLH'])).toBe(false);
    expect(isFloorRotationLocked(['WLH'])).toBe(false);

    expect(isFloorRotationLocked(['LWH'])).toBe(true);
    expect(isFloorRotationLocked(['lwh'])).toBe(true);
    expect(isFloorRotationLocked(['LWH', 'DEFAULT'])).toBe(true);
  });

  it('returns EMPTY balance at floor center when no positive-weight items are placed', () => {
    const empty = computeWeightBalance([], 400, 200);
    expect(empty).toEqual({
      total_weight_kg: 0,
      cg_x_cm: 200,
      cg_y_cm: 100,
      cg_x_percent: 50,
      cg_y_percent: 50,
      lateral_offset_cm: 0,
      longitudinal_offset_cm: 0,
      lateral_imbalance_percent: 0,
      longitudinal_imbalance_percent: 0,
      left_weight_kg: 0,
      right_weight_kg: 0,
      front_weight_kg: 0,
      rear_weight_kg: 0,
      status: 'EMPTY',
    });
  });

  it('computes symmetric BALANCED CG and equal quadrant weights', () => {
    const result = computeWeightBalance(
      [
        { x: 50, y: 10, length_cm: 100, width_cm: 60, weight_kg: 120 },
        { x: 250, y: 130, length_cm: 100, width_cm: 60, weight_kg: 120 },
      ],
      400,
      200,
    );

    expect(result.total_weight_kg).toBe(240);
    expect(result.cg_x_cm).toBe(200);
    expect(result.cg_y_cm).toBe(100);
    expect(result.cg_x_percent).toBe(50);
    expect(result.cg_y_percent).toBe(50);
    expect(result.lateral_imbalance_percent).toBe(0);
    expect(result.longitudinal_imbalance_percent).toBe(0);
    expect(result.left_weight_kg).toBe(120);
    expect(result.right_weight_kg).toBe(120);
    expect(result.front_weight_kg).toBe(120);
    expect(result.rear_weight_kg).toBe(120);
    expect(result.status).toBe('BALANCED');
  });

  it('classifies MODERATE lateral shift vs IMBALANCED lateral and longitudinal shifts', () => {
    const moderateLat = computeWeightBalance(
      [{ x: 180, y: 52, length_cm: 40, width_cm: 40, weight_kg: 100 }],
      400,
      200,
    );
    expect(moderateLat.lateral_offset_cm).toBe(-28);
    expect(moderateLat.lateral_imbalance_percent).toBe(28);
    expect(moderateLat.status).toBe('MODERATE');

    const imbalancedLat = computeWeightBalance(
      [{ x: 180, y: 0, length_cm: 40, width_cm: 40, weight_kg: 100 }],
      400,
      200,
    );
    expect(imbalancedLat.lateral_imbalance_percent).toBe(80);
    expect(imbalancedLat.status).toBe('IMBALANCED');

    const imbalancedLongBoundary = computeWeightBalance(
      [{ x: 70, y: 80, length_cm: 40, width_cm: 40, weight_kg: 100 }],
      400,
      200,
    );
    expect(imbalancedLongBoundary.longitudinal_imbalance_percent).toBe(55);
    expect(imbalancedLongBoundary.status).toBe('IMBALANCED');
  });

  it('splits straddling items proportionally across front/rear and left/right halves', () => {
    const straddle = computeWeightBalance(
      [{ x: 180, y: 20, length_cm: 100, width_cm: 100, weight_kg: 100 }],
      400,
      200,
    );
    expect(straddle.front_weight_kg).toBe(20);
    expect(straddle.rear_weight_kg).toBe(80);
    expect(straddle.left_weight_kg).toBe(80);
    expect(straddle.right_weight_kg).toBe(20);
  });

  it('maps each WeightBalanceStatus to badge metadata', () => {
    expect(getWeightBalanceMeta('EMPTY')).toEqual({
      label: 'Chưa có hàng',
      tagColor: 'default',
      strokeColor: '#94a3b8',
    });
    expect(getWeightBalanceMeta('BALANCED')).toEqual({
      label: 'Cân bằng tốt',
      tagColor: 'success',
      strokeColor: '#16a34a',
    });
    expect(getWeightBalanceMeta('MODERATE')).toEqual({
      label: 'Lệch tải nhẹ',
      tagColor: 'warning',
      strokeColor: '#d97706',
    });
    expect(getWeightBalanceMeta('IMBALANCED')).toEqual({
      label: 'Lệch tải cao',
      tagColor: 'error',
      strokeColor: '#dc2626',
    });
  });
});
