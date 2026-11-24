import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import type {
  DriverGpsUploadPoint,
  DriverGpsUploadResponse,
} from '@/features/driver-tracking/types/driver-tracking.types';

function invalidResponse(): never {
  throw new ApiError(
    'Phản hồi đồng bộ GPS không đúng định dạng.',
    0,
    'INVALID_RESPONSE',
  );
}

function parseResponse(value: unknown): DriverGpsUploadResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidResponse();
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.tripId !== 'string' ||
    typeof record.deviceSessionId !== 'string' ||
    typeof record.acceptedCount !== 'number' ||
    !Number.isInteger(record.acceptedCount) ||
    typeof record.duplicateCount !== 'number' ||
    !Number.isInteger(record.duplicateCount) ||
    typeof record.receivedAt !== 'string'
  ) {
    return invalidResponse();
  }
  return {
    tripId: record.tripId,
    deviceSessionId: record.deviceSessionId,
    acceptedCount: record.acceptedCount,
    duplicateCount: record.duplicateCount,
    receivedAt: record.receivedAt,
  };
}

export const driverGpsApiService = {
  async upload(
    tripId: string,
    deviceCode: string,
    deviceSessionId: string,
    points: DriverGpsUploadPoint[],
    token: string,
    signal: AbortSignal,
  ): Promise<DriverGpsUploadResponse> {
    const response = await apiClient.request(
      `/driver/trips/${encodeURIComponent(tripId)}/gps`,
      {
        method: 'POST',
        token,
        signal,
        body: { deviceCode, deviceSessionId, points },
      },
    );
    return parseResponse(response);
  },
};
