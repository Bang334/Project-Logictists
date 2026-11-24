import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ApiError } from '@/shared/api/api-error';
import { driverPodService } from '../services/driver-pod.service';
import type { DriverTripDetail } from '../types/driver-trip.types';
import { useDriverTripApiError } from './useDriverTripApiError';

type Readiness = Readonly<Record<string, boolean | null>>;
type AttemptTarget = { stopId: string; attemptId: string; attemptNumber: number };
const unknownReadiness: Readiness = {};

export function useDriverTripPodReadiness(trip: DriverTripDetail | null, enabled: boolean, revision: number) {
  const [snapshot, setSnapshot] = useState<{ scope: string; values: Readiness } | null>(null);
  const handleApiError = useDriverTripApiError();
  const targets = (trip?.stops ?? []).flatMap((stop) => {
    const attempt = stop.deliveryAttempt;
    return stop.stopType === 'DELIVERY' && stop.status === 'COMPLETED' && attempt
      ? [{ stopId: stop.id, attemptId: attempt.id, attemptNumber: attempt.attemptNumber }]
      : [];
  });
  const scope = enabled && trip && targets.length > 0
    ? JSON.stringify({ tripId: trip.id, version: trip.version, revision, targets })
    : null;

  useFocusEffect(useCallback(() => {
    if (!scope) return;
    const { tripId, targets: requested } = JSON.parse(scope) as { tripId: string; targets: AttemptTarget[] };
    let active = true;
    void Promise.allSettled(requested.map(async ({ stopId, attemptId, attemptNumber }) => {
      const pod = await driverPodService.getPod(tripId, stopId, attemptId);
      // The trip contract exposes only the latest attempt at this stop.
      if (attemptNumber !== 1 || pod.deliveryAttempt.id !== attemptId) return null;
      const hasActivePhoto = pod.items.some((item) =>
        item.evidenceType === 'PHOTO' && item.uploadStatus === 'UPLOADED' && !item.isSuperseded,
      );
      return pod.requirements.podSatisfied && (!pod.requirements.photoRequired || hasActivePhoto);
    })).then((results) => {
      if (!active) return;
      const failure = results.find((result) => result.status === 'rejected' &&
        result.reason instanceof ApiError && result.reason.isUnauthorized);
      if (failure?.status === 'rejected') void handleApiError(failure.reason);
      setSnapshot({
        scope,
        values: Object.fromEntries(requested.map(({ attemptId }, index) => {
          const result = results[index];
          return [attemptId, result?.status === 'fulfilled' ? result.value : null];
        })),
      });
    });
    return () => {
      active = false;
      setSnapshot((current) => current?.scope === scope ? null : current);
    };
  }, [handleApiError, scope]));

  return scope && snapshot?.scope === scope ? snapshot.values : unknownReadiness;
}
