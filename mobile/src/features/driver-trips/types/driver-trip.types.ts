export const DRIVER_TRIP_STATUSES = [
  "DISPATCHED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

export type DriverTripStatus = (typeof DRIVER_TRIP_STATUSES)[number];
export type DriverTripStatusFilter = DriverTripStatus | "ALL";

export const DRIVER_STOP_STATUSES = [
  "PENDING",
  "ARRIVED",
  "COMPLETED",
  "SKIPPED",
] as const;

export type DriverStopStatus = (typeof DRIVER_STOP_STATUSES)[number];
export type DriverStopType =
  "PICKUP" | "DELIVERY" | "DEPOT_START" | "DEPOT_END";
export type DriverTaskAction = "LOAD" | "UNLOAD";

export type DriverPackageStatus =
  | "DRAFT"
  | "READY"
  | "ALLOCATED"
  | "LOADED"
  | "DELIVERED"
  | "DAMAGED"
  | "CANCELLED";

export interface DriverTripVehicle {
  payloadCapacityKg?: number;
  volumeCapacityM3?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  id: string;
  plateNumber: string;
  model: string;
  vehicleType: string;
}

export interface DriverTripAssignment {
  id: string;
  role: string;
  status: string;
  startTime: string;
  endTime: string;
}

export interface DriverTripSummary {
  calendarAssignments?: DriverTripAssignment[];
  id: string;
  tripNumber: string;
  status: DriverTripStatus;
  version: number;
  plannedStartTime: string;
  plannedEndTime: string;
  actualStartTime: string | null;
  actualEndTime: string | null;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  vehicle: DriverTripVehicle;
  assignment: DriverTripAssignment;
  stopCount: number;
}

export type DriverHistoryStatus = 'COMPLETED' | 'CANCELLED';
export interface DriverTripDateRange { from: string; to: string }
export interface DriverActivitySummary {
  range: DriverTripDateRange;
  timeZone: string;
  asOf: string;
  completedTripCount: number | null;
  processedStopCount: number | null;
  depotStopCount: number | null;
  deliveries: { success: number; partial: number; failed: number; unclassified: number } | null;
  coverage: { status: 'COMPLETE' | 'PARTIAL' | 'NO_DATA' };
}
export interface DriverHistoryItem {
  tripId: string;
  tripNumber: string;
  status: DriverHistoryStatus;
  historyAt: string;
  dateBasis: 'ACTUAL_END' | 'PLANNED_START';
  vehicle: DriverTripVehicle;
  stopCount: number;
  processedStops: number;
  loadTaskCount: number;
  unloadTaskCount: number;
  loadedQuantity: number | null;
  unloadedQuantity: number | null;
  distinctPackageCount: number;
  successAttempts: number;
  partialAttempts: number;
  failedAttempts: number;
}
export interface DriverHistoryPage { items: DriverHistoryItem[]; nextCursor: string | null }

export interface DriverTripPage {
  items: DriverTripSummary[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface DriverTripOrderReference {
  id: string;
  orderNumber: string;
}

export interface DriverTripPackage {
  id: string;
  packageCode: string;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  status: DriverPackageStatus;
}

export interface DriverStopTask {
  id: string;
  action: DriverTaskAction;
  plannedQuantity: number;
  actualQuantity: number | null;
  order: DriverTripOrderReference | null;
  package: DriverTripPackage | null;
}

export interface DriverTripStop {
  id: string;
  sequence: number;
  stopType: DriverStopType;
  status: DriverStopStatus;
  address: string;
  latitude: number;
  longitude: number;
  contactName: string | null;
  contactPhone: string | null;
  plannedArrivalTime: string | null;
  plannedDepartureTime: string | null;
  actualArrivalTime: string | null;
  actualDepartureTime: string | null;
  deliveryAttempt?: {
    id: string;
    attemptNumber: number;
    result: DriverDeliveryResult;
    recipientName: string | null;
  } | null;
  tasks: DriverStopTask[];
}

export interface DriverTripDetail extends DriverTripSummary {
  stops: DriverTripStop[];
}

export const DRIVER_EXECUTION_REASON_CODES = [
  "PACKAGE_NOT_AVAILABLE",
  "PACKAGE_DAMAGED",
  "QUANTITY_MISMATCH",
  "RECIPIENT_UNAVAILABLE",
  "RECIPIENT_REFUSED",
  "ADDRESS_ISSUE",
  "ACCESS_RESTRICTED",
  "OTHER",
] as const;

export type DriverExecutionReasonCode =
  (typeof DRIVER_EXECUTION_REASON_CODES)[number];

export type DriverDeliveryResult = "SUCCESS" | "PARTIAL" | "FAILED";

export interface DriverTripCommandPayload {
  idempotencyKey: string;
  expectedTripVersion: number;
}

export interface DriverStopCommandPayload extends DriverTripCommandPayload {
  occurredAt: string;
}

export interface DriverTaskExecutionPayload {
  taskId: string;
  actualQuantity: number;
}

export interface CompleteDriverStopPayload extends DriverStopCommandPayload {
  tasks: DriverTaskExecutionPayload[];
  deliveryResult?: DriverDeliveryResult | null;
  reasonCode?: DriverExecutionReasonCode | null;
  note?: string | null;
  recipientName?: string | null;
}

export interface DriverTripStateCommandResponse {
  id: string;
  status: DriverTripStatus;
  version: number;
  actualStartTime?: string;
  actualEndTime?: string;
}

export interface DriverStopCommandResponse {
  tripId: string;
  tripVersion: number;
  eventType?: string;
  stop: {
    id: string;
    status: DriverStopStatus;
    actualArrivalTime?: string;
    actualDepartureTime?: string;
  };
  deliveryAttempt?: {
    id: string;
    attemptNumber: number;
    result: DriverDeliveryResult;
  } | null;
}

export type DriverPodEvidenceType = "PHOTO" | "SIGNATURE";
export type DriverPodUploadStatus =
  "PENDING" | "UPLOADING" | "UPLOADED" | "FAILED";

export interface DriverPodFile {
  id: string;
  evidenceType: DriverPodEvidenceType;
  mediaType: "image/jpeg" | "image/png";
  sizeBytes: number;
  uploadStatus: DriverPodUploadStatus;
  capturedAt: string | null;
  uploadedAt: string | null;
  supersedesId: string | null;
  isSuperseded: boolean;
}

export interface DriverPodView {
  id: string;
  url: string;
  expiresAt: string;
}

export interface DriverPodRequirements {
  photoRequired: boolean;
  photoUploaded: boolean;
  recipientRequired: boolean;
  recipientSatisfied: boolean;
  podSatisfied: boolean;
}

export interface DriverPodCollection {
  deliveryAttempt: {
    id: string;
    result: DriverDeliveryResult;
    recipientName: string | null;
  };
  requirements: DriverPodRequirements;
  items: DriverPodFile[];
}

export interface DriverPodLocalFile {
  uri: string;
  name: string;
  mediaType: "image/jpeg" | "image/png";
  sizeBytes?: number;
}
