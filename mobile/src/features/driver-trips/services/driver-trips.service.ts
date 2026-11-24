import { apiClient } from "@/shared/api/api-client";
import { ApiError } from "@/shared/api/api-error";
import { tokenStorage } from "@/shared/storage/token-storage";
import { canViewDriverStopPhone, normalizeDriverStopPhone } from "../selectors/driver-stop-contact";
import {
  DRIVER_STOP_STATUSES,
  DRIVER_TRIP_STATUSES,
  type DriverPackageStatus,
  type DriverStopStatus,
  type DriverTripStop,
  type DriverStopTask,
  type DriverStopType,
  type DriverTaskAction,
  type DriverTripAssignment,
  type DriverTripDetail,
  type DriverTripPackage,
  type DriverTripPage,
  type DriverTripStatus,
  type DriverTripSummary,
  type DriverTripVehicle,
  type DriverHistoryItem,
  type DriverHistoryPage,
  type DriverHistoryStatus,
  type DriverTripDateRange,
  type DriverActivitySummary,
  type CompleteDriverStopPayload,
  type DriverStopCommandResponse,
  type DriverTripCommandPayload,
  type DriverStopCommandPayload,
  type DriverTripStateCommandResponse,
} from "@/features/driver-trips/types/driver-trip.types";

const STOP_TYPES = ["PICKUP", "DELIVERY", "DEPOT_START", "DEPOT_END"] as const;
const TASK_ACTIONS = ["LOAD", "UNLOAD"] as const;
const PACKAGE_STATUSES = [
  "DRAFT",
  "READY",
  "ALLOCATED",
  "LOADED",
  "DELIVERED",
  "DAMAGED",
  "CANCELLED",
] as const;

function invalidResponse(): never {
  throw new ApiError(
    "Dữ liệu chuyến đi từ máy chủ không đúng định dạng.",
    0,
    "INVALID_RESPONSE",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : invalidResponse();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" || value === null
    ? value
    : invalidResponse();
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : invalidResponse();
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : invalidResponse();
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.some((item) => item === value);
}

function parseVehicle(value: unknown): DriverTripVehicle {
  if (!isRecord(value)) return invalidResponse();
  const vehicle: DriverTripVehicle = {
    id: requiredString(value.id),
    plateNumber: requiredString(value.plateNumber),
    model: requiredString(value.model),
    vehicleType: requiredString(value.vehicleType),
  };
  const dimensions = ['payloadCapacityKg', 'volumeCapacityM3', 'lengthCm', 'widthCm', 'heightCm'] as const;
  for (const key of dimensions) {
    const amount = value[key];
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
      vehicle[key] = amount;
    }
  }
  return vehicle;
}

function parseAssignment(value: unknown): DriverTripAssignment {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: requiredString(value.id),
    role: requiredString(value.role),
    status: requiredString(value.status),
    startTime: requiredString(value.startTime),
    endTime: requiredString(value.endTime),
  };
}

function parseSummary(value: unknown): DriverTripSummary {
  if (!isRecord(value) || !isOneOf(value.status, DRIVER_TRIP_STATUSES)) {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    tripNumber: requiredString(value.tripNumber),
    status: value.status,
    version: integer(value.version),
    plannedStartTime: requiredString(value.plannedStartTime),
    plannedEndTime: requiredString(value.plannedEndTime),
    actualStartTime: nullableString(value.actualStartTime),
    actualEndTime: nullableString(value.actualEndTime),
    totalDistanceKm: finiteNumber(value.totalDistanceKm),
    totalDurationMinutes: finiteNumber(value.totalDurationMinutes),
    vehicle: parseVehicle(value.vehicle),
    assignment: parseAssignment(value.assignment),
    ...(value.calendarAssignments === undefined ? {} : {
      calendarAssignments: Array.isArray(value.calendarAssignments)
        ? value.calendarAssignments.map(parseAssignment) : invalidResponse(),
    }),
    stopCount: integer(value.stopCount),
  };
}

