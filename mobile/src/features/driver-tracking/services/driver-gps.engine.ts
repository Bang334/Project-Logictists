import type { LocationObject } from 'expo-location';
import { ApiError } from '@/shared/api/api-error';
import type {
  DriverGpsPoint,
  DriverGpsUploadPoint,
  DriverGpsUploadResponse,
  DriverTrackingSession,
} from '@/features/driver-tracking/types/driver-tracking.types';

const UPLOAD_BATCH_SIZE = 20;
const UPLOAD_POINT_THRESHOLD = 5;
const UPLOAD_INTERVAL_MS = 45_000;
const COMPLETED_BACKLOG_WINDOW_MS = 30 * 60 * 1_000;
const MAX_BATCHES_PER_FLUSH = 10;

export interface DriverGpsEngineStorage {
  getRestorableSession(userId: string): Promise<DriverTrackingSession | null>;
  getRestorableSessions(userId: string): Promise<DriverTrackingSession[]>;
  getCurrentSession(): Promise<DriverTrackingSession | null>;
  appendLocations(
    session: DriverTrackingSession,
    locations: {
      latitude: number;
      longitude: number;
      accuracyM?: number;
      speedMps?: number;
      headingDeg?: number;
      measuredAt: string;
    }[],
    taskName: string,
  ): Promise<number[]>;
  getBatch(session: DriverTrackingSession, limit?: number): Promise<DriverGpsPoint[]>;
  pendingCount(session: DriverTrackingSession): Promise<number>;
  removeSequences(session: DriverTrackingSession, sequences: number[]): Promise<void>;
  updateSession(
    deviceSessionId: string,
    changes: Partial<{
      state: DriverTrackingSession['state'];
      completedAt: string | null;
      lastSyncAt: string | null;
      lastAttemptAt: string | null;
      retryAfter: string | null;
      failureCount: number;
      errorCode: string | null;
      warning: string | null;
    }>,
  ): Promise<void>;
  deleteSession(deviceSessionId: string): Promise<void>;
}

interface DriverGpsEngineDependencies {
  storage: DriverGpsEngineStorage;
  getDeviceCode(): Promise<string>;
  upload(
    tripId: string,
    deviceCode: string,
    deviceSessionId: string,
    points: DriverGpsUploadPoint[],
    token: string,
    signal: AbortSignal,
  ): Promise<DriverGpsUploadResponse>;
  authorize(session: DriverTrackingSession, signal: AbortSignal): Promise<string | null>;
  stopCollection(session: DriverTrackingSession, signal: AbortSignal): Promise<void>;
  onChanged(): void;
  onLocationsCollected?(session: DriverTrackingSession, points: NonNullable<ReturnType<typeof mapLocation>>[]): void;
  now(): Date;
}

function optionalFiniteNonNegative(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalHeading(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360
    ? value
    : undefined;
}

export function mapLocation(location: LocationObject) {
  const { latitude, longitude } = location.coords;
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(location.timestamp)
  ) {
    return null;
  }
  return {
    latitude,
    longitude,
    ...optionalValue('accuracyM', optionalFiniteNonNegative(location.coords.accuracy)),
    ...optionalValue('speedMps', optionalFiniteNonNegative(location.coords.speed)),
    ...optionalValue('headingDeg', optionalHeading(location.coords.heading)),
    measuredAt: new Date(location.timestamp).toISOString(),
  };
}

function optionalValue<Key extends string>(key: Key, value: number | undefined) {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, number>);
}

function toUploadPoint(point: DriverGpsPoint): DriverGpsUploadPoint {
  return {
    sequence: point.sequence,
    latitude: point.latitude,
    longitude: point.longitude,
    ...(point.accuracyM === undefined ? {} : { accuracyM: point.accuracyM }),
    ...(point.speedMps === undefined ? {} : { speedMps: point.speedMps }),
    ...(point.headingDeg === undefined ? {} : { headingDeg: point.headingDeg }),
    measuredAt: point.measuredAt,
  };
}

function retryDelayMs(failureCount: number): number {
  return Math.min(5 * 60_000, 15_000 * 2 ** Math.min(failureCount, 5));
}

export class DriverGpsEngine {
  private flight: { userId: string; signal: AbortSignal; promise: Promise<void> } | null = null;

  constructor(private readonly dependencies: DriverGpsEngineDependencies) {}

  async collect(
    session: DriverTrackingSession,
    taskName: string,
    capturedAfter: number,
    locations: LocationObject[],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || session.state !== 'ACTIVE' ||
        !(await this.dependencies.authorize(session, signal)) || signal.aborted) return;
    const mapped = locations.filter((location) => location.timestamp >= capturedAfter)
      .map(mapLocation).filter((point) => point !== null);
    if (mapped.length === 0) return;
    const sequences = await this.dependencies.storage.appendLocations(session, mapped, taskName);
    if (signal.aborted || sequences.length === 0) return;
    this.dependencies.onLocationsCollected?.(session, mapped);
    this.dependencies.onChanged();

