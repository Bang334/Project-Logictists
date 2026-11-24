import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { driverGpsStorage } from '@/features/driver-tracking/storage/driver-gps.storage';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import type { DriverTrackingSession } from '@/features/driver-tracking/types/driver-tracking.types';
import { ApiError } from '@/shared/api/api-error';
import { readGpsCredential } from './driver-gps-authorization';
import { driverTrackingService } from './driver-tracking.service';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo-task-manager', () => ({
  isTaskDefined: jest.fn(), defineTask: jest.fn(), getRegisteredTasksAsync: jest.fn(),
  isTaskRegisteredAsync: jest.fn(), unregisterTaskAsync: jest.fn(),
}));
jest.mock('./driver-gps-authorization', () => ({ readGpsCredential: jest.fn() }));
jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied' },
  hasServicesEnabledAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  hasStartedLocationUpdatesAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
}));
jest.mock('@/features/driver-tracking/storage/driver-gps.storage', () => ({
  driverGpsStorage: {
    createOrRestoreSession: jest.fn(),
    getRestorableSession: jest.fn(),
    getRestorableSessions: jest.fn(),
    getCurrentSession: jest.fn(),
    appendLocations: jest.fn(),
    getBatch: jest.fn(),
    pendingCount: jest.fn(),
    removeSequences: jest.fn(),
    updateSession: jest.fn(),
    deleteSession: jest.fn(),
    getBinding: jest.fn(), getCapture: jest.fn(), enableCapture: jest.fn(),
    disableCapture: jest.fn(), revokeBindings: jest.fn(),
  },
}));
jest.mock('@/features/driver-tracking/storage/device-code.storage', () => ({
  deviceCodeStorage: { getOrCreate: jest.fn(async () => 'device-1') },
}));
jest.mock('./driver-gps-api.service', () => ({
  driverGpsApiService: { upload: jest.fn() },
}));
jest.mock('@/features/driver-trips/services/driver-trips.service', () => ({
  driverTripsService: { getTrip: jest.fn() },
}));

const activeSession: DriverTrackingSession = {
  userId: 'user-1',
  tripId: 'trip-1',
  deviceSessionId: 'session-existing',
  nextSequence: 4,
  state: 'ACTIVE',
  backgroundAllowed: false,
  createdAt: '2026-11-17T01:00:00.000Z',
  completedAt: null,
  lastSyncAt: null,
  lastAttemptAt: null,
  retryAfter: null,
  failureCount: 0,
  errorCode: null,
  warning: null,
};