function parsePackage(value: unknown): DriverTripPackage | null {
  if (value === null) return null;
  if (!isRecord(value) || !isOneOf(value.status, PACKAGE_STATUSES)) {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    packageCode: requiredString(value.packageCode),
    weightKg: finiteNumber(value.weightKg),
    lengthCm: finiteNumber(value.lengthCm),
    widthCm: finiteNumber(value.widthCm),
    heightCm: finiteNumber(value.heightCm),
    status: value.status as DriverPackageStatus,
  };
}

function parseTask(value: unknown): DriverStopTask {
  if (!isRecord(value) || !isOneOf(value.action, TASK_ACTIONS)) {
    return invalidResponse();
  }
  const order = value.order;
  if (order !== null && !isRecord(order)) return invalidResponse();
  return {
    id: requiredString(value.id),
    action: value.action as DriverTaskAction,
    plannedQuantity: integer(value.plannedQuantity),
    actualQuantity:
      value.actualQuantity === null ? null : integer(value.actualQuantity),
    order:
      order === null
        ? null
        : {
            id: requiredString(order.id),
            orderNumber: requiredString(order.orderNumber),
          },
    package: parsePackage(value.package),
  };
}

function parseStop(value: unknown) {
  if (
    !isRecord(value) ||
    !isOneOf(value.stopType, STOP_TYPES) ||
    !isOneOf(value.status, DRIVER_STOP_STATUSES) ||
    !Array.isArray(value.tasks)
  ) {
    return invalidResponse();
  }
  const deliveryAttempt = value.deliveryAttempt ?? null;
  if (deliveryAttempt !== null && !isRecord(deliveryAttempt)) {
    return invalidResponse();
  }
  let parsedDeliveryAttempt: DriverTripStop["deliveryAttempt"] = null;
  if (isRecord(deliveryAttempt)) {
    const result = deliveryAttempt.result;
    if (!isOneOf(result, ["SUCCESS", "PARTIAL", "FAILED"] as const)) {
      return invalidResponse();
    }
    parsedDeliveryAttempt = {
      id: requiredString(deliveryAttempt.id),
      attemptNumber: integer(deliveryAttempt.attemptNumber),
      result,
      recipientName: nullableString(deliveryAttempt.recipientName),
    };
  }
  return {
    id: requiredString(value.id),
    sequence: integer(value.sequence),
    stopType: value.stopType as DriverStopType,
    status: value.status as DriverStopStatus,
    address: requiredString(value.address),
    latitude: finiteNumber(value.latitude),
    longitude: finiteNumber(value.longitude),
    contactName: nullableString(value.contactName),
    contactPhone: nullableString(value.contactPhone),
    plannedArrivalTime: nullableString(value.plannedArrivalTime),
    plannedDepartureTime: nullableString(value.plannedDepartureTime),
    actualArrivalTime: nullableString(value.actualArrivalTime),
    actualDepartureTime: nullableString(value.actualDepartureTime),
    deliveryAttempt: parsedDeliveryAttempt,
    tasks: value.tasks.map(parseTask),
  };
}

export function parseDriverTripDetail(value: unknown): DriverTripDetail {
  const summary = parseSummary(value);
  if (!isRecord(value) || !Array.isArray(value.stops)) return invalidResponse();
  const allowPhone = canViewDriverStopPhone(summary);
  return {
    ...summary,
    stops: value.stops.map((item) => {
      const stop = parseStop(item);
      return { ...stop, contactPhone: allowPhone ? normalizeDriverStopPhone(stop.contactPhone) : null };
    }).sort((a, b) => a.sequence - b.sequence),
  };
}

function parsePage(value: unknown): DriverTripPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidResponse();
  return {
    items: value.items.map(parseSummary),
    page: integer(value.page),
    limit: integer(value.limit),
    total: integer(value.total),
    totalPages: integer(value.totalPages),
  };
}

