import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { driverIncidentsService } from '@/features/driver-incidents/services/driver-incidents.service';
import type { CreateDriverIncidentInput } from '@/features/driver-incidents/types/driver-incident.types';
import {
  incidentInputFingerprint,
  validateDriverIncidentInput,
} from '@/features/driver-incidents/validation/driver-incident.validation';
import { useDriverTripApiError } from '@/features/driver-trips/hooks/useDriverTripApiError';
import { ApiError } from '@/shared/api/api-error';

interface PendingIncidentCommand {
  fingerprint: string;
  idempotencyKey: string;
}

const REFRESH_TRIP_CODES = new Set([
  'INVALID_TRIP_STATE',
  'INCIDENT_ORDER_NOT_IN_TRIP',
  'DRIVER_NOT_PRIMARY',
]);

function friendlyIncidentError(error: ApiError): string | null {
  const messages: Record<string, string> = {
    DRIVER_NOT_PRIMARY: 'Chỉ tài xế chính được báo sự cố cho chuyến này.',
    INVALID_TRIP_STATE:
      'Trạng thái chuyến vừa thay đổi và không còn cho phép báo sự cố.',
    INCIDENT_ORDER_NOT_IN_TRIP:
      'Danh sách đơn của chuyến đã thay đổi. Vui lòng kiểm tra và gửi lại.',
    IDEMPOTENCY_PAYLOAD_MISMATCH:
      'Nội dung đã thay đổi sau lần gửi chưa rõ kết quả. Vui lòng gửi như một báo cáo mới.',
    DRIVER_PROFILE_NOT_FOUND:
      'Tài khoản Driver chưa được liên kết với hồ sơ tài xế.',
  };
  const message = messages[error.code];
  return message ? `${message} [${error.code}]` : null;
}

export function useCreateDriverIncident(
  tripId: string,
  reloadIncidents: () => Promise<void>,
  reloadTrip: () => Promise<void>,
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUncertainSubmission, setHasUncertainSubmission] = useState(false);
  const pending = useRef<PendingIncidentCommand | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const handleError = useDriverTripApiError();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const submit = useCallback(
    async (input: CreateDriverIncidentInput): Promise<boolean> => {
      if (submitting.current) return false;
      const validation = validateDriverIncidentInput(input);
      if (!validation.value) {
        if (mounted.current) {
          setError(
            Object.values(validation.errors)[0] ??
              'Dữ liệu sự cố không hợp lệ.',
          );
        }
        return false;
      }

      submitting.current = true;
      if (mounted.current) {
        setIsSubmitting(true);
        setError(null);
      }
      const fingerprint = incidentInputFingerprint(validation.value);
      const idempotencyKey =
        pending.current?.fingerprint === fingerprint
          ? pending.current.idempotencyKey
          : Crypto.randomUUID();
      pending.current = { fingerprint, idempotencyKey };
      if (mounted.current) setHasUncertainSubmission(false);

      try {
        await driverIncidentsService.create(tripId, {
          ...validation.value,
          idempotencyKey,
        });
        pending.current = null;
        await reloadIncidents();
        if (mounted.current) setHasUncertainSubmission(false);
        return true;
      } catch (caughtError) {
        const uncertain =
          caughtError instanceof ApiError && caughtError.status === 0;
        if (!uncertain) pending.current = null;
        if (mounted.current) setHasUncertainSubmission(uncertain);
        if (
          caughtError instanceof ApiError &&
          REFRESH_TRIP_CODES.has(caughtError.code)
        ) {
          await reloadTrip();
        }
        const mapped =
          caughtError instanceof ApiError
            ? friendlyIncidentError(caughtError)
            : null;
        if (mounted.current) {
          setError(mapped ?? (await handleError(caughtError)));
        }
        return false;
      } finally {
        submitting.current = false;
        if (mounted.current) setIsSubmitting(false);
      }
    },
    [handleError, reloadIncidents, reloadTrip, tripId],
  );

  return {
    submit,
    isSubmitting,
    error,
    hasUncertainSubmission,
    clearError: () => setError(null),
  };
}
