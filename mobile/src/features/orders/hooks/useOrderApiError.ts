import { useCallback } from 'react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { ApiError, toUserMessage } from '@/shared/api/api-error';

export function useOrderApiError() {
  const { logout } = useAuth();

  return useCallback(
    async (error: unknown) => {
      if (error instanceof ApiError && error.isUnauthorized) {
        await logout();
      }
      return toUserMessage(error);
    },
    [logout],
  );
}