function parseHistoryItem(value: unknown): DriverHistoryItem {
  if (!isRecord(value) || !isOneOf(value.status, ['COMPLETED', 'CANCELLED'] as const) ||
      !isOneOf(value.dateBasis, ['ACTUAL_END', 'PLANNED_START'] as const)) return invalidResponse();
  const historyAt = requiredString(value.historyAt);
  if (!Number.isFinite(Date.parse(historyAt))) return invalidResponse();
  return {
    tripId: requiredString(value.tripId), tripNumber: requiredString(value.tripNumber),
    status: value.status, dateBasis: value.dateBasis, historyAt, vehicle: parseVehicle(value.vehicle),
    stopCount: integer(value.stopCount), processedStops: integer(value.processedStops),
    loadTaskCount: integer(value.loadTaskCount), unloadTaskCount: integer(value.unloadTaskCount),
    distinctPackageCount: integer(value.distinctPackageCount),
    loadedQuantity: value.loadedQuantity === null ? null : integer(value.loadedQuantity),
    unloadedQuantity: value.unloadedQuantity === null ? null : integer(value.unloadedQuantity),
    successAttempts: integer(value.successAttempts), partialAttempts: integer(value.partialAttempts),
    failedAttempts: integer(value.failedAttempts),
  };
}

function parseActivitySummary(value: unknown): DriverActivitySummary {
  if (!isRecord(value) || !isRecord(value.range) || !isRecord(value.coverage) ||
      !isOneOf(value.coverage.status, ['COMPLETE', 'PARTIAL', 'NO_DATA'] as const)) return invalidResponse();
  const { from, to } = value.range;
  const { asOf } = value;
  if (![from, to, asOf].every((part) => typeof part === 'string' && Number.isFinite(Date.parse(part)))) {
    return invalidResponse();
  }
  const timeZone = requiredString(value.timeZone);
  try { new Intl.DateTimeFormat('vi-VN', { timeZone }); }
  catch { return invalidResponse(); }
  const base = { range: { from: requiredString(from), to: requiredString(to) }, timeZone, asOf: requiredString(asOf) };
  const status = value.coverage.status;
  if (status === 'NO_DATA') {
    if (value.deliveries !== null || value.completedTripCount !== null ||
        value.processedStopCount !== null || value.depotStopCount !== null) return invalidResponse();
    return { ...base, coverage: { status }, deliveries: null,
      completedTripCount: null, processedStopCount: null, depotStopCount: null };
  }
  if (!isRecord(value.deliveries)) return invalidResponse();
  const count = (raw: unknown) => {
    const parsed = integer(raw);
    return parsed >= 0 ? parsed : invalidResponse();
  };
  return {
    ...base, coverage: { status },
    completedTripCount: count(value.completedTripCount),
    processedStopCount: count(value.processedStopCount),
    depotStopCount: count(value.depotStopCount),
    deliveries: {
      success: count(value.deliveries.success), partial: count(value.deliveries.partial),
      failed: count(value.deliveries.failed), unclassified: count(value.deliveries.unclassified),
    },
  };
}

function parseTripStateCommand(value: unknown): DriverTripStateCommandResponse {
  if (!isRecord(value) || !isOneOf(value.status, DRIVER_TRIP_STATUSES)) {
    return invalidResponse();
  }
  const response: DriverTripStateCommandResponse = {
    id: requiredString(value.id),
    status: value.status,
    version: integer(value.version),
  };
  if (typeof value.actualStartTime === "string") {
    response.actualStartTime = value.actualStartTime;
  }
  if (typeof value.actualEndTime === "string") {
    response.actualEndTime = value.actualEndTime;
  }
  return response;
}

