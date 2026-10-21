import type { Driver, Vehicle } from './index';
export type FleetKind = 'vehicles' | 'drivers';
export const fleetReasonLabels: Record<string, string> = { EMPLOYEE_LINK_MISSING: 'Chưa liên kết nhân viên', EMPLOYEE_BRANCH_MISMATCH: 'Chi nhánh nhân viên chưa khớp', PROFILE_NOT_ACTIVE: 'Hồ sơ chưa sẵn sàng', VEHICLE_PROFILE_INCOMPLETE: 'Thiếu cấu hình hoặc điểm xuất phát', DOOR_AND_OBSTACLE_DATA_UNVERIFIED: 'Cửa và vật cản chưa được kiểm chứng', SHIFT_NOT_COVERING_INTERVAL: 'Ca chưa phủ toàn khoảng công việc', EMPLOYEE_LEAVE: 'Có lịch nghỉ', VEHICLE_UNAVAILABILITY: 'Có lịch xe không khả dụng', RESERVED_OR_ASSIGNED: 'Đã giữ lịch hoặc phân công', LICENSE_EXPIRES_BEFORE_WORK_END: 'Bằng hết hạn trước khi kết thúc công việc' };
export interface FleetProfile {
  id: string; updatedAt: string; homeBranchId: string; status: string;
  plateNumber?: string; model?: string; vehicleTypeId?: string; vehicleType?: string;
  homeDepotLocationId?: string | null; payloadCapacityKg?: number; lengthCm?: number; widthCm?: number; heightCm?: number;
  fullName?: string; phone?: string; citizenId?: string; licenseNumber?: string; licenseClass?: string; licenseExpiry?: string;
  employeeId?: string | null; employeeVersion?: number | null;
  homeBranch?: { name: string; timezone?: string };
}
export interface FleetPageResult<T> { items: T[]; total: number; page: number; pageSize: number; shiftTotal?: number; leaveTotal?: number }
export interface FleetEmployee { id: string; employeeCode: string; fullName: string; branchId: string; version: number }
export interface FleetSchedule { id: string; kind: string; startsAt: string; endsAt: string | null; reason: string | null; status: string; version: number; recordedById: string | null }
export interface Availability { resourceId: string; profile: FleetProfile; version: string; profileActive: boolean; dataComplete: boolean; scheduleCovered: boolean | null; reasons: string[]; unchecked: string[]; affectedTrips: Array<{ id: string; tripNumber: string; status: string }> }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Phản hồi API không hợp lệ'); return value as Record<string, unknown>;
}
export function profile(value: unknown): FleetProfile {
  const v = record(value);
  if (typeof v.id !== 'string' || typeof v.updatedAt !== 'string' || typeof v.homeBranchId !== 'string' || typeof v.status !== 'string') throw new Error('Hồ sơ API không hợp lệ');
  for (const key of ['plateNumber', 'model', 'fullName', 'phone', 'licenseClass', 'licenseExpiry']) if (v[key] !== undefined && typeof v[key] !== 'string') throw new Error('Trường hồ sơ không hợp lệ');
  return value as FleetProfile;
}
export function page<T>(value: unknown, parse: (v: unknown) => T): FleetPageResult<T> {
  const v = record(value); if (!Array.isArray(v.items) || typeof v.total !== 'number' || typeof v.page !== 'number' || typeof v.pageSize !== 'number') throw new Error('Phân trang API không hợp lệ');
  return { items: v.items.map(parse), total: v.total, page: v.page, pageSize: v.pageSize, ...(typeof v.shiftTotal === 'number' ? { shiftTotal: v.shiftTotal } : {}), ...(typeof v.leaveTotal === 'number' ? { leaveTotal: v.leaveTotal } : {}) };
}
export function employee(value: unknown): FleetEmployee {
  const v = record(value); if (typeof v.id !== 'string' || typeof v.employeeCode !== 'string' || typeof v.fullName !== 'string' || typeof v.branchId !== 'string' || typeof v.version !== 'number') throw new Error('Employee API không hợp lệ');
  return { id: v.id, employeeCode: v.employeeCode, fullName: v.fullName, branchId: v.branchId, version: v.version };
}
export function schedule(value: unknown): FleetSchedule {
  const v = record(value); if (typeof v.id !== 'string' || typeof v.kind !== 'string' || typeof v.startsAt !== 'string' || (v.endsAt !== null && typeof v.endsAt !== 'string') || typeof v.status !== 'string' || typeof v.version !== 'number' || (v.reason !== null && typeof v.reason !== 'string') || (v.recordedById !== null && typeof v.recordedById !== 'string')) throw new Error('Lịch API không hợp lệ');
  return { id: v.id, kind: v.kind, startsAt: v.startsAt, endsAt: v.endsAt, status: v.status, version: v.version, reason: v.reason, recordedById: v.recordedById };
}
export function availability(value: unknown): Availability {
  const v = record(value); if (typeof v.resourceId !== 'string' || typeof v.version !== 'string' || typeof v.profileActive !== 'boolean' || typeof v.dataComplete !== 'boolean' || !(v.scheduleCovered === null || typeof v.scheduleCovered === 'boolean') || !Array.isArray(v.reasons) || !v.reasons.every(r => typeof r === 'string') || !Array.isArray(v.unchecked) || !v.unchecked.every(r => typeof r === 'string') || !Array.isArray(v.affectedTrips)) throw new Error('Khả dụng API không hợp lệ');
  return { resourceId: v.resourceId, profile: profile(v.profile), version: v.version, profileActive: v.profileActive, dataComplete: v.dataComplete, scheduleCovered: v.scheduleCovered, reasons: v.reasons, unchecked: v.unchecked, affectedTrips: v.affectedTrips.map(t => { const r = record(t); if (typeof r.id !== 'string' || typeof r.tripNumber !== 'string' || typeof r.status !== 'string') throw new Error('Trip API không hợp lệ'); return { id: r.id, tripNumber: r.tripNumber, status: r.status }; }) };
}
// Validate before passing the old edit forms their existing contracts.
export function editVehicle(value: unknown): Vehicle {
  const v = profile(value); if (!v.plateNumber || !v.model || !v.vehicleTypeId || !v.vehicleType || typeof v.payloadCapacityKg !== 'number') throw new Error('Chi tiết xe thiếu dữ liệu');
  return value as Vehicle;
}
export function editDriver(value: unknown): Driver {
  const d = profile(value); if (!d.fullName || !d.phone || !d.citizenId || !d.licenseNumber || !d.licenseClass || !d.licenseExpiry) throw new Error('Chi tiết tài xế thiếu dữ liệu hoặc quyền');
  return value as Driver;
}
