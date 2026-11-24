import { Linking, PermissionsAndroid, Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as Location from 'expo-location';
import type { LocationObject, LocationSubscription } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { ApiError } from '@/shared/api/api-error';
import { deviceCodeStorage } from '@/features/driver-tracking/storage/device-code.storage';
import { driverGpsStorage } from '@/features/driver-tracking/storage/driver-gps.storage';
import { driverGpsApiService } from './driver-gps-api.service';
import { DriverGpsEngine, mapLocation } from './driver-gps.engine';
import {
  EMPTY_TRACKING_SNAPSHOT,
  type DriverTrackingMode,
  type DriverLocalLocation,
  type DriverTrackingSession,
  type DriverTrackingSnapshot,
} from '@/features/driver-tracking/types/driver-tracking.types';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';

import { readGpsCredential } from './driver-gps-authorization';
import {
  defineDriverLocationTask, DRIVER_LOCATION_TASK, isDriverLocationTask,
} from '@/features/driver-tracking/tasks/driver-location.registration';

export type DriverTrackingRestoreResult =
  | 'RESTORED'
  | 'NO_SESSION'
  | 'SKIPPED';

const LOCATION_OPTIONS: Location.LocationTaskOptions = {
  accuracy: Location.Accuracy.High,
  timeInterval: 15_000,
  distanceInterval: 20,
  deferredUpdatesInterval: 45_000,
  pausesUpdatesAutomatically: false,
  foregroundService: {
    notificationTitle: 'Smart TMS đang theo dõi chuyến',
    notificationBody: 'Vị trí đang được cập nhật cho chuyến đang thực hiện.',
  },
};

const listeners = new Set<() => void>();
let snapshot: DriverTrackingSnapshot = EMPTY_TRACKING_SNAPSHOT;
let transientMode: DriverTrackingMode = 'IDLE';
let foregroundSubscription: LocationSubscription | null = null;
let permissionFlowInProgress = false;
let restoreInProgress = false;
let credentialLifetime = new AbortController();
let transition: Promise<unknown> = Promise.resolve();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let timedSignal: AbortSignal | undefined;
let activeTask: string | null = null;

function serializeTransition<T>(action: () => Promise<T>): Promise<T> {
  const result = transition.then(action, action);
  transition = result.catch(() => undefined);
  return result;
}
let latestLocalLocation: { sessionId: string; location: DriverLocalLocation } | null = null;

function rememberLatestLocation(
  session: DriverTrackingSession,
  locations: NonNullable<ReturnType<typeof mapLocation>>[],
): void {
  const newest = locations
    .slice()
    .sort((left, right) => right.measuredAt.localeCompare(left.measuredAt))[0];
  if (!newest) return;
  if (latestLocalLocation?.sessionId !== session.deviceSessionId ||
      newest.measuredAt > latestLocalLocation.location.measuredAt) {
    latestLocalLocation = { sessionId: session.deviceSessionId, location: {
      latitude: newest.latitude,
      longitude: newest.longitude,
      measuredAt: newest.measuredAt,
      ...('accuracyM' in newest && typeof newest.accuracyM === 'number'
        ? { accuracyM: newest.accuracyM }
        : {}),
      ...('headingDeg' in newest && typeof newest.headingDeg === 'number'
        ? { headingDeg: newest.headingDeg }
        : {}),
    } };
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function setSnapshot(next: DriverTrackingSnapshot) {
  snapshot = next;
  emit();
}

async function stopNamedTask(name: string): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(name)) {
      await Location.stopLocationUpdatesAsync(name);
    }
  } finally {
    if (await TaskManager.isTaskRegisteredAsync(name)) {
      await TaskManager.unregisterTaskAsync(name);
    }
  }
}

async function stopNativeCollection(except?: string): Promise<void> {
  if (activeTask !== except) {
    foregroundSubscription?.remove();
    foregroundSubscription = null;
  }
  const registered = await TaskManager.getRegisteredTasksAsync();
  const names = new Set(registered.map(({ taskName }) => taskName).filter(isDriverLocationTask));
  if (activeTask) names.add(activeTask);
  for (const name of names) {
    if (name !== except) await stopNamedTask(name);
  }
  activeTask = except ?? null;
}