function parseStopCommand(value: unknown): DriverStopCommandResponse {
  if (!isRecord(value) || !isRecord(value.stop)) return invalidResponse();
  const stop = value.stop;
  if (!isOneOf(stop.status, DRIVER_STOP_STATUSES)) return invalidResponse();
  const response: DriverStopCommandResponse = {
    tripId: requiredString(value.tripId),
    tripVersion: integer(value.tripVersion),
    stop: {
      id: requiredString(stop.id),
      status: stop.status,
    },
  };
  if (typeof value.eventType === "string") response.eventType = value.eventType;
  if (typeof stop.actualArrivalTime === "string") {
    response.stop.actualArrivalTime = stop.actualArrivalTime;
  }
  if (typeof stop.actualDepartureTime === "string") {
    response.stop.actualDepartureTime = stop.actualDepartureTime;
  }
  if (value.deliveryAttempt === null) {
    response.deliveryAttempt = null;
  } else if (isRecord(value.deliveryAttempt)) {
    const result = value.deliveryAttempt.result;
    if (!isOneOf(result, ["SUCCESS", "PARTIAL", "FAILED"] as const)) {
      return invalidResponse();
    }
    response.deliveryAttempt = {
      id: requiredString(value.deliveryAttempt.id),
      attemptNumber: integer(value.deliveryAttempt.attemptNumber),
      result,
    };
  }
  return response;
}

async function getToken(): Promise<string> {
  const token = await tokenStorage.get();
  if (!token) {
    throw new ApiError("Phiên đăng nhập không còn tồn tại.", 401, "HTTP_401");
  }
  return token;
}

export const driverTripsService = {
  async getTrips(
    page = 1,
    limit = 20,
    status?: DriverTripStatus,
    range?: DriverTripDateRange,
  ): Promise<DriverTripPage> {
    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (status) query.set("status", status);
    if (range) {
      query.set("from", range.from);
      query.set("to", range.to);
    }
    const response = await apiClient.request(`/driver/trips?${query}`, {
      token: await getToken(),
    });
    return parsePage(response);
  },

  async getHistory(range: DriverTripDateRange, status?: DriverHistoryStatus, cursor?: string): Promise<DriverHistoryPage> {
    const query = new URLSearchParams({ ...range, limit: '20' });
    if (status) query.set('status', status);
    if (cursor) query.set('cursor', cursor);
    const response = await apiClient.request(`/driver/trips/history?${query}`, { token: await getToken() });
    if (!isRecord(response) || !Array.isArray(response.items)) return invalidResponse();
    return { items: response.items.map(parseHistoryItem), nextCursor: nullableString(response.nextCursor) };
  },

  async getActivitySummary(range: DriverTripDateRange): Promise<DriverActivitySummary> {
    const query = new URLSearchParams({ ...range });
    const response = await apiClient.request(`/driver/me/activity-summary?${query}`, { token: await getToken() });
    return parseActivitySummary(response);
  },

  async getTrip(id: string, token?: string): Promise<DriverTripDetail> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(id)}`,
      { token: token ?? await getToken() },
    );
    return parseDriverTripDetail(response);
  },

  async startTrip(
    id: string,
    payload: DriverTripCommandPayload,
  ): Promise<DriverTripStateCommandResponse> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(id)}/start`,
      { method: "POST", token: await getToken(), body: payload },
    );
    return parseTripStateCommand(response);
  },

  async arriveStop(
    tripId: string,
    stopId: string,
    payload: DriverStopCommandPayload,
    token?: string,
  ): Promise<DriverStopCommandResponse> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(tripId)}/stops/${encodeURIComponent(stopId)}/arrive`,
      { method: "POST", token: token ?? await getToken(), body: payload },
    );
    return parseStopCommand(response);
  },

  async completeStop(
    tripId: string,
    stopId: string,
    payload: CompleteDriverStopPayload,
    token?: string,
  ): Promise<DriverStopCommandResponse> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(tripId)}/stops/${encodeURIComponent(stopId)}/complete`,
      { method: "POST", token: token ?? await getToken(), body: payload },
    );
    return parseStopCommand(response);
  },

  async completeTrip(
    id: string,
    payload: DriverTripCommandPayload,
  ): Promise<DriverTripStateCommandResponse> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(id)}/complete`,
      { method: "POST", token: await getToken(), body: payload },
    );
    return parseTripStateCommand(response);
  },
};
