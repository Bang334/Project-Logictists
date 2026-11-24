import type { LocationObject } from 'expo-location';
import { ApiError } from '@/shared/api/api-error';
import {
  DriverGpsEngine,
  mapLocation,
  type DriverGpsEngineStorage,
} from './driver-gps.engine';
import type {
  DriverGpsPoint,
  DriverGpsUploadPoint,
  DriverGpsUploadResponse,
  DriverTrackingSession,
} from '@/features/driver-tracking/types/driver-tracking.types';

function session(overrides: Partial<DriverTrackingSession> = {}): DriverTrackingSession {
  return {
    userId: 'user-1',
    tripId: 'trip-1',
    deviceSessionId: 'session-1',
    nextSequence: 1,
    state: 'ACTIVE',
    backgroundAllowed: true,
    createdAt: '2026-11-17T01:00:00.000Z',
    completedAt: null,
    lastSyncAt: null,
    lastAttemptAt: null,
    retryAfter: null,
    failureCount: 0,
    errorCode: null,
    warning: null,
    ...overrides,
  };
}

function location(index = 0): LocationObject {
  return {
    coords: {
      latitude: 10.7 + index / 1000,
      longitude: 106.6 + index / 1000,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: 90,
      speed: 5,
    },
    timestamp: Date.parse('2026-11-17T02:00:00.000Z') + index * 15_000,
  };
}

class FakeStorage implements DriverGpsEngineStorage {
  current: DriverTrackingSession | null = session();
  points: DriverGpsPoint[] = [];
  deleted = false;

  async getRestorableSession(userId: string) {
    return this.current?.userId === userId ? this.current : null;
  }
  async getRestorableSessions(userId: string) {
    return this.current?.userId === userId ? [this.current] : [];
  }
  async getCurrentSession() {
    return this.current;
  }
  async appendLocations(
    active: DriverTrackingSession,
    locations: Parameters<DriverGpsEngineStorage['appendLocations']>[1],
  ) {
    const sequences: number[] = [];
    for (const item of locations) {
      const sequence = active.nextSequence++;
      sequences.push(sequence);
      this.points.push({
        ...item,
        userId: active.userId,
        tripId: active.tripId,
        deviceSessionId: active.deviceSessionId,
        sequence,
        createdAt: item.measuredAt,
      });
    }
    return sequences;
  }
  async getBatch(active: DriverTrackingSession, limit = 20) {
    return this.points
      .filter((point) => point.deviceSessionId === active.deviceSessionId)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
  }
  async pendingCount(active: DriverTrackingSession) {
    return this.points.filter(
      (point) => point.deviceSessionId === active.deviceSessionId,
    ).length;
  }
  async removeSequences(_active: DriverTrackingSession, sequences: number[]) {
    this.points = this.points.filter((point) => !sequences.includes(point.sequence));
  }
  async updateSession(
    _deviceSessionId: string,
    changes: Parameters<DriverGpsEngineStorage['updateSession']>[1],
  ) {
    if (this.current) Object.assign(this.current, changes);
  }
  async deleteSession() {
    this.deleted = true;
    this.points = [];
    this.current = null;
  }
}

function setup(storage = new FakeStorage()) {
  const upload = jest.fn<
    Promise<DriverGpsUploadResponse>,
    [string, string, string, DriverGpsUploadPoint[], string, AbortSignal]
  >(async () => ({
    tripId: 'trip-1',
    deviceSessionId: 'session-1',
    acceptedCount: 0,
    duplicateCount: 0,
    receivedAt: '2026-11-17T02:10:00.000Z',
  }));
  const stopCollection = jest.fn(async () => undefined);
  let now = new Date('2026-11-17T02:10:00.000Z');
  const authorize = jest.fn<Promise<string | null>, [DriverTrackingSession, AbortSignal]>(async () => 'jwt-owner');
  const controller = new AbortController();
  const engine = new DriverGpsEngine({
    storage,
    getDeviceCode: async () => 'device-1',
    upload,
    authorize,
    stopCollection,
    onChanged: jest.fn(),
    now: () => now,
  });
  return {
    engine, storage, upload, stopCollection, authorize, controller,
    collect: (locations: LocationObject[], capturedAfter = 0) =>
      engine.collect(storage.current ?? session(), 'task-1', capturedAfter, locations, controller.signal),
    flush: (ignoreBackoff = false) => engine.flush('user-1', controller.signal, ignoreBackoff),
    setNow: (value: Date) => (now = value),
  };
}