async function stopNativeCollectionFor(taskName: string) {
  await driverGpsStorage.disableCapture(taskName);
  if (activeTask === taskName) {
    foregroundSubscription?.remove();
    foregroundSubscription = null;
    activeTask = null;
  }
  await stopNamedTask(taskName);
}

async function closeCapture() {
  await driverGpsStorage.disableCapture();
  await stopNativeCollection();
}

function invalidateGpsLifetime() {
  credentialLifetime.abort();
  credentialLifetime = new AbortController();
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  timedSignal = undefined;
  latestLocalLocation = null;
}

async function clearTracking(errorCode: string | null = null) {
  invalidateGpsLifetime();
  transientMode = errorCode ? 'BLOCKED' : 'STOPPED';
  setSnapshot({ ...EMPTY_TRACKING_SNAPSHOT, mode: transientMode, errorCode });
  await serializeTransition(async () => {
    try {
      await driverGpsStorage.revokeBindings();
    } finally {
      await stopNativeCollection();
    }
  });
}

function watchExpiry(expiresAt: number, signal: AbortSignal) {
  if (signal.aborted || timedSignal === signal) return;
  timedSignal = signal;
  expiryTimer = setTimeout(() => {
    if (!signal.aborted) void clearTracking('HTTP_401').catch(() => undefined);
  }, Math.max(0, expiresAt - Date.now()));
}

async function authorizeSession(session: DriverTrackingSession, signal: AbortSignal) {
  if (signal.aborted) return null;
  const binding = await driverGpsStorage.getBinding(session.deviceSessionId);
  const credential = binding && await readGpsCredential(session.userId);
  if (!credential || signal.aborted || credential.tag !== binding?.token_tag) return null;
  if ((await driverGpsStorage.getBinding(session.deviceSessionId))?.token_tag !== credential.tag ||
      signal.aborted) return null;
  if (credential.expiresAt <= Date.now()) {
    void clearTracking('HTTP_401').catch(() => undefined);
    return null;
  }
  watchExpiry(credential.expiresAt, signal);
  return credential.token;
}

const engine = new DriverGpsEngine({
  storage: driverGpsStorage,
  getDeviceCode: () => deviceCodeStorage.getOrCreate(),
  authorize: authorizeSession,
  upload: (...args) => driverGpsApiService.upload(...args),
  stopCollection: (session, signal) => serializeTransition(async () => {
    if (signal.aborted) return;
    const binding = await driverGpsStorage.getBinding(session.deviceSessionId);
    if (!binding?.task_name || signal.aborted) return;
    await stopNativeCollectionFor(binding.task_name);
  }),
  onLocationsCollected: rememberLatestLocation,
  onChanged: () => {
    void refreshSnapshot().catch(() => undefined);
  },
  now: () => new Date(),
});

async function refreshSnapshot(): Promise<void> {
  const signal = credentialLifetime.signal;
  const session = await driverGpsStorage.getCurrentSession();
  if (signal.aborted) return;
  if (!session) {
    setSnapshot({
      ...EMPTY_TRACKING_SNAPSHOT,
      mode: transientMode,
    });
    return;
  }
  const pendingCount = await driverGpsStorage.pendingCount(session);
  if (signal.aborted) return;
  let mode = transientMode;
  if (session.state === 'BLOCKED') mode = 'BLOCKED';
  else if (session.state === 'COMPLETED') mode = 'STOPPED';
  else if (session.errorCode) mode = 'SYNC_ERROR';
  else if (
    transientMode === 'PERMISSION_DENIED' ||
    transientMode === 'LOCATION_DISABLED' ||
    transientMode === 'RESTORING'
  ) {
    mode = transientMode;
  } else if (session.backgroundAllowed || transientMode === 'BACKGROUND') {
    mode = 'BACKGROUND';
  } else if (
    foregroundSubscription ||
    transientMode === 'FOREGROUND_ONLY' ||
    session.warning === 'BACKGROUND_PERMISSION_DENIED'
  ) {
    mode = 'FOREGROUND_ONLY';
  } else if (session.warning === 'LOCATION_PERMISSION_NOT_REQUESTED') {
    mode = 'PERMISSION_DENIED';
  } else if (transientMode === 'SYNC_ERROR') {
    mode = 'IDLE';
  }
  transientMode = mode;
  setSnapshot({
    mode,
    tripId: session.tripId,
    pendingCount,
    lastSyncAt: session.lastSyncAt,
    errorCode: session.errorCode,
    warning: session.warning,
    latestLocalLocation: session.state === 'ACTIVE' &&
      latestLocalLocation?.sessionId === session.deviceSessionId
      ? latestLocalLocation.location
      : null,
  });
}

