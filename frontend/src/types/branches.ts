import type { Branch } from './index';
export interface ManagedBranch extends Branch { active: boolean; updatedAt: string }
export interface BranchInput { code: string; name: string; address: string; latitude: number; longitude: number; phone?: string }
export function parseManagedBranch(value: unknown): ManagedBranch {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string'
    || !('code' in value) || typeof value.code !== 'string' || !('name' in value) || typeof value.name !== 'string'
    || !('address' in value) || typeof value.address !== 'string' || !('latitude' in value) || typeof value.latitude !== 'number'
    || !('longitude' in value) || typeof value.longitude !== 'number' || !('active' in value) || typeof value.active !== 'boolean'
    || !('updatedAt' in value) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !('timezone' in value) || typeof value.timezone !== 'string') throw new Error('Phản hồi chi nhánh không hợp lệ');
  return { id: value.id, code: value.code, name: value.name, address: value.address, latitude: value.latitude, longitude: value.longitude, active: value.active, updatedAt: value.updatedAt, timezone: value.timezone,
    ...('phone' in value && typeof value.phone === 'string' ? { phone: value.phone } : {}),
    ...('deliveryGraceDays' in value && typeof value.deliveryGraceDays === 'number' ? { deliveryGraceDays: value.deliveryGraceDays } : {}),
    ...('lateDeliveryPenaltyValue' in value && typeof value.lateDeliveryPenaltyValue === 'string' ? { lateDeliveryPenaltyValue: value.lateDeliveryPenaltyValue } : {}),
    ...('lateDeliveryPenaltyMode' in value && (value.lateDeliveryPenaltyMode === 'NONE' || value.lateDeliveryPenaltyMode === 'FIXED_PER_DAY' || value.lateDeliveryPenaltyMode === 'PERCENT_ORDER_VALUE_PER_DAY') ? { lateDeliveryPenaltyMode: value.lateDeliveryPenaltyMode } : {}) };
}
export function parseBranchPage(value: unknown) {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items) || !('total' in value) || typeof value.total !== 'number') throw new Error('Danh sách chi nhánh không hợp lệ');
  return { items: value.items.map(parseManagedBranch), total: value.total };
}
