import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useDriverTripApiError } from '@/features/driver-trips/hooks/useDriverTripApiError';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import type { DriverTripDetail, DriverTripPage } from '@/features/driver-trips/types/driver-trip.types';
import { ApiError } from '@/shared/api/api-error';

type ActiveTrips = { page: DriverTripPage; detail: DriverTripDetail | null; detailUnavailable: boolean };
type HomeData = {
  active: ActiveTrips | null;
  upcoming: DriverTripPage | null;
  activeError: string | null;
  upcomingError: string | null;
};

const empty: HomeData = { active: null, upcoming: null, activeError: null, upcomingError: null };

function invalidatesSnapshot(error: unknown) {
  return error instanceof ApiError && [401, 403, 404, 409].includes(error.status);
}

async function loadActiveTrips(isCurrent: () => boolean): Promise<ActiveTrips> {
  const page = await driverTripsService.getTrips(1, 2, 'IN_PROGRESS');
  const summary = page.items[0];
  if (!isCurrent() || page.total !== 1 || page.items.length !== 1 || !summary || summary.status !== 'IN_PROGRESS') {
    return { page, detail: null, detailUnavailable: false };
  }
  try {
    const detail = await driverTripsService.getTrip(summary.id);
    // The assignment or trip status can change between the two reads.
    if (detail.id !== summary.id || detail.status !== 'IN_PROGRESS') {
      return { page, detail: null, detailUnavailable: true };
    }
    return { page, detail, detailUnavailable: false };
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) throw error;
    return { page, detail: null, detailUnavailable: true };
  }
}

export function useDriverHomeData(isOnline: boolean) {
  const [data, setData] = useState<HomeData>(empty);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const handleError = useDriverTripApiError();

  useEffect(() => () => {
    generation.current += 1;
    inFlight.current = null;
  }, []);

  const refresh = useCallback(() => {
    if (!isOnline) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    const request = generation.current;
    const isCurrent = () => generation.current === request;
    setIsRefreshing(true);

    const pending = Promise.allSettled([
      loadActiveTrips(isCurrent),
      driverTripsService.getTrips(1, 3, 'DISPATCHED'),
    ]).then(async ([active, upcoming]) => {
      if (!isCurrent()) return;
      const unauthorized = [active, upcoming].find((result) => result.status === 'rejected' &&
        result.reason instanceof ApiError && result.reason.isUnauthorized);
      if (unauthorized?.status === 'rejected') {
        setData(empty);
        await handleError(unauthorized.reason);
        return;
      }
      const [activeError, upcomingError] = await Promise.all([
        active.status === 'rejected' ? handleError(active.reason) : null,
        upcoming.status === 'rejected' ? handleError(upcoming.reason) : null,
      ]);
      if (!isCurrent()) return;
      setData((previous) => ({
        active: active.status === 'fulfilled' ? active.value :
          invalidatesSnapshot(active.reason) ? null : previous.active,
        upcoming: upcoming.status === 'fulfilled' ? upcoming.value :
          invalidatesSnapshot(upcoming.reason) ? null : previous.upcoming,
        activeError,
        upcomingError,
      }));
    }).catch(() => {
      if (isCurrent()) setData({ ...empty, activeError: 'Không thể tải dữ liệu chuyến. Vui lòng thử lại.' });
    }).finally(() => {
      if (!isCurrent()) return;
      inFlight.current = null;
      setIsRefreshing(false);
    });
    inFlight.current = pending;
    return pending;
  }, [handleError, isOnline]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  return { ...data, isRefreshing, refresh };
}
