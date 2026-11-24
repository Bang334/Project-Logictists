import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';

function confirmTrackingResume(tripNumber: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Tiếp tục theo dõi vị trí',
      `Chuyến ${tripNumber} vẫn đang thực hiện. Bạn có muốn bắt đầu lại GPS tracking trên thiết bị này không?`,
      [
        { text: 'Để sau', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Tiếp tục tracking', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

export function DriverTrackingLifecycle() {
  const { status, user, logout } = useAuth();
  const wasConnected = useRef<boolean | null>(null);

  useEffect(() => {
    if (status !== 'authenticated' || user?.role !== 'DRIVER') return;
    let lifecycleCheckInProgress = false;
    let disposed = false;
    const promptedTripIds = new Set<string>();

    const restoreOrOfferResume = async () => {
      if (disposed || lifecycleCheckInProgress) return;
      lifecycleCheckInProgress = true;
      try {
        const restoreResult = await driverTrackingService.restoreForUser(user.id);
        if (disposed || restoreResult !== 'NO_SESSION') return;

        const activeTrips = await driverTripsService.getTrips(1, 2, 'IN_PROGRESS');
        if (disposed || activeTrips.total !== 1 || activeTrips.items.length !== 1) return;
        const [trip] = activeTrips.items;
        if (trip?.assignment.role !== 'PRIMARY' || trip.assignment.status !== 'ASSIGNED') return;
        if (promptedTripIds.has(trip.id)) return;
        promptedTripIds.add(trip.id);

        if (await confirmTrackingResume(trip.tripNumber) && !disposed) {
          await driverTrackingService.beginAfterStart(user.id, trip.id, true);
        }
      } catch {
        // A transient API/storage failure is retried on the next foreground event.
      } finally {
        lifecycleCheckInProgress = false;
      }
    };

    void restoreOrOfferResume();

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void restoreOrOfferResume();
      }
    });
    const networkSubscription = NetInfo.addEventListener((network) => {
      const connected = network.isConnected === true && network.isInternetReachable !== false;
      if (connected && wasConnected.current === false) {
        void driverTrackingService.flushForUser(user.id);
      }
      wasConnected.current = connected;
    });
    return () => {
      disposed = true;
      wasConnected.current = null;
      appStateSubscription.remove();
      networkSubscription();
    };
  }, [status, user?.id, user?.role]);

  useEffect(() => {
    const unsubscribe = driverTrackingService.subscribe(() => {
      const current = driverTrackingService.getSnapshot();
      if (current.mode === 'BLOCKED' && current.errorCode === 'HTTP_401') {
        void logout();
      }
    });
    return () => {
      unsubscribe();
    };
  }, [logout]);

  return null;
}
