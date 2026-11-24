import { useCallback, useState } from 'react';
import { authService } from '@/features/auth/services/auth.service';
import type { RegisterCustomerRequest } from '@/features/auth/types/auth.types';
import { toUserMessage } from '@/shared/api/api-error';

export function useRegisterCustomer() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const register = useCallback(async (request: RegisterCustomerRequest) => {
    setIsSubmitting(true);
    setError(null);
    try {
      return await authService.registerCustomer(request);
    } catch (caughtError) {
      const message = toUserMessage(caughtError);
      setError(message);
      throw caughtError;
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  return { register, isSubmitting, error, clearError: () => setError(null) };
}
