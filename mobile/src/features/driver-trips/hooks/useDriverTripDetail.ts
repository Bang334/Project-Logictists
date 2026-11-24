import { useCallback, useEffect, useRef, useState } from 'react';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import type { DriverTripDetail } from '@/features/driver-trips/types/driver-trip.types';
import { useDriverTripApiError } from './useDriverTripApiError';
import { jwtExpiry, offlineDriverIdentity } from '@/features/auth/services/offline-driver-identity';
import { tokenStorage } from '@/shared/storage/token-storage';
import { ApiError } from '@/shared/api/api-error';
import { offlineTripSnapshots } from '../storage/offline-trip-snapshots';
import { withoutDriverStopPhones } from '../selectors/driver-stop-contact';

export function useDriverTripDetail(tripId: string) {
  const [trip, setTrip] = useState<DriverTripDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const handleError = useDriverTripApiError();
  const latestRequest = useRef(0);
  const redactTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    latestRequest.current += 1;
    clearTimeout(redactTimer.current);
  }, [tripId]);

  const reload = useCallback(async () => {
    const request = ++latestRequest.current;
    if (!tripId) {
      setError('Mã chuyến không hợp lệ.');
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    const checkedAt = Date.now();
    let token: string | null = null;
    try {
      token = await tokenStorage.get();
      const next = token ? await driverTripsService.getTrip(tripId, token) : await driverTripsService.getTrip(tripId);
      if (next.id !== tripId) throw new ApiError('Dữ liệu chuyến không khớp.', 0, 'INVALID_RESPONSE');
      if (request === latestRequest.current) {
        clearTimeout(redactTimer.current);
        const expiresAt = token ? jwtExpiry(token) : null;
        const remaining = expiresAt === null ? 0 : expiresAt - Date.now();
        setTrip(remaining > 0 ? next : withoutDriverStopPhones(next));
        if (remaining > 0 && next.stops.some((stop) => stop.contactPhone !== null)) {
          redactTimer.current = setTimeout(() => setTrip((current) =>
            current === next ? withoutDriverStopPhones(next) : current), remaining);
        }
        if (token) void offlineDriverIdentity.read(token).then((identity) => {
          if (identity && request === latestRequest.current) return offlineTripSnapshots.save(identity, next, checkedAt);
        }).catch(() => undefined);
      }
    } catch (caughtError) {
      if (request !== latestRequest.current) return;
      if (caughtError instanceof ApiError && (caughtError.status === 403 || caughtError.status === 404)) {
        clearTimeout(redactTimer.current);
        setTrip(null);
        if (token) void offlineDriverIdentity.read(token).then((identity) => {
          if (identity) return offlineTripSnapshots.invalidate(identity, tripId, checkedAt);
        }).catch(() => undefined);
      }
      const message = await handleError(caughtError);
      if (request === latestRequest.current) setError(message);
    } finally {
      if (request === latestRequest.current) setIsLoading(false);
    }
  }, [handleError, tripId]);

  return { trip, isLoading, error, reload };
}
