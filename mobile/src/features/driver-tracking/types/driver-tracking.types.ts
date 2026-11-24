export type DriverTrackingMode =
  | 'IDLE'
  | 'RESTORING'
  | 'BACKGROUND'
  | 'FOREGROUND_ONLY'
  | 'PERMISSION_DENIED'
  | 'LOCATION_DISABLED'
  | 'SYNC_ERROR'
  | 'BLOCKED'
  | 'STOPPED';

export type DriverTrackingSessionState = 'ACTIVE' | 'COMPLETED' | 'BLOCKED';

export interface DriverTrackingSession {
  userId: string;
  tripId: string;
  deviceSessionId: string;
  nextSequence: number;
  state: DriverTrackingSessionState;
  backgroundAllowed: boolean;
  createdAt: string;
  completedAt: string | null;
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  retryAfter: string | null;
  failureCount: number;
  errorCode: string | null;
  warning: string | null;
}

export interface DriverGpsPoint {
  userId: string;
  tripId: string;
  deviceSessionId: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  measuredAt: string;
  createdAt: string;
}

export interface DriverGpsUploadPoint {
  sequence: number;
  latitude: number;
  longitude: number;
  accuracyM?: number;
  speedMps?: number;
  headingDeg?: number;
  measuredAt: string;
}

export interface DriverGpsUploadResponse {
  tripId: string;
  deviceSessionId: string;
  acceptedCount: number;
  duplicateCount: number;
  receivedAt: string;
}

export interface DriverTrackingSnapshot {
  mode: DriverTrackingMode;
  tripId: string | null;
  pendingCount: number;
  lastSyncAt: string | null;
  errorCode: string | null;
  warning: string | null;
  latestLocalLocation?: DriverLocalLocation | null;
}

export interface DriverLocalLocation {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  headingDeg?: number;
  measuredAt: string;
}

export const EMPTY_TRACKING_SNAPSHOT: DriverTrackingSnapshot = {
  mode: 'IDLE',
  tripId: null,
  pendingCount: 0,
  lastSyncAt: null,
  errorCode: null,
  warning: null,
  latestLocalLocation: null,
};