describe('M3.6C DriverGpsEngine', () => {
  it('map location không gửi altitude và loại số không hữu hạn', () => {
    expect(mapLocation(location())).toEqual({
      latitude: 10.7,
      longitude: 106.6,
      accuracyM: 8,
      speedMps: 5,
      headingDeg: 90,
      measuredAt: '2026-11-17T02:00:00.000Z',
    });
    const invalid = location();
    invalid.coords.latitude = Number.NaN;
    expect(mapLocation(invalid)).toBeNull();
  });

  it('sequence tăng liên tục qua nhiều callback', async () => {
    const { collect, storage } = setup();
    storage.current!.lastAttemptAt = '2026-11-17T02:09:50.000Z';
    await collect([location(0), location(1)]);
    await collect([location(2)]);
    expect(storage.points.map((point) => point.sequence)).toEqual([1, 2, 3]);
    expect(storage.current?.nextSequence).toBe(4);
  });

  it('đủ 5 point thì upload theo sequence và cleanup accepted/duplicate', async () => {
    const { collect, storage, upload } = setup();
    upload.mockImplementation(async (_trip, _device, _session, points) => ({
      tripId: 'trip-1',
      deviceSessionId: 'session-1',
      acceptedCount: 3,
      duplicateCount: 2,
      receivedAt: '2026-11-17T02:10:00.000Z',
    }));
    await collect(Array.from({ length: 5 }, (_, index) => location(index)));
    expect(upload.mock.calls[0]?.[3].map((point) => point.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(storage.points).toHaveLength(0);
    expect(storage.current?.lastSyncAt).toBe('2026-11-17T02:10:00.000Z');
  });

  it('mỗi request tối đa 20 point và giữ thứ tự', async () => {
    const { collect, storage, upload } = setup();
    upload.mockImplementation(async (_trip, _device, _session, points) => ({
      tripId: 'trip-1',
      deviceSessionId: 'session-1',
      acceptedCount: points.length,
      duplicateCount: 0,
      receivedAt: '2026-11-17T02:10:00.000Z',
    }));
    storage.current!.lastAttemptAt = '2026-11-17T02:09:50.000Z';
    await collect(Array.from({ length: 25 }, (_, index) => location(index)));
    expect(upload.mock.calls.map((call) => call[3].length)).toEqual([20, 5]);
  });

  it('network error giữ queue và đặt backoff, không tự retry liên tục', async () => {
    const { flush, storage, upload } = setup();
    storage.points = [
      { ...mapLocation(location())!, userId: 'user-1', tripId: 'trip-1', deviceSessionId: 'session-1', sequence: 1, createdAt: '2026-11-17T02:00:00.000Z' },
    ];
    upload.mockRejectedValue(new ApiError('Mất mạng', 0, 'NETWORK_ERROR'));
    await flush();
    await flush();
    expect(storage.points).toHaveLength(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(storage.current?.retryAfter).not.toBeNull();
  });

  it.each([
    [401, 'HTTP_401'],
    [404, 'HTTP_404'],
    [409, 'DRIVER_NOT_PRIMARY'],
    [409, 'GPS_TRACKING_NOT_ALLOWED'],
    [409, 'TRACKING_SESSION_CONFLICT'],
  ])('business error %s/%s dừng session', async (status, code) => {
    const { flush, storage, upload, stopCollection } = setup();
    storage.points = [
      { ...mapLocation(location())!, userId: 'user-1', tripId: 'trip-1', deviceSessionId: 'session-1', sequence: 1, createdAt: '2026-11-17T02:00:00.000Z' },
    ];
    upload.mockRejectedValue(new ApiError('Business error', status, code));
    await flush(true);
    expect(storage.current?.state).toBe('BLOCKED');
    expect(stopCollection).toHaveBeenCalledTimes(1);
  });

  it('400 loại batch độc hại để không retry vô hạn', async () => {
    const { flush, storage, upload } = setup();
    storage.points = [
      { ...mapLocation(location())!, userId: 'user-1', tripId: 'trip-1', deviceSessionId: 'session-1', sequence: 1, createdAt: '2026-11-17T02:00:00.000Z' },
    ];
    upload.mockRejectedValue(new ApiError('Invalid', 400, 'GPS_TIMESTAMP_INVALID'));
    await flush(true);
    expect(storage.points).toHaveLength(0);
    expect(storage.current?.warning).toBe('GPS_INVALID_BATCH_DROPPED');
  });

  it('duplicate upload không tạo GPS sample hoặc sequence mới', async () => {
    const { flush, storage, upload } = setup();
    storage.points = [
      { ...mapLocation(location())!, userId: 'user-1', tripId: 'trip-1', deviceSessionId: 'session-1', sequence: 1, createdAt: '2026-11-17T02:00:00.000Z' },
    ];
    upload.mockResolvedValue({
      tripId: 'trip-1',
      deviceSessionId: 'session-1',
      acceptedCount: 0,
      duplicateCount: 1,
      receivedAt: '2026-11-17T02:10:00.000Z',
    });
    await flush(true);
    await flush(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(storage.current?.nextSequence).toBe(1);
  });

  it('backlog COMPLETED quá 30 phút được cleanup và không upload', async () => {
    const storage = new FakeStorage();
    storage.current = session({
      state: 'COMPLETED',
      completedAt: '2026-11-17T01:00:00.000Z',
    });
    const { flush, upload } = setup(storage);
    await flush(true);
    expect(storage.deleted).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });

  it('không log JWT hoặc tọa độ trong luồng upload', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { collect } = setup();
    await collect([location()]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});


describe('M5.8.3 GPS ownership fences', () => {
  it('discards cached samples from before capture activation', async () => {
    const { collect, storage } = setup();
    storage.current!.lastAttemptAt = '2026-11-17T02:09:50.000Z';
    await collect([location(0), location(1)], location(1).timestamp);
    expect(storage.points.map((point) => point.measuredAt)).toEqual([mapLocation(location(1))?.measuredAt]);
  });

  it('cancels a callback whose authorization resolves after logout', async () => {
    const { collect, storage, authorize, controller, upload } = setup();
    let resolve!: (token: string) => void;
    authorize.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const collecting = collect([location()]);
    controller.abort();
    resolve('old-owner-token');
    await collecting;
    expect(storage.points).toHaveLength(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it('leaves the old queue intact when a JWT cannot authorize its owner', async () => {
    const { collect, flush, storage, authorize, upload } = setup();
    storage.current!.lastAttemptAt = '2026-11-17T02:09:50.000Z';
    await collect([location()]);
    authorize.mockResolvedValue(null);
    await flush(true);
    expect(storage.points).toHaveLength(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('ignores an old HTTP response after logout and preserves the old sequence', async () => {
    const { collect, flush, storage, controller, upload, stopCollection } = setup();
    storage.current!.lastAttemptAt = '2026-11-17T02:09:50.000Z';
    await collect([location()]);
    let reject!: (error: Error) => void;
    upload.mockImplementationOnce(() => new Promise((_resolve, done) => { reject = done; }));
    const sending = flush(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(upload.mock.calls[0]?.slice(4)).toEqual(['jwt-owner', controller.signal]);
    controller.abort();
    reject(new ApiError('Expired', 401, 'HTTP_401'));
    await sending;
    expect(storage.points.map((point) => point.sequence)).toEqual([1]);
    expect(storage.current?.state).toBe('ACTIVE');
    expect(stopCollection).not.toHaveBeenCalled();
  });
});
