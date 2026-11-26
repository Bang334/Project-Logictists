export type FloorOrientation = 'LWH' | 'WLH';

export type WeightBalanceStatus = 'EMPTY' | 'BALANCED' | 'MODERATE' | 'IMBALANCED';

export interface WeightBalanceMetrics {
  total_weight_kg: number;
  cg_x_cm: number;
  cg_y_cm: number;
  cg_x_percent: number;
  cg_y_percent: number;
  lateral_offset_cm: number;
  longitudinal_offset_cm: number;
  lateral_imbalance_percent: number;
  longitudinal_imbalance_percent: number;
  left_weight_kg: number;
  right_weight_kg: number;
  front_weight_kg: number;
  rear_weight_kg: number;
  status: WeightBalanceStatus;
}

export interface SpatialWeightItem {
  x: number;
  y: number;
  length_cm: number;
  width_cm: number;
  weight_kg: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function isFloorRotationLocked(
  allowedOrientations?: readonly string[] | null,
): boolean {
  if (!Array.isArray(allowedOrientations)) return false;
  const tokens = allowedOrientations
    .map((entry) => String(entry).trim().toUpperCase())
    .filter((entry) => entry === 'LWH' || entry === 'WLH');
  return tokens.includes('LWH') && !tokens.includes('WLH');
}

export function computeWeightBalance(
  items: readonly SpatialWeightItem[],
  floorLengthCm: number,
  floorWidthCm: number,
): WeightBalanceMetrics {
  const safeL = floorLengthCm > 0 ? floorLengthCm : 1;
  const safeW = floorWidthCm > 0 ? floorWidthCm : 1;
  const halfX = safeL / 2;
  const halfY = safeW / 2;

  let totalWeight = 0;
  let momentX = 0;
  let momentY = 0;
  let leftWeight = 0;
  let rightWeight = 0;
  let frontWeight = 0;
  let rearWeight = 0;

  for (const item of items) {
    const wKg = Number(item.weight_kg);
    if (!Number.isFinite(wKg) || wKg <= 0) continue;
    const x0 = Number(item.x);
    const y0 = Number(item.y);
    const len = Math.max(0, Number(item.length_cm));
    const wid = Math.max(0, Number(item.width_cm));
    const cx = x0 + len / 2;
    const cy = y0 + wid / 2;

    totalWeight += wKg;
    momentX += wKg * cx;
    momentY += wKg * cy;

    if (len > 0) {
      const frontShare = Math.max(0, Math.min(halfX, x0 + len) - Math.max(0, x0)) / len;
      const clampedFront = Math.max(0, Math.min(1, frontShare));
      frontWeight += wKg * clampedFront;
      rearWeight += wKg * (1 - clampedFront);
    } else if (cx <= halfX) {
      frontWeight += wKg;
    } else {
      rearWeight += wKg;
    }

    if (wid > 0) {
      const leftShare = Math.max(0, Math.min(halfY, y0 + wid) - Math.max(0, y0)) / wid;
      const clampedLeft = Math.max(0, Math.min(1, leftShare));
      leftWeight += wKg * clampedLeft;
      rightWeight += wKg * (1 - clampedLeft);
    } else if (cy <= halfY) {
      leftWeight += wKg;
    } else {
      rightWeight += wKg;
    }
  }

  if (totalWeight <= 1e-6) {
    return {
      total_weight_kg: 0,
      cg_x_cm: round2(halfX),
      cg_y_cm: round2(halfY),
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
    };
  }

  const cgX = momentX / totalWeight;
  const cgY = momentY / totalWeight;
  const longOffset = cgX - halfX;
  const latOffset = cgY - halfY;
  const longImb = (Math.abs(longOffset) / halfX) * 100;
  const latImb = (Math.abs(latOffset) / halfY) * 100;

  let status: WeightBalanceStatus = 'BALANCED';
  if (latImb > 35 || longImb >= 55) {
    status = 'IMBALANCED';
  } else if (latImb > 20 || longImb > 35) {
    status = 'MODERATE';
  }

  return {
    total_weight_kg: round2(totalWeight),
    cg_x_cm: round2(cgX),
    cg_y_cm: round2(cgY),
    cg_x_percent: round2((cgX / safeL) * 100),
    cg_y_percent: round2((cgY / safeW) * 100),
    lateral_offset_cm: round2(latOffset),
    longitudinal_offset_cm: round2(longOffset),
    lateral_imbalance_percent: round2(latImb),
    longitudinal_imbalance_percent: round2(longImb),
    left_weight_kg: round2(leftWeight),
    right_weight_kg: round2(rightWeight),
    front_weight_kg: round2(frontWeight),
    rear_weight_kg: round2(rearWeight),
    status,
  };
}

export function getWeightBalanceMeta(status: WeightBalanceStatus): {
  label: string;
  tagColor: 'default' | 'success' | 'warning' | 'error';
  strokeColor: string;
} {
  switch (status) {
    case 'EMPTY':
      return { label: 'Chưa có hàng', tagColor: 'default', strokeColor: '#94a3b8' };
    case 'BALANCED':
      return { label: 'Cân bằng tốt', tagColor: 'success', strokeColor: '#16a34a' };
    case 'MODERATE':
      return { label: 'Lệch tải nhẹ', tagColor: 'warning', strokeColor: '#d97706' };
    case 'IMBALANCED':
      return { label: 'Lệch tải cao', tagColor: 'error', strokeColor: '#dc2626' };
  }
}
