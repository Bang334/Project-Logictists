import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';
import {
  DRIVER_INCIDENT_SEVERITIES,
  DRIVER_INCIDENT_TYPES,
  type CreateDriverIncidentRequest,
  type DriverIncident,
  type DriverIncidentListQuery,
  type DriverIncidentOrderReference,
  type DriverIncidentPage,
} from '@/features/driver-incidents/types/driver-incident.types';

function invalidResponse(): never {
  throw new ApiError(
    'Dữ liệu sự cố từ máy chủ không đúng định dạng.',
    0,
    'INVALID_RESPONSE',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : invalidResponse();
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' || value === null
    ? value
    : invalidResponse();
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : invalidResponse();
}

function requiredDateString(value: unknown): string {
  const text = requiredString(value);
  return Number.isNaN(new Date(text).getTime()) ? invalidResponse() : text;
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && allowed.some((item) => item === value);
}

function parseOrder(value: unknown): DriverIncidentOrderReference {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: requiredString(value.id),
    orderNumber: requiredString(value.orderNumber),
  };
}

export function parseDriverIncident(value: unknown): DriverIncident {
  if (
    !isRecord(value) ||
    !isOneOf(value.type, DRIVER_INCIDENT_TYPES) ||
    !isOneOf(value.severity, DRIVER_INCIDENT_SEVERITIES) ||
    !Array.isArray(value.affectedOrders)
  ) {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    tripId: requiredString(value.tripId),
    type: value.type,
    severity: value.severity,
    status: requiredString(value.status),
    description: requiredString(value.description),
    occurredAt: requiredDateString(value.occurredAt),
    createdAt: requiredDateString(value.createdAt),
    updatedAt: requiredDateString(value.updatedAt),
    resolution: nullableString(value.resolution),
    affectedOrders: value.affectedOrders.map(parseOrder),
  };
}

export function parseDriverIncidentPage(value: unknown): DriverIncidentPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidResponse();
  return {
    items: value.items.map(parseDriverIncident),
    page: integer(value.page),
    limit: integer(value.limit),
    total: integer(value.total),
    totalPages: integer(value.totalPages),
  };
}

async function getToken(): Promise<string> {
  const token = await tokenStorage.get();
  if (!token) {
    throw new ApiError('Phiên đăng nhập không còn tồn tại.', 401, 'HTTP_401');
  }
  return token;
}

export const driverIncidentsService = {
  async create(
    tripId: string,
    payload: CreateDriverIncidentRequest,
  ): Promise<DriverIncident> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(tripId)}/incidents`,
      { method: 'POST', token: await getToken(), body: payload },
    );
    return parseDriverIncident(response);
  },

  async getPage(
    tripId: string,
    query: DriverIncidentListQuery = {},
  ): Promise<DriverIncidentPage> {
    const params = new URLSearchParams({
      page: String(query.page ?? 1),
      limit: String(query.limit ?? 20),
    });
    if (query.type) params.set('type', query.type);
    if (query.status) params.set('status', query.status);
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(tripId)}/incidents?${params}`,
      { token: await getToken() },
    );
    return parseDriverIncidentPage(response);
  },

  async getOne(tripId: string, incidentId: string): Promise<DriverIncident> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(tripId)}/incidents/${encodeURIComponent(incidentId)}`,
      { token: await getToken() },
    );
    return parseDriverIncident(response);
  },
};
