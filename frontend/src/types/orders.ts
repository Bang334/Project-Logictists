import type { Order } from './index';
export interface PackageInput { id?: string; lengthMm: number; widthMm: number; heightMm: number; weightG: string }
export interface OrderLineInput { id?: string; description: string; packageType: string; sku?: string; packages: PackageInput[] }
export interface StopInput {
  id?: string; type: 'PICKUP' | 'DELIVERY'; address: string; latitude: number; longitude: number;
  contactName: string; contactPhone: string; windowStart?: string | null; windowEnd?: string | null; serviceDurationMinutes: number;
}
export interface OrderInput { branchId: string; customerId: string; notes?: string; stops: StopInput[]; items: OrderLineInput[] }
export interface OrderQuery { status?: string; customerId?: string; branchId?: string; page?: number; pageSize?: number; search?: string }
export interface OrderPage { items: Order[]; total: number; page: number; pageSize: number }
function object(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function numeric(x: unknown): x is number { return typeof x === 'number' && Number.isFinite(x); }
function nullableString(x: unknown) { return x === null || typeof x === 'string'; }
function assertOrder(x: unknown): asserts x is Order {
  if (!object(x) || typeof x.id !== 'string' || typeof x.orderNumber !== 'string' || typeof x.customerId !== 'string' || typeof x.branchId !== 'string'
    || !numeric(x.version) || !numeric(x.totalPackages) || !numeric(x.totalWeightKg) || !numeric(x.totalVolumeM3)
    || !['DRAFT','CONFIRMED','ASSIGNED','IN_TRANSIT','COMPLETED','CANCELLED'].includes(String(x.status))
    || !['COMPLETE','LEGACY_REVIEW'].includes(String(x.packageDataStatus))
    || typeof x.operationalTimezone !== 'string' || !nullableString(x.totalWeightG) || !nullableString(x.totalVolumeMm3)
    || !object(x.customer) || typeof x.customer.name !== 'string' || typeof x.customer.id !== 'string'
    || !Array.isArray(x.stops) || !x.stops.every(s => object(s) && typeof s.id === 'string' && s.orderId === x.id && ['PICKUP','DELIVERY'].includes(String(s.type)) && typeof s.contactName === 'string' && typeof s.contactPhone === 'string' && typeof s.address === 'string' && numeric(s.latitude) && numeric(s.longitude) && numeric(s.serviceDurationMinutes) && nullableString(s.windowStart) && nullableString(s.windowEnd))
    || !Array.isArray(x.items) || !x.items.every(i => object(i) && typeof i.id === 'string' && typeof i.description === 'string' && typeof i.packageType === 'string' && numeric(i.quantity) && numeric(i.weightKg) && numeric(i.volumeM3) && [i.lengthCm, i.widthCm, i.heightCm].every(v => v === null || numeric(v)) && Array.isArray(i.packages) && i.packages.every(p => object(p)
      && typeof p.id === 'string' && p.orderItemId === i.id && p.orderId === x.id && typeof p.packageCode === 'string'
      && numeric(p.lengthMm) && numeric(p.widthMm) && numeric(p.heightMm) && typeof p.weightG === 'string' && /^-?[0-9]+$/.test(p.weightG) && typeof p.status === 'string' && numeric(p.version)
      && (x.packageDataStatus === 'LEGACY_REVIEW' || ([p.lengthMm, p.widthMm, p.heightMm].every(v => Number.isSafeInteger(v) && v > 0) && /^[1-9][0-9]*$/.test(p.weightG)))
      && nullableString(p.pickupStopId) && nullableString(p.deliveryStopId)))) throw new Error('Phản hồi đơn hàng không đúng hợp đồng dữ liệu');

}
export function parseOrder(x: unknown): Order { assertOrder(x); return x; }
export function parseOrderPage(x: unknown): OrderPage {
  if (!object(x) || !Array.isArray(x.items) || !numeric(x.total) || !numeric(x.page) || !numeric(x.pageSize)) throw new Error('Phản hồi danh sách đơn không hợp lệ');
  return { items: x.items.map(parseOrder), total: x.total, page: x.page, pageSize: x.pageSize };
}
