import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import type { DriverTripStateCommandResponse } from '@/features/driver-trips/types/driver-trip.types';

function confirmLocationTracking(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Cập nhật vị trí chuyến',
      'Smart TMS cần quyền vị trí khi sử dụng và khi chạy nền để điều phối theo dõi chuyến. Bạn có thể tiếp tục chuyến nếu không cấp quyền, nhưng tracking sẽ không đầy đủ.',
      [
        { text: 'Để sau', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Tiếp tục', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

export function useDriverTracking(tripId: string) {
  const { user } = useAuth();
  const [isStartingTracking, setIsStartingTracking] = useState(false);
  const trackingStartInProgress = useRef(false);
  const snapshot = useSyncExternalStore(
    driverTrackingService.subscribe,
    driverTrackingService.getSnapshot,
    driverTrackingService.getSnapshot,
  );
  const userId = user?.role === 'DRIVER' ? user.id : null;

  const requestTrackingStart = useCallback(async (persistPermissionDeferral: boolean) => {
    if (!userId || trackingStartInProgress.current) return;
    trackingStartInProgress.current = true;
    setIsStartingTracking(true);
    try {
      const shouldRequest = await confirmLocationTracking();
      if (shouldRequest) {
        await driverTrackingService.beginAfterStart(userId, tripId, true);
      } else if (persistPermissionDeferral) {
        await driverTrackingService.beginAfterStart(userId, tripId, false);
      }
    } finally {
      trackingStartInProgress.current = false;
      setIsStartingTracking(false);
    }
  }, [tripId, userId]);

  const onTripStarted = useCallback(
    async (_response: DriverTripStateCommandResponse) => {
      await requestTrackingStart(true);
    },
    [requestTrackingStart],
  );

  const onTripCompleted = useCallback(
    async (response: DriverTripStateCommandResponse) => {
      if (!userId) return;
      await driverTrackingService.completeAfterSuccess(
        userId,
        tripId,
        response.actualEndTime,
      );
    },
    [tripId, userId],
  );

  const onCompleteUncertain = useCallback(async () => {
    if (!userId) return;
    await driverTrackingService.reconcileUncertainComplete(userId, tripId);
  }, [tripId, userId]);

  return {
    snapshot:
      snapshot.tripId === tripId || snapshot.tripId === null
        ? snapshot
        : {
            mode: 'IDLE' as const,
            tripId,
            pendingCount: 0,
            lastSyncAt: null,
            errorCode: null,
            warning: null,
            latestLocalLocation: null,
          },
    lifecycle: { onTripStarted, onTripCompleted, onCompleteUncertain },
    startTracking: () => requestTrackingStart(false),
    isStartingTracking,
    retryPermissions: () =>
      userId ? driverTrackingService.retryPermissions(userId) : Promise.resolve(),
    flush: () =>
      userId ? driverTrackingService.flushForUser(userId) : Promise.resolve(),
    openSettings: () => driverTrackingService.openSettings(),
  };
}
