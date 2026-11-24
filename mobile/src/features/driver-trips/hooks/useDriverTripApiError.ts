import { useCallback } from 'react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { ApiError, toUserMessage } from '@/shared/api/api-error';

export function useDriverTripApiError() {
  const { logout } = useAuth();

  return useCallback(
    async (error: unknown) => {
      if (error instanceof ApiError) {
        if (error.isUnauthorized) await logout();
        if (error.status === 404) {
          return 'Không tìm thấy chuyến được phân công.';
        }
        if (
          error.status === 409 &&
          error.code === 'DRIVER_PROFILE_NOT_FOUND'
        ) {
          return 'Tài khoản Driver chưa được liên kết với hồ sơ tài xế.';
        }
      }
      return toUserMessage(error);
    },
    [logout],
  );
}
