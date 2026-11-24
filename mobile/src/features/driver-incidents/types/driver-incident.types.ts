export const DRIVER_INCIDENT_TYPES = [
  'VEHICLE_BREAKDOWN',
  'ACCIDENT',
  'TRAFFIC_JAM',
  'ROAD_BLOCKED',
  'PACKAGE_DAMAGED',
  'PACKAGE_MISSING',
  'SECURITY_ISSUE',
  'OTHER',
] as const;

export type DriverIncidentType = (typeof DRIVER_INCIDENT_TYPES)[number];

export const DRIVER_INCIDENT_SEVERITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type DriverIncidentSeverity =
  (typeof DRIVER_INCIDENT_SEVERITIES)[number];

export interface DriverIncidentOrderReference {
  id: string;
  orderNumber: string;
}

export interface DriverIncident {
  id: string;
  tripId: string;
  type: DriverIncidentType;
  severity: DriverIncidentSeverity;
  status: string;
  description: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  resolution: string | null;
  affectedOrders: DriverIncidentOrderReference[];
}

export interface DriverIncidentPage {
  items: DriverIncident[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DriverIncidentListQuery {
  page?: number;
  limit?: number;
  type?: DriverIncidentType;
  status?: string;
}

export interface CreateDriverIncidentInput {
  type: DriverIncidentType;
  severity: DriverIncidentSeverity;
  description: string;
  occurredAt: string;
  affectedOrderIds: string[];
}

export interface CreateDriverIncidentRequest extends CreateDriverIncidentInput {
  idempotencyKey: string;
}

export const DRIVER_INCIDENT_TYPE_LABELS: Record<DriverIncidentType, string> = {
  VEHICLE_BREAKDOWN: 'Hỏng xe',
  ACCIDENT: 'Tai nạn',
  TRAFFIC_JAM: 'Ùn tắc giao thông',
  ROAD_BLOCKED: 'Đường bị chặn',
  PACKAGE_DAMAGED: 'Hàng hóa bị hư hỏng',
  PACKAGE_MISSING: 'Thiếu/mất hàng',
  SECURITY_ISSUE: 'Sự cố an ninh',
  OTHER: 'Khác',
};

export const DRIVER_INCIDENT_SEVERITY_LABELS: Record<
  DriverIncidentSeverity,
  string
> = {
  LOW: 'Thấp',
  MEDIUM: 'Trung bình',
  HIGH: 'Cao',
  CRITICAL: 'Nghiêm trọng',
};

export const DRIVER_INCIDENT_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Chờ xử lý',
  ACKNOWLEDGED: 'Đã tiếp nhận',
  RESOLVED: 'Đã xử lý',
};

export function driverIncidentStatusLabel(status: string): string {
  return DRIVER_INCIDENT_STATUS_LABELS[status] ?? `Trạng thái: ${status}`;
}
