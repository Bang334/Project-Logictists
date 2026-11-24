import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import { tokenStorage } from '@/shared/storage/token-storage';
import type {
  DriverDeliveryResult,
  DriverPodCollection,
  DriverPodEvidenceType,
  DriverPodFile,
  DriverPodLocalFile,
  DriverPodUploadStatus,
  DriverPodView,
} from '@/features/driver-trips/types/driver-trip.types';

const EVIDENCE_TYPES = ['PHOTO', 'SIGNATURE'] as const;
const UPLOAD_STATUSES = [
  'PENDING',
  'UPLOADING',
  'UPLOADED',
  'FAILED',
] as const;
const DELIVERY_RESULTS = ['SUCCESS', 'PARTIAL', 'FAILED'] as const;

function invalidResponse(): never {
  throw new ApiError(
    'Dữ liệu POD từ máy chủ không đúng định dạng.',
    0,
    'INVALID_RESPONSE',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && allowed.includes(value as T);
}

function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : invalidResponse();
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' || value === null
    ? value
    : invalidResponse();
}

function requiredBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalidResponse();
}

function parsePodFile(value: unknown): DriverPodFile {
  if (
    !isRecord(value) ||
    !isOneOf(value.evidenceType, EVIDENCE_TYPES) ||
    !isOneOf(value.uploadStatus, UPLOAD_STATUSES) ||
    !['image/jpeg', 'image/png'].includes(String(value.mediaType)) ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isInteger(value.sizeBytes) ||
    value.sizeBytes < 0
  ) {
    return invalidResponse();
  }
  return {
    id: requiredString(value.id),
    evidenceType: value.evidenceType as DriverPodEvidenceType,
    mediaType: value.mediaType as DriverPodFile['mediaType'],
    sizeBytes: value.sizeBytes,
    uploadStatus: value.uploadStatus as DriverPodUploadStatus,
    capturedAt: nullableString(value.capturedAt),
    uploadedAt: nullableString(value.uploadedAt),
    supersedesId: nullableString(value.supersedesId),
    isSuperseded: requiredBoolean(value.isSuperseded),
  };
}

function parsePodCollection(value: unknown): DriverPodCollection {
  if (
    !isRecord(value) ||
    !isRecord(value.deliveryAttempt) ||
    !isRecord(value.requirements) ||
    !Array.isArray(value.items) ||
    !isOneOf(value.deliveryAttempt.result, DELIVERY_RESULTS)
  ) {
    return invalidResponse();
  }
  return {
    deliveryAttempt: {
      id: requiredString(value.deliveryAttempt.id),
      result: value.deliveryAttempt.result as DriverDeliveryResult,
      recipientName: nullableString(value.deliveryAttempt.recipientName),
    },
    requirements: {
      photoRequired: requiredBoolean(value.requirements.photoRequired),
      photoUploaded: requiredBoolean(value.requirements.photoUploaded),
      recipientRequired: requiredBoolean(value.requirements.recipientRequired),
      recipientSatisfied: requiredBoolean(
        value.requirements.recipientSatisfied,
      ),
      podSatisfied: requiredBoolean(value.requirements.podSatisfied),
    },
    items: value.items.map(parsePodFile),
  };
}

async function getToken(): Promise<string> {
  const token = await tokenStorage.get();
  if (!token) {
    throw new ApiError(
      'Phiên đăng nhập không còn tồn tại.',
      401,
      'HTTP_401',
    );
  }
  return token;
}

function podPath(tripId: string, stopId: string, attemptId: string) {
  return `/driver/trips/${encodeURIComponent(tripId)}/stops/${encodeURIComponent(stopId)}/delivery-attempts/${encodeURIComponent(attemptId)}/pod`;
}

export const driverPodService = {
  async getPod(
    tripId: string,
    stopId: string,
    attemptId: string,
  ): Promise<DriverPodCollection> {
    const response = await apiClient.request(
      podPath(tripId, stopId, attemptId),
      { token: await getToken() },
    );
    return parsePodCollection(response);
  },

  async uploadPod(
    tripId: string,
    stopId: string,
    attemptId: string,
    evidenceType: DriverPodEvidenceType,
    file: DriverPodLocalFile,
    capturedAt: string,
    idempotencyKey: string,
    supersedesId?: string,
  ): Promise<DriverPodFile> {
    const fields: Record<string, string> = {
      evidenceType,
      capturedAt,
      idempotencyKey,
    };
    if (supersedesId) fields.supersedesId = supersedesId;
    const response = await apiClient.uploadMultipartFile(
      podPath(tripId, stopId, attemptId),
      {
        token: await getToken(),
        fileUri: file.uri,
        mediaType: file.mediaType,
        fields,
        timeoutMs: 30_000,
      },
    );
    return parsePodFile(response);
  },

  async getPodView(
    tripId: string,
    stopId: string,
    attemptId: string,
    podFileId: string,
  ): Promise<DriverPodView> {
    const response = await apiClient.request(
      `${podPath(tripId, stopId, attemptId)}/${encodeURIComponent(podFileId)}/view`,
      { token: await getToken() },
    );
    if (!isRecord(response)) return invalidResponse();
    return {
      id: requiredString(response.id),
      url: requiredString(response.url),
      expiresAt: requiredString(response.expiresAt),
    };
  },
};