async function requestNotificationPermission(): Promise<void> {
  if (Platform.OS !== 'android' || typeof Platform.Version !== 'number') return;
  if (Platform.Version < 33) return;
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}

async function ensureCollection(
  session: DriverTrackingSession,
  requestPermissions: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (!(await Location.hasServicesEnabledAsync())) {
    await closeCapture();
    transientMode = 'LOCATION_DISABLED';
    await refreshSnapshot();
    return;
  }
  let foreground = await Location.getForegroundPermissionsAsync();
  if (signal.aborted) return;
  if (requestPermissions && foreground.status !== 'granted') {
    foreground = await Location.requestForegroundPermissionsAsync();
  }
  if (signal.aborted) return;
  if (foreground.status !== 'granted') {
    await closeCapture();
    transientMode = 'PERMISSION_DENIED';
    await refreshSnapshot();
    return;
  }

  let background = await Location.getBackgroundPermissionsAsync();
  if (signal.aborted) return;
  if (requestPermissions && background.status !== 'granted') {
    background = await Location.requestBackgroundPermissionsAsync();
  }
  if (signal.aborted) return;
  const useBackground = background.status === 'granted';
  const binding = await driverGpsStorage.getBinding(session.deviceSessionId);
  const previousName = binding?.task_name;
  const alreadyCollecting = previousName && (useBackground
    ? await Location.hasStartedLocationUpdatesAsync(previousName)
    : activeTask === previousName && foregroundSubscription !== null);
  if (signal.aborted || !binding) return;
  if (alreadyCollecting) {
    await stopNativeCollection(previousName);
  } else {
    await closeCapture();
    if (useBackground) await requestNotificationPermission();
    if (signal.aborted) return;
    const name = `${DRIVER_LOCATION_TASK}-${Crypto.randomUUID()}`;
    await driverGpsStorage.enableCapture(session.deviceSessionId, name, Date.now());
    if (signal.aborted) return;
    activeTask = name;
    await driverGpsStorage.updateSession(session.deviceSessionId, { backgroundAllowed: useBackground });
    if (signal.aborted) return;
    if (useBackground) {
      driverTrackingService.defineLocationTask(name);
      await Location.startLocationUpdatesAsync(name, LOCATION_OPTIONS);
    } else {
      foregroundSubscription = await Location.watchPositionAsync({
        accuracy: Location.Accuracy.High,
        timeInterval: 15_000,
        distanceInterval: 20,
      }, (location) => {
        void driverTrackingService.collectFromTask(name, [location]).catch(() => undefined);
      });
    }
  }
  if (signal.aborted) return;
  transientMode = useBackground ? 'BACKGROUND' : 'FOREGROUND_ONLY';
  await driverGpsStorage.updateSession(session.deviceSessionId, {
    backgroundAllowed: useBackground,
    errorCode: null,
    warning: useBackground ? null : 'BACKGROUND_PERMISSION_DENIED',
  });
  await refreshSnapshot();
}

