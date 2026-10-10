import { ConflictException } from '@nestjs/common';

export type Placement = { packageId: string; xMm: number; yMm: number; zMm: number; effectiveLengthMm: number; effectiveWidthMm: number; effectiveHeightMm: number };
export function placementGeometry(p: Placement) {
  return { packageId: p.packageId, xMm: p.xMm, yMm: p.yMm, zMm: p.zMm, effectiveLengthMm: p.effectiveLengthMm, effectiveWidthMm: p.effectiveWidthMm, effectiveHeightMm: p.effectiveHeightMm };
}
export function pickupConflict(code: string, message: string): never {
  throw new ConflictException({ code, message });
}
// Conservative execution check of a FIXED validated placement, never a new layout.
// A rear-door straight translation is sufficient proof when clear. More complex
// paths require the planner's per-operation contract; do not invent a load order.
export function assertFixedLoadingPath(target: Placement, onboard: Placement[], dimensions: { lengthCm: number; widthCm: number; heightCm: number }) {
  if (target.zMm !== 0 || target.xMm < 0 || target.yMm < 0 ||
      target.effectiveLengthMm <= 0 || target.effectiveWidthMm <= 0 || target.effectiveHeightMm <= 0 ||
      target.xMm + target.effectiveLengthMm > dimensions.lengthCm * 10 ||
      target.yMm + target.effectiveWidthMm > dimensions.widthCm * 10 ||
      target.effectiveHeightMm > dimensions.heightCm * 10) {
    pickupConflict('INVALID_LOAD_PLAN', 'Vị trí xếp hàng không hợp lệ');
  }
  if (onboard.some(other => other.xMm + other.effectiveLengthMm > target.xMm &&
    other.yMm < target.yMm + target.effectiveWidthMm && other.yMm + other.effectiveWidthMm > target.yMm)) {
    pickupConflict('LOADING_PATH_BLOCKED', 'Đường xếp thẳng qua cửa sau bị kiện đã lấy cản. Không di chuyển kiện khác; liên hệ điều phối để kiểm tra phương án thao tác.');
  }
}
