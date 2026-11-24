import { useCallback, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { ordersService } from '@/features/orders/services/orders.service';
import type {
  CreatedCustomerOrder,
  CreateCustomerOrderPayload,
} from '@/features/orders/types/order.types';
import { ApiError } from '@/shared/api/api-error';
import { useOrderApiError } from './useOrderApiError';

interface PendingSubmission {
  idempotencyKey: string;
  fingerprint: string;
}

export function useCreateCustomerOrder() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasUncertainSubmission, setHasUncertainSubmission] = useState(false);
  const pending = useRef<PendingSubmission | null>(null);
  const submitting = useRef(false);
  const handleError = useOrderApiError();

  const submit = useCallback(
    async (
      payload: CreateCustomerOrderPayload,
    ): Promise<CreatedCustomerOrder | null> => {
      if (submitting.current) return null;
      submitting.current = true;
      setIsSubmitting(true);
      setError(null);

      const fingerprint = JSON.stringify(payload);
      const previous = pending.current;
      const idempotencyKey =
        previous?.fingerprint === fingerprint
          ? previous.idempotencyKey
          : Crypto.randomUUID();
      pending.current = { idempotencyKey, fingerprint };
      setHasUncertainSubmission(false);

      try {
        const created = await ordersService.createOrder({
          ...payload,
          idempotencyKey,
        });
        pending.current = null;
        return created;
      } catch (caughtError) {
        const isUncertain =
          caughtError instanceof ApiError && caughtError.status === 0;
        if (!isUncertain) pending.current = null;
        setHasUncertainSubmission(isUncertain);
        setError(await handleError(caughtError));
        throw caughtError;
      } finally {
        submitting.current = false;
        setIsSubmitting(false);
      }
    },
    [handleError],
  );

  return {
    submit,
    isSubmitting,
    error,
    hasUncertainSubmission,
    clearError: () => setError(null),
  };
}