export const driverTrackingService = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): DriverTrackingSnapshot {
    return snapshot;
  },

  defineLocationTask(taskName: string) {
    defineDriverLocationTask(taskName, this.collectFromTask, this.handleTaskError);
  },

  async beginAfterStart(userId: string, tripId: string, requestPermissions = true) {
    const signal = credentialLifetime.signal;
    permissionFlowInProgress = true;
    try {
      await serializeTransition(async () => {
        const credential = await readGpsCredential(userId);
        if (signal.aborted || !credential || credential.expiresAt <= Date.now()) return;
        watchExpiry(credential.expiresAt, signal);
        if (snapshot.tripId !== tripId) latestLocalLocation = null;
        transientMode = 'RESTORING';
        const session = await driverGpsStorage.createOrRestoreSession(
          userId, tripId, Crypto.randomUUID(), credential.tag,
        );
        if (signal.aborted || session.state !== 'ACTIVE') return;
        try {
          if (requestPermissions) await ensureCollection(session, true, signal);
          else {
            await closeCapture();
            transientMode = 'PERMISSION_DENIED';
            await driverGpsStorage.updateSession(session.deviceSessionId, {
              warning: 'LOCATION_PERMISSION_NOT_REQUESTED',
            });
            await refreshSnapshot();
          }
        } catch {
          if (signal.aborted) return;
          await closeCapture().catch(() => undefined);
          transientMode = 'SYNC_ERROR';
          await driverGpsStorage.updateSession(session.deviceSessionId, { errorCode: 'TRACKING_START_FAILED' });
          await refreshSnapshot();
        }
      });
    } finally {
      permissionFlowInProgress = false;
    }
  },

  async retryPermissions(userId: string) {
    const signal = credentialLifetime.signal;
    permissionFlowInProgress = true;
    try {
      await serializeTransition(async () => {
        const session = await driverGpsStorage.getRestorableSession(userId);
        if (session?.state === 'ACTIVE' && await authorizeSession(session, signal)) {
          await ensureCollection(session, true, signal);
        }
      });
    } finally {
      permissionFlowInProgress = false;
    }
  },

  async restoreForUser(userId: string): Promise<DriverTrackingRestoreResult> {
    if (permissionFlowInProgress || restoreInProgress) return 'SKIPPED';
    const signal = credentialLifetime.signal;
    restoreInProgress = true;
    let shouldFlush = false;
    let ignoreBackoff = false;
    try {
      const result = await serializeTransition(async (): Promise<DriverTrackingRestoreResult> => {
        const credential = await readGpsCredential(userId);
        if (signal.aborted || !credential) return 'SKIPPED';
        if (credential.expiresAt <= Date.now()) {
          void clearTracking('HTTP_401').catch(() => undefined);
          return 'SKIPPED';
        }
        const session = await driverGpsStorage.getRestorableSession(userId);
        if (!session || !await authorizeSession(session, signal)) {
          if (signal.aborted) return 'SKIPPED';
          await closeCapture();
          transientMode = 'IDLE';
          setSnapshot(EMPTY_TRACKING_SNAPSHOT);
          return 'NO_SESSION';
        }
        const trip = await driverTripsService.getTrip(session.tripId).catch((error: unknown) => error);
        if (signal.aborted) return 'SKIPPED';
        if (trip instanceof ApiError) {
          if ([401, 403, 404].includes(trip.status)) {
            await closeCapture();
            transientMode = 'BLOCKED';
            await driverGpsStorage.updateSession(session.deviceSessionId, {
              state: 'BLOCKED', errorCode: trip.code,
            });
          } else transientMode = 'SYNC_ERROR';
          await refreshSnapshot();
          return 'RESTORED';
        }
        if (!trip || typeof trip !== 'object' || !('status' in trip)) {
          transientMode = 'SYNC_ERROR';
          await refreshSnapshot();
          return 'RESTORED';
        }
        if (trip.status === 'IN_PROGRESS' && session.state === 'ACTIVE' &&
            'assignment' in trip && trip.assignment && typeof trip.assignment === 'object' &&
            'role' in trip.assignment && trip.assignment.role === 'PRIMARY' &&
            'status' in trip.assignment && trip.assignment.status === 'ASSIGNED') {
          await ensureCollection(session, false, signal);
          shouldFlush = true;
          return 'RESTORED';
        }
        await closeCapture();
        if (trip.status === 'COMPLETED') {
          const actualEndTime = 'actualEndTime' in trip && typeof trip.actualEndTime === 'string'
            ? trip.actualEndTime : new Date().toISOString();
          await driverGpsStorage.updateSession(session.deviceSessionId, { state: 'COMPLETED', completedAt: actualEndTime });
          transientMode = 'STOPPED';
          shouldFlush = true;
          ignoreBackoff = true;
        } else {
          await driverGpsStorage.updateSession(session.deviceSessionId, { state: 'BLOCKED' });
          transientMode = 'STOPPED';
        }
        await refreshSnapshot();
        return 'RESTORED';
      });
      if (shouldFlush) await engine.flush(userId, signal, ignoreBackoff);
      return result;
    } finally {
      restoreInProgress = false;
    }
  },

  async completeAfterSuccess(userId: string, tripId: string, actualEndTime?: string) {
    const signal = credentialLifetime.signal;
    const completed = await serializeTransition(async () => {
      const session = await driverGpsStorage.getRestorableSession(userId, tripId);
      if (!session || !await authorizeSession(session, signal)) return false;
      try {
        const binding = await driverGpsStorage.getBinding(session.deviceSessionId);
        if (binding?.task_name) await stopNativeCollectionFor(binding.task_name);
      } finally {
        transientMode = 'STOPPED';
        await driverGpsStorage.updateSession(session.deviceSessionId, {
          state: 'COMPLETED', completedAt: actualEndTime ?? new Date().toISOString(),
        });
      }
      return true;
    });
    if (completed) await engine.flush(userId, signal, true);
    await refreshSnapshot();
  },

  async reconcileUncertainComplete(userId: string, tripId: string) {
    const signal = credentialLifetime.signal;
    const trip = await driverTripsService.getTrip(tripId);
    if (!signal.aborted && trip.status === 'COMPLETED') {
      await this.completeAfterSuccess(userId, tripId, trip.actualEndTime ?? undefined);
    }
  },

  async collectFromTask(taskName: string, locations: LocationObject[]) {
    const signal = credentialLifetime.signal;
    const capture = await driverGpsStorage.getCapture(taskName);
    if (!capture || signal.aborted) return;
    const foreground = await Location.getForegroundPermissionsAsync();
    const background = capture.session.backgroundAllowed ? await Location.getBackgroundPermissionsAsync() : null;
    if (signal.aborted) return;
    if (foreground.status !== 'granted' || (background && background.status !== 'granted')) {
      await serializeTransition(async () => {
        if (signal.aborted || !await driverGpsStorage.getCapture(taskName)) return;
        await driverGpsStorage.disableCapture(taskName);
        await stopNamedTask(taskName);
        if (activeTask === taskName) {
          foregroundSubscription?.remove();
          foregroundSubscription = null;
          activeTask = null;
        }
        transientMode = 'PERMISSION_DENIED';
        await refreshSnapshot();
      });
      return;
    }
    await engine.collect(capture.session, taskName, capture.capturedAfter, locations, signal);
  },

  async handleTaskError(taskName: string) {
    const signal = credentialLifetime.signal;
    const capture = await driverGpsStorage.getCapture(taskName);
    if (!capture || !await authorizeSession(capture.session, signal) || signal.aborted) return;
    transientMode = 'SYNC_ERROR';
    await driverGpsStorage.updateSession(capture.session.deviceSessionId, { errorCode: 'LOCATION_TASK_ERROR' });
    await refreshSnapshot();
  },

  async flushForUser(userId: string) {
    await engine.flush(userId, credentialLifetime.signal, true);
    await refreshSnapshot();
  },

  async openSettings() {
    await Linking.openSettings();
  },

  cleanupOnLogout: () => clearTracking(),

  async refresh() {
    await refreshSnapshot();
  },
};
