export type FloorOrientation = 'LWH' | 'WLH';

const VALID_FLOOR_ORIENTATIONS = new Set<string>(['LWH', 'WLH']);

/**
 * Validate client/API `allowedOrientations` input strictly while preserving
 * backwards compatibility with legacy `['DEFAULT']` markers as unlocked (`null`).
 */
export function parseAllowedOrientationsInput(
  input: unknown,
): FloorOrientation[] | null {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Array.isArray(input)) {
    throw new Error('allowedOrientations phải là mảng gồm LWH/WLH hoặc null');
  }
  if (input.length === 0) {
    throw new Error('allowedOrientations không được rỗng; dùng null nếu cho phép xoay');
  }

  const normalized: FloorOrientation[] = [];
  let sawDefault = false;

  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new Error('Phần tử trong allowedOrientations phải là chuỗi');
    }
    const token = raw.trim().toUpperCase();
    if (token === 'DEFAULT') {
      sawDefault = true;
      continue;
    }
    if (!VALID_FLOOR_ORIENTATIONS.has(token)) {
      throw new Error(`Hướng đặt hàng không hợp lệ: ${raw}. Chỉ chấp nhận LWH hoặc WLH`);
    }
    const orientation = token as FloorOrientation;
    if (!normalized.includes(orientation)) {
      normalized.push(orientation);
    }
  }

  if (normalized.length === 0) {
    return sawDefault ? null : null;
  }
  return normalized;
}

/**
 * Safely read persisted `Prisma.JsonValue` or unknown orientation lists from DB records.
 */
export function normalizeAllowedOrientations(
  value: unknown,
): FloorOrientation[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: FloorOrientation[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const token = raw.trim().toUpperCase();
    if (token === 'LWH' || token === 'WLH') {
      if (!normalized.includes(token)) {
        normalized.push(token);
      }
    }
  }
  return normalized.length > 0 ? normalized : null;
}

/**
 * Returns true when floor 90-degree rotation is explicitly locked (`['LWH']` without `'WLH'`).
 * Null, empty, `['DEFAULT']`, or `['LWH', 'WLH']` preserve D11 floor rotation (`can_rotate = true`).
 */
export function isFloorRotationLocked(value: unknown): boolean {
  const normalized = normalizeAllowedOrientations(value);
  return (
    normalized !== null &&
    normalized.includes('LWH') &&
    !normalized.includes('WLH')
  );
}