describe('M3.6C driverTrackingService', () => {
  const remove = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Crypto.randomUUID).mockReturnValue(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    jest.mocked(TaskManager.isTaskDefined).mockReturnValue(true);
    jest.mocked(TaskManager.getRegisteredTasksAsync).mockResolvedValue([]);
    jest.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValue(false);
    jest.mocked(readGpsCredential).mockResolvedValue({
      token: 'jwt-primary', tag: 'tag-primary', expiresAt: Date.now() + 100_000,
    });
    let taskName: string | null = null;
    jest.mocked(driverGpsStorage.getBinding).mockImplementation(async () => ({
      task_name: taskName, token_tag: 'tag-primary', captured_after: 0,
    }));
    jest.mocked(driverGpsStorage.getCapture).mockResolvedValue(null);
    jest.mocked(driverGpsStorage.enableCapture).mockImplementation(async (_sessionId, name) => { taskName = name; });
    jest.mocked(driverGpsStorage.disableCapture).mockImplementation(async () => { taskName = null; });
    jest.mocked(Location.hasServicesEnabledAsync).mockResolvedValue(true);
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      expires: 'never',
    });
    jest.mocked(Location.getBackgroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      expires: 'never',
    });
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(false);
    jest.mocked(Location.startLocationUpdatesAsync).mockResolvedValue();
    jest.mocked(Location.stopLocationUpdatesAsync).mockResolvedValue();
    jest.mocked(Location.watchPositionAsync).mockResolvedValue({ remove });
    jest.mocked(driverGpsStorage.createOrRestoreSession).mockResolvedValue({
      ...activeSession,
    });
    jest.mocked(driverGpsStorage.getRestorableSession).mockResolvedValue({
      ...activeSession,
    });
    jest.mocked(driverGpsStorage.getRestorableSessions).mockResolvedValue([
      { ...activeSession },
    ]);
    jest.mocked(driverGpsStorage.getCurrentSession).mockResolvedValue({
      ...activeSession,
    });
    jest.mocked(driverGpsStorage.pendingCount).mockResolvedValue(0);
    jest.mocked(driverGpsStorage.getBatch).mockResolvedValue([]);
    jest.mocked(driverGpsStorage.updateSession).mockResolvedValue();
    jest.mocked(driverGpsStorage.deleteSession).mockResolvedValue();
    jest.mocked(driverGpsStorage.revokeBindings).mockResolvedValue();
    jest.mocked(driverTripsService.getTrip).mockResolvedValue({
      id: 'trip-1',
      status: 'IN_PROGRESS',
      assignment: { role: 'PRIMARY', status: 'ASSIGNED' },
      actualEndTime: null,
    } as never);
  });

  afterEach(async () => {
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(false);
    await driverTrackingService.cleanupOnLogout();
  });

  it('START success tạo/restore session rồi start background task một lần', async () => {
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    expect(driverGpsStorage.createOrRestoreSession).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'trip-1',
      '123e4567-e89b-42d3-a456-426614174000',
      'tag-primary',
    );
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it('foreground permission denied không start task nhưng Trip vẫn giữ session', async () => {
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: false,
      expires: 'never',
    });
    jest.mocked(Location.requestForegroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: false,
      expires: 'never',
    });
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(driverTrackingService.getSnapshot().mode).toBe('PERMISSION_DENIED');
  });

  it('background denied fallback sang foreground watcher', async () => {
    jest.mocked(Location.getBackgroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: false,
      expires: 'never',
    });
    jest.mocked(Location.requestBackgroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: false,
      expires: 'never',
    });
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    expect(Location.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(driverTrackingService.getSnapshot().mode).toBe('FOREGROUND_ONLY');
  });

  it('background granted xóa warning cũ của session', async () => {
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');

    expect(driverGpsStorage.updateSession).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        backgroundAllowed: true,
        errorCode: null,
        warning: null,
      }),
    );
  });

  it('không restore chồng khi luồng xin quyền còn đang mở', async () => {
    let resolveBackgroundPermission!: (value: Location.PermissionResponse) => void;
    jest.mocked(Location.getBackgroundPermissionsAsync).mockResolvedValue({
      status: Location.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: true,
      expires: 'never',
    });
    jest.mocked(Location.requestBackgroundPermissionsAsync).mockImplementation(
      () =>
        new Promise<Location.PermissionResponse>((resolve) => {
          resolveBackgroundPermission = resolve;
        }),
    );

    const beginPromise = driverTrackingService.beginAfterStart('user-1', 'trip-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalledTimes(1);
    await driverTrackingService.restoreForUser('user-1');

    expect(driverTripsService.getTrip).not.toHaveBeenCalled();

    resolveBackgroundPermission({
      status: Location.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      expires: 'never',
    });
    await beginPromise;
  });

  it('phục hồi khỏi SYNC_ERROR khi session đã đồng bộ thành công', async () => {
    jest.mocked(driverGpsStorage.getCurrentSession).mockResolvedValue({
      ...activeSession,
      errorCode: 'TRACKING_START_FAILED',
    });
    jest.mocked(Location.startLocationUpdatesAsync).mockRejectedValueOnce(
      new Error('temporary native error'),
    );
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    expect(driverTrackingService.getSnapshot().mode).toBe('SYNC_ERROR');

    jest.mocked(driverGpsStorage.getCurrentSession).mockResolvedValue({
      ...activeSession,
      backgroundAllowed: true,
      lastSyncAt: '2026-11-17T04:30:24.594Z',
      errorCode: null,
      warning: null,
    });
    await driverTrackingService.refresh();

    expect(driverTrackingService.getSnapshot().mode).toBe('BACKGROUND');
  });

  it('restore IN_PROGRESS dùng lại session và không tự start Trip', async () => {
    await driverTrackingService.restoreForUser('user-1');
    expect(driverTripsService.getTrip).toHaveBeenCalledWith('trip-1');
    expect(driverGpsStorage.createOrRestoreSession).not.toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it('restore COMPLETED dừng collection và flush backlog', async () => {
    jest.mocked(driverTripsService.getTrip).mockResolvedValue({
      id: 'trip-1',
      status: 'COMPLETED',
      actualEndTime: '2026-11-17T02:00:00.000Z',
    } as never);
    await driverTrackingService.restoreForUser('user-1');
    expect(driverGpsStorage.updateSession).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({ state: 'COMPLETED' }),
    );
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('COMPLETE success dừng lấy mẫu trước khi đánh dấu backlog', async () => {
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    await driverTrackingService.completeAfterSuccess(
      'user-1',
      'trip-1',
      '2026-11-17T02:00:00.000Z',
    );
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalled();
    expect(driverGpsStorage.updateSession).toHaveBeenCalledWith(
      'session-existing',
      expect.objectContaining({
        state: 'COMPLETED',
        completedAt: '2026-11-17T02:00:00.000Z',
      }),
    );
  });

  it('logout thu hồi binding và thử unregister nếu native stop thất bại', async () => {
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    jest.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValue(true);
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    jest.mocked(Location.stopLocationUpdatesAsync).mockRejectedValue(
      new Error('native stop failed'),
    );
    await expect(driverTrackingService.cleanupOnLogout()).rejects.toThrow(
      'native stop failed',
    );
    expect(driverGpsStorage.revokeBindings).toHaveBeenCalled();
    expect(TaskManager.unregisterTaskAsync).toHaveBeenCalled();
    expect(driverGpsStorage.deleteSession).not.toHaveBeenCalled();
    jest.mocked(Location.stopLocationUpdatesAsync).mockResolvedValue();
  });

  it('user switch dừng capture mà giữ queue owner cũ', async () => {
    jest.mocked(driverGpsStorage.getCurrentSession).mockResolvedValue({
      ...activeSession,
      userId: 'user-old',
    });
    jest.mocked(driverGpsStorage.getRestorableSession).mockResolvedValue(null);
    await driverTrackingService.restoreForUser('user-new');
    expect(driverGpsStorage.disableCapture).toHaveBeenCalled();
    expect(driverGpsStorage.deleteSession).not.toHaveBeenCalled();
  });

  it('rejects a callback from the previous native registration after a new login', async () => {
    const obsoleteTask = 'smart-tms-driver-location-old';
    await driverTrackingService.cleanupOnLogout();
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    const activeName = jest.mocked(Location.startLocationUpdatesAsync).mock.calls[0]?.[0];
    expect(activeName).toMatch(/^smart-tms-driver-location-/);
    expect(activeName).not.toBe(obsoleteTask);

    await driverTrackingService.collectFromTask(obsoleteTask, [{
      timestamp: Date.now(),
      coords: {
        latitude: 10.75, longitude: 106.7, altitude: null, accuracy: 3,
        altitudeAccuracy: null, heading: null, speed: null,
      },
    }]);
    expect(driverGpsStorage.getCapture).toHaveBeenCalledWith(obsoleteTask);
    expect(driverGpsStorage.appendLocations).not.toHaveBeenCalled();
  });

  it('unregisters a native task whose start resolves after logout began', async () => {
    let finishStart!: () => void;
    let markStarted!: () => void;
    const starting = new Promise<void>((resolve) => { markStarted = resolve; });
    jest.mocked(Location.startLocationUpdatesAsync).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishStart = resolve; markStarted(); });
    });

    const begin = driverTrackingService.beginAfterStart('user-1', 'trip-1');
    await starting;
    const [taskName] = jest.mocked(Location.startLocationUpdatesAsync).mock.calls[0]!;
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    const logout = driverTrackingService.cleanupOnLogout();
    finishStart();
    await Promise.all([begin, logout]);

    expect(driverGpsStorage.revokeBindings).toHaveBeenCalledTimes(1);
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(taskName);
    expect(driverGpsStorage.deleteSession).not.toHaveBeenCalled();
  });

  it('ends the capture for the Trip passed by COMPLETE_TRIP', async () => {
    await driverTrackingService.completeAfterSuccess('user-1', 'trip-1');

    expect(driverGpsStorage.getRestorableSession).toHaveBeenCalledWith('user-1', 'trip-1');
  });

  it('does not restore background capture when the assignment is RELIEF', async () => {
    jest.mocked(driverTripsService.getTrip).mockResolvedValue({
      id: 'trip-1',
      status: 'IN_PROGRESS',
      assignment: { role: 'RELIEF', status: 'ASSIGNED' },
    } as never);

    await driverTrackingService.restoreForUser('user-1');

    expect(driverGpsStorage.updateSession).toHaveBeenCalledWith('session-existing', { state: 'BLOCKED' });
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });
  it('stops capture and keeps the GPS queue when the assignment has been revoked', async () => {
    await driverTrackingService.beginAfterStart('user-1', 'trip-1');
    jest.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValue(true);
    jest.mocked(driverTripsService.getTrip).mockRejectedValue(new ApiError('Assignment revoked', 404, 'TRIP_NOT_FOUND'));

    await driverTrackingService.restoreForUser('user-1');

    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(driverGpsStorage.updateSession).toHaveBeenCalledWith(
      'session-existing', { state: 'BLOCKED', errorCode: 'TRIP_NOT_FOUND' },
    );
    expect(driverGpsStorage.deleteSession).not.toHaveBeenCalled();
  });

  it('does not restore a prior session with a fresh JWT for the same owner', async () => {
    jest.mocked(readGpsCredential).mockResolvedValue({
      token: 'new-jwt', tag: 'tag-new', expiresAt: Date.now() + 100_000,
    });

    await expect(driverTrackingService.restoreForUser('user-1')).resolves.toBe('NO_SESSION');

    expect(driverTripsService.getTrip).not.toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(driverGpsStorage.deleteSession).not.toHaveBeenCalled();
  });

  it('blocks an expired JWT before resolving or registering a Trip', async () => {
    jest.mocked(readGpsCredential).mockResolvedValue({
      token: 'old-jwt', tag: 'tag-primary', expiresAt: Date.now() - 1,
    });

    await expect(driverTrackingService.restoreForUser('user-1')).resolves.toBe('SKIPPED');

    expect(driverTrackingService.getSnapshot()).toMatchObject({ mode: 'BLOCKED', errorCode: 'HTTP_401' });
    expect(driverTripsService.getTrip).not.toHaveBeenCalled();
    expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});
