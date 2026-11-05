/** A read model, not a copy of internal audit/event payloads. Unknown keys fail closed. */
export const auditEntities = {
  Order: 'Đơn vận tải', Customer: 'Khách hàng', Vehicle: 'Xe', Driver: 'Tài xế',
  VehicleUnavailability: 'Lịch xe', DriverShift: 'Ca tài xế', EmployeeLeave: 'Lịch nghỉ',
  User: 'Tài khoản', Branch: 'Chi nhánh',
} as const;
export type AuditEntity = keyof typeof auditEntities;
const actions: Record<string, string> = {
  CREATE: 'Tạo mới', UPDATE: 'Cập nhật', CANCEL: 'Hủy lịch', LINK_EMPLOYEE: 'Liên kết nhân viên',
  TRIP_CONFLICT_RECORDED: 'Ghi nhận xung đột chuyến', CREATED: 'Tạo đơn', UPDATED: 'Sửa đơn',
  PACKAGES_RECONCILED: 'Đối soát kiện', CONFIRMED: 'Xác nhận đơn', CANCELLED: 'Hủy đơn',
  ACCOUNT_CREATED: 'Tạo tài khoản', ACCOUNT_UPDATED: 'Sửa tài khoản/phạm vi', ACCOUNT_LOCKED: 'Khóa tài khoản',
  ACCOUNT_UNLOCKED: 'Mở khóa tài khoản', PASSWORD_CHANGED: 'Đã đổi mật khẩu',
  DRIVER_SCOPE_TRANSFERRED: 'Chuyển phạm vi tài xế', BRANCH_CREATED: 'Tạo chi nhánh',
  BRANCH_UPDATED: 'Sửa chi nhánh', BRANCH_ACTIVATED: 'Kích hoạt chi nhánh', BRANCH_DEACTIVATED: 'Ngừng chi nhánh',
};
export const allowedActions: Record<AuditEntity, readonly string[]> = {
  Order: ['CREATED', 'UPDATED', 'PACKAGES_RECONCILED', 'CONFIRMED', 'CANCELLED'],
  Customer: ['CREATE', 'UPDATE'], Vehicle: ['CREATE', 'UPDATE'], Driver: ['CREATE', 'UPDATE', 'LINK_EMPLOYEE'],
  VehicleUnavailability: ['CREATE', 'UPDATE', 'CANCEL', 'TRIP_CONFLICT_RECORDED'],
  DriverShift: ['CREATE', 'UPDATE', 'CANCEL'], EmployeeLeave: ['CREATE', 'UPDATE', 'CANCEL'],
  User: ['ACCOUNT_CREATED', 'ACCOUNT_UPDATED', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED', 'PASSWORD_CHANGED', 'DRIVER_SCOPE_TRANSFERRED'],
  Branch: ['BRANCH_CREATED', 'BRANCH_UPDATED', 'BRANCH_ACTIVATED', 'BRANCH_DEACTIVATED'],
};
const fields: Record<string, string> = {
  name: 'Tên', fullName: 'Họ tên', phone: 'Điện thoại', email: 'Email', address: 'Địa chỉ',
  contactPerson: 'Người liên hệ', taxCode: 'Mã số thuế', notes: 'Ghi chú', active: 'Trạng thái hoạt động',
  branchIds: 'Phạm vi chi nhánh', homeBranchId: 'Chi nhánh gốc', homeDepotLocationId: 'Điểm xuất phát',
  plateNumber: 'Biển số', model: 'Dòng xe', vehicleTypeId: 'Loại xe', status: 'Trạng thái',
  citizenId: 'Giấy tờ định danh (chỉ tên trường)', licenseNumber: 'Số bằng (chỉ tên trường)',
  licenseClass: 'Hạng bằng', licenseExpiry: 'Hạn bằng', fixedSalaryMonthly: 'Lương cố định (chỉ tên trường)',
  tripBasePay: 'Lương chuyến (chỉ tên trường)', perKmPay: 'Lương theo km (chỉ tên trường)',
  latitude: 'Vĩ độ', longitude: 'Kinh độ', timezone: 'Múi giờ', deliveryGraceDays: 'Thời gian gia hạn',
  lateDeliveryPenaltyMode: 'Cách tính phí trễ', lateDeliveryPenaltyValue: 'Mức phí trễ',
};
const entityFields: Partial<Record<AuditEntity, readonly string[]>> = {
  Customer: ['name', 'phone', 'email', 'address', 'contactPerson', 'taxCode', 'notes', 'active', 'branchIds'],
  Vehicle: ['plateNumber', 'model', 'vehicleTypeId', 'homeBranchId', 'homeDepotLocationId', 'status'],
  Driver: ['fullName', 'citizenId', 'phone', 'licenseNumber', 'licenseClass', 'licenseExpiry', 'homeBranchId', 'status', 'fixedSalaryMonthly', 'tripBasePay', 'perKmPay'],
  User: ['fullName', 'branchIds'],
  Branch: ['name', 'address', 'latitude', 'longitude', 'phone', 'timezone', 'deliveryGraceDays', 'lateDeliveryPenaltyMode', 'lateDeliveryPenaltyValue'],
};
export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown, max = 1000): string | null => typeof value === 'string' && value.length <= max ? value : null;
const ids = (value: unknown): string[] => Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === 'string' && /^[\w-]{1,100}$/.test(v)) ? [...new Set(value)] : [];
export interface AuditSourceRow {
  source: 'AUDIT_LOG' | 'ORDER_EVENT'; id: string; entityType: string; entityId: string;
  action: string; actorUserId: string | null; timestamp: Date; summary: unknown;
  fromStatus?: string | null; toStatus?: string | null;
}
export function projectAudit(row: AuditSourceRow) {
  const entity = Object.prototype.hasOwnProperty.call(auditEntities, row.entityType) ? row.entityType as AuditEntity : null;
  const known = entity !== null && allowedActions[entity].includes(row.action);
  const summary = known ? object(row.summary) : {};
  const password = row.action === 'PASSWORD_CHANGED';
  const allowed = entity ? entityFields[entity] ?? [] : [];
  const changedFields = !password && Array.isArray(summary.fields)
    ? [...new Set(summary.fields.filter((f): f is string => typeof f === 'string' && allowed.includes(f)))].map(key => ({ key, label: fields[key] })) : [];
  if (entity === 'Customer' && Object.prototype.hasOwnProperty.call(summary, 'previousBranchIds') && !changedFields.some(f => f.key === 'branchIds')) changedFields.push({ key: 'branchIds', label: fields.branchIds });
  // Only recorded metadata is evidence of historical scope. Never consult actor/resource's current branch.
  let branchIds = ids(summary.auditBranchIds);
  if (!branchIds.length && known && entity === 'Branch') branchIds = ids([row.entityId]);
  if (!branchIds.length && known && entity === 'Customer') branchIds = [...new Set([...ids(summary.previousBranchIds), ...ids(summary.branchIds)])];
  if (!branchIds.length && known && row.action === 'DRIVER_SCOPE_TRANSFERRED') branchIds = ids([summary.fromBranchId, summary.toBranchId]);
  const changes: Array<{ label: string; before: string | null; after: string | null }> = [];
  if (known && entity === 'Order') {
    const status = (value: unknown) => typeof value === 'string' && ['DRAFT', 'CONFIRMED', 'CANCELLED'].includes(value) ? value : null;
    if (status(row.fromStatus) || status(row.toStatus)) changes.push({ label: 'Trạng thái đơn', before: status(row.fromStatus), after: status(row.toStatus) });
  }
  if (known && entity === 'Branch' && typeof summary.active === 'boolean') changes.push({ label: 'Trạng thái hoạt động', before: null, after: summary.active ? 'Hoạt động' : 'Ngừng hoạt động' });
  if (known && ['VehicleUnavailability', 'DriverShift', 'EmployeeLeave'].includes(entity ?? '')) {
    const previous = object(summary.previous);
    const instant = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    for (const [key, label] of [['startsAt', 'Bắt đầu lịch'], ['endsAt', 'Kết thúc lịch']]) {
      const value = (record: Record<string, unknown>) => key === 'endsAt' && record[key] === null ? 'Không có thời điểm kết thúc' : instant(record[key]);
      const before = value(previous), after = value(summary);
      if (before || after) changes.push({ label, before, after });
    }
  }
  if (known && entity === 'Customer' && Array.isArray(summary.previousBranchIds) && Array.isArray(summary.branchIds)) {
    changes.push({ label: 'Phạm vi phục vụ (ID chi nhánh)', before: ids(summary.previousBranchIds).join(', ') || null, after: ids(summary.branchIds).join(', ') || null });
  }
  return {
    id: row.id, source: row.source, entityType: entity ?? 'Unknown', entityId: row.entityId,
    entityLabel: entity ? auditEntities[entity] : 'Đối tượng chưa nhận diện',
    action: known ? row.action : 'UNKNOWN', actionLabel: known ? actions[row.action] : 'Thao tác chưa nhận diện',
    actorUserId: row.actorUserId, occurredAt: row.timestamp.toISOString(),
    scope: { kind: branchIds.length ? 'RECORDED_BRANCHES' : 'UNKNOWN', branchIds },
    changedFields, changes,
    reason: known && (entity === 'Order' && row.action === 'CANCELLED' || ['VehicleUnavailability', 'DriverShift', 'EmployeeLeave'].includes(entity ?? '')) ? text(summary.reason) : null,
    resourceId: known && ['VehicleUnavailability', 'DriverShift', 'EmployeeLeave'].includes(entity ?? '') ? ids([summary.resourceId])[0] ?? null : null,
  };
}
