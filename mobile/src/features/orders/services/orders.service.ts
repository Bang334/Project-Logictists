import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';
import {
  ORDER_STATUSES,
  type CreatedCustomerOrder,
  type CreateCustomerOrderRequest,
  type CustomerBranch,
  type CustomerOrderDetail,
  type CustomerOrderItem,
  type CustomerOrderPage,
  type CustomerOrderStop,
  type CustomerOrderSummary,
  type OrderStatus,
} from '@/features/orders/types/order.types';
import {
  CUSTOMER_TRACKING_STATUSES,
  type CustomerOrderTracking,
  type CustomerTrackedTrip,
  type CustomerTrackingStatus,
  type CustomerVehicleLocation,
} from '@/features/orders/types/order-tracking.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message = 'Dữ liệu đơn vận chuyển từ máy chủ không đúng định dạng.'): never {
  throw new ApiError(message, 0, 'INVALID_RESPONSE');
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === 'string' &&
    ORDER_STATUSES.some((status) => status === value)
  );
}

function isTrackingStatus(value: unknown): value is CustomerTrackingStatus {
  return (
    typeof value === 'string' &&
    CUSTOMER_TRACKING_STATUSES.some((status) => status === value)
  );
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : invalidResponse();
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' || value === null
    ? value
    : invalidResponse();
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : invalidResponse();
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : invalidResponse();
}

function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalidResponse();
}

function dateTimeString(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    return invalidResponse();
  }
  return value;
}

function parseVehicleLocation(value: unknown): CustomerVehicleLocation | null {
  if (value === null) return null;
  if (!isRecord(value)) return invalidResponse();
  const latitude = finiteNumber(value.latitude);
  const longitude = finiteNumber(value.longitude);
  const accuracyM = value.accuracyM;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return invalidResponse();
  }
  if (
    accuracyM !== null &&
    (typeof accuracyM !== 'number' || !Number.isFinite(accuracyM) || accuracyM < 0)
  ) {
    return invalidResponse();
  }
  return {
    latitude,
    longitude,
    accuracyM,
    measuredAt: dateTimeString(value.measuredAt),
    receivedAt: dateTimeString(value.receivedAt),
    isStale: boolean(value.isStale),
  };
}

function parseTrackedTrip(value: unknown): CustomerTrackedTrip {
  if (!isRecord(value) || value.etaSource !== 'PLANNED') {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    tripNumber: requiredString(value.tripNumber),
    status: requiredString(value.status),
    version: integer(value.version),
    plannedDeliveryAt:
      value.plannedDeliveryAt === null
        ? null
        : dateTimeString(value.plannedDeliveryAt),
    etaSource: 'PLANNED',
    vehicleLocation: parseVehicleLocation(value.vehicleLocation),
  };
}

function parseTracking(value: unknown): CustomerOrderTracking {
  if (
    !isRecord(value) ||
    !isOrderStatus(value.orderStatus) ||
    !isTrackingStatus(value.trackingStatus) ||
    !Array.isArray(value.trips)
  ) {
    return invalidResponse('Dữ liệu theo dõi vận chuyển từ máy chủ không đúng định dạng.');
  }
  const trips = value.trips.map(parseTrackedTrip);
  if (value.trackingStatus === 'NOT_ASSIGNED' && trips.length !== 0) {
    return invalidResponse('Dữ liệu theo dõi vận chuyển từ máy chủ không nhất quán.');
  }
  return {
    orderId: requiredString(value.orderId),
    orderStatus: value.orderStatus,
    trackingStatus: value.trackingStatus,
    trips,
  };
}

function parseBranch(value: unknown): CustomerBranch {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: requiredString(value.id),
    code: requiredString(value.code),
    name: requiredString(value.name),
  };
}

function parseStop(value: unknown): CustomerOrderStop {
  if (!isRecord(value) || (value.type !== 'PICKUP' && value.type !== 'DELIVERY')) {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    type: value.type,
    sequence: integer(value.sequence),
    address: requiredString(value.address),
    latitude: finiteNumber(value.latitude),
    longitude: finiteNumber(value.longitude),
    contactName: requiredString(value.contactName),
    contactPhone: requiredString(value.contactPhone),
    serviceDurationMinutes: integer(value.serviceDurationMinutes),
  };
}