    const pending = await this.dependencies.storage.pendingCount(session);
    const lastAttempt = session.lastAttemptAt
      ? new Date(session.lastAttemptAt).getTime()
      : 0;
    if (
      pending >= UPLOAD_POINT_THRESHOLD ||
      this.dependencies.now().getTime() - lastAttempt >= UPLOAD_INTERVAL_MS
    ) {
      await this.flush(session.userId, signal);
    }
  }

  async flush(userId: string, signal: AbortSignal, ignoreBackoff = false): Promise<void> {
    if (signal.aborted) return;
    if (this.flight?.signal === signal && this.flight.userId === userId) return this.flight.promise;
    const promise = this.flushInternal(userId, signal, ignoreBackoff).finally(() => {
      if (this.flight?.promise === promise) this.flight = null;
    });
    this.flight = { userId, signal, promise };
    return promise;
  }

  private async flushInternal(userId: string, signal: AbortSignal, ignoreBackoff: boolean): Promise<void> {
    const sessions = await this.dependencies.storage.getRestorableSessions(userId);
    for (const session of sessions) {
      if (signal.aborted) return;
      await this.flushSession(session, signal, ignoreBackoff);
    }
  }

  private async flushSession(
    session: DriverTrackingSession,
    signal: AbortSignal,
    ignoreBackoff: boolean,
  ): Promise<void> {
    if (signal.aborted || !(await this.dependencies.authorize(session, signal)) || signal.aborted) return;
    const now = this.dependencies.now();
    if (
      session.state === 'COMPLETED' &&
      session.completedAt &&
      now.getTime() - new Date(session.completedAt).getTime() >
        COMPLETED_BACKLOG_WINDOW_MS
    ) {
      await this.dependencies.storage.deleteSession(session.deviceSessionId);
      this.dependencies.onChanged();
      return;
    }
    if (
      !ignoreBackoff &&
      session.retryAfter &&
      new Date(session.retryAfter).getTime() > now.getTime()
    ) {
      return;
    }

    const deviceCode = await this.dependencies.getDeviceCode();
    for (let index = 0; index < MAX_BATCHES_PER_FLUSH; index += 1) {
      const batch = await this.dependencies.storage.getBatch(session, UPLOAD_BATCH_SIZE);
      if (signal.aborted) return;
      if (batch.length === 0) {
        if (session.state === 'COMPLETED') {
          await this.dependencies.storage.deleteSession(session.deviceSessionId);
        }
        this.dependencies.onChanged();
        return;
      }
      const attemptAt = this.dependencies.now();
      await this.dependencies.storage.updateSession(session.deviceSessionId, {
        lastAttemptAt: attemptAt.toISOString(),
      });
      try {
        const token = await this.dependencies.authorize(session, signal);
        if (!token || signal.aborted) return;
        const response = await this.dependencies.upload(
          session.tripId,
          deviceCode,
          session.deviceSessionId,
          batch.map(toUploadPoint),
          token,
          signal,
        );
        if (signal.aborted || !(await this.dependencies.authorize(session, signal)) || signal.aborted) return;
        if (
          response.tripId !== session.tripId ||
          response.deviceSessionId !== session.deviceSessionId ||
          response.acceptedCount + response.duplicateCount !== batch.length
        ) {
          throw new ApiError(
            'Máy chủ xác nhận batch GPS không nhất quán.',
            0,
            'INVALID_RESPONSE',
          );
        }
        await this.dependencies.storage.removeSequences(
          session,
          batch.map((point) => point.sequence),
        );
        await this.dependencies.storage.updateSession(session.deviceSessionId, {
          lastSyncAt: response.receivedAt,
          retryAfter: null,
          failureCount: 0,
          errorCode: null,
        });
        this.dependencies.onChanged();
      } catch (error) {
        if (!signal.aborted && await this.dependencies.authorize(session, signal) && !signal.aborted) {
          await this.handleUploadError(session, batch, error, signal);
        }
        return;
      }
    }
  }

  private async handleUploadError(
    session: DriverTrackingSession,
    batch: DriverGpsPoint[],
    error: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    if (!(error instanceof ApiError)) {
      await this.setBackoff(session, 'NETWORK_ERROR');
      return;
    }
    if (error.status === 0) {
      await this.setBackoff(session, error.code);
      return;
    }
    if (error.status === 400) {
      await this.dependencies.storage.removeSequences(
        session,
        batch.map((point) => point.sequence),
      );
      await this.dependencies.storage.updateSession(session.deviceSessionId, {
        errorCode: error.code,
        warning: 'GPS_INVALID_BATCH_DROPPED',
      });
      this.dependencies.onChanged();
      return;
    }
    if (
      error.status === 401 ||
      error.status === 404 ||
      (error.status === 409 &&
        ['DRIVER_NOT_PRIMARY', 'GPS_TRACKING_NOT_ALLOWED', 'TRACKING_SESSION_CONFLICT'].includes(
          error.code,
        ))
    ) {
      await this.dependencies.storage.updateSession(session.deviceSessionId, {
        state: 'BLOCKED',
        errorCode: error.code,
        retryAfter: null,
      });
      await this.dependencies.stopCollection(session, signal);
      this.dependencies.onChanged();
      return;
    }
    await this.setBackoff(session, error.code);
  }

  private async setBackoff(
    session: DriverTrackingSession,
    errorCode: string,
  ): Promise<void> {
    const failures = session.failureCount + 1;
    await this.dependencies.storage.updateSession(session.deviceSessionId, {
      failureCount: failures,
      errorCode,
      retryAfter: new Date(
        this.dependencies.now().getTime() + retryDelayMs(failures),
      ).toISOString(),
    });
    this.dependencies.onChanged();
  }
}