function parseSummary(value: unknown): CustomerOrderSummary {
  if (!isRecord(value) || !isOrderStatus(value.status) || !Array.isArray(value.stops)) {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    orderNumber: requiredString(value.orderNumber),
    status: value.status,
    version: integer(value.version),
    notes: nullableString(value.notes),
    totalPackages: integer(value.totalPackages),
    totalWeightKg: finiteNumber(value.totalWeightKg),
    totalVolumeM3: finiteNumber(value.totalVolumeM3),
    orderedAt: requiredString(value.orderedAt),
    createdAt: requiredString(value.createdAt),
    updatedAt: requiredString(value.updatedAt),
    stops: value.stops.map(parseStop).sort((a, b) => a.sequence - b.sequence),
  };
}

function parseItem(value: unknown): CustomerOrderItem {
  if (!isRecord(value)) return invalidResponse();
  const unitWeightKg = value.unitWeightKg;
  const unitVolumeM3 = value.unitVolumeM3;
  return {
    id: requiredString(value.id),
    description: requiredString(value.description),
    packageType: requiredString(value.packageType),
    quantity: integer(value.quantity),
    lineWeightKg: finiteNumber(value.lineWeightKg),
    unitWeightKg:
      unitWeightKg === null ? null : finiteNumber(unitWeightKg),
    lengthCm: finiteNumber(value.lengthCm),
    widthCm: finiteNumber(value.widthCm),
    heightCm: finiteNumber(value.heightCm),
    lineVolumeM3: finiteNumber(value.lineVolumeM3),
    unitVolumeM3:
      unitVolumeM3 === null ? null : finiteNumber(unitVolumeM3),
  };
}

function parseDetail(value: unknown): CustomerOrderDetail {
  const summary = parseSummary(value);
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidResponse();
  return { ...summary, items: value.items.map(parseItem) };
}

function parsePage(value: unknown): CustomerOrderPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidResponse();
  return {
    items: value.items.map(parseSummary),
    page: integer(value.page),
    limit: integer(value.limit),
    total: integer(value.total),
    totalPages: integer(value.totalPages),
  };
}

function parseCreated(value: unknown): CreatedCustomerOrder {
  if (!isRecord(value) || value.status !== 'DRAFT') return invalidResponse();
  return {
    id: requiredString(value.id),
    orderNumber: requiredString(value.orderNumber),
    status: value.status,
    version: integer(value.version),
    totalPackages: integer(value.totalPackages),
    totalWeightKg: finiteNumber(value.totalWeightKg),
    totalVolumeM3: finiteNumber(value.totalVolumeM3),
    createdAt: requiredString(value.createdAt),
    orderedAt: requiredString(value.orderedAt),
    branch: parseBranch(value.branch),
  };
}

async function getToken(): Promise<string> {
  const token = await tokenStorage.get();
  if (!token) {
    throw new ApiError('Phiên đăng nhập không còn tồn tại.', 401, 'HTTP_401');
  }
  return token;
}

export const ordersService = {
  async getBranches(): Promise<CustomerBranch[]> {
    const response = await apiClient.request('/customer/branches', {
      token: await getToken(),
    });
    if (!Array.isArray(response)) return invalidResponse();
    return response.map(parseBranch);
  },

  async getOrders(
    page = 1,
    limit = 20,
    status?: OrderStatus,
  ): Promise<CustomerOrderPage> {
    const query = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) query.set('status', status);
    const response = await apiClient.request(`/customer/orders?${query}`, {
      token: await getToken(),
    });
    return parsePage(response);
  },

  async getOrder(id: string): Promise<CustomerOrderDetail> {
    const response = await apiClient.request(
      `/customer/orders/${encodeURIComponent(id)}`,
      { token: await getToken() },
    );
    return parseDetail(response);
  },

  async getCustomerOrderTracking(id: string): Promise<CustomerOrderTracking> {
    const response = await apiClient.request(
      `/customer/orders/${encodeURIComponent(id)}/tracking`,
      { token: await getToken() },
    );
    return parseTracking(response);
  },

  async createOrder(
    request: CreateCustomerOrderRequest,
  ): Promise<CreatedCustomerOrder> {
    const response = await apiClient.request('/customer/orders', {
      method: 'POST',
      token: await getToken(),
      body: request,
    });
    return parseCreated(response);
  },
};
