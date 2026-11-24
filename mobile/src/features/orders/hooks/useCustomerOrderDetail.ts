import { useCallback, useState } from 'react';
import { ordersService } from '@/features/orders/services/orders.service';
import type { CustomerOrderDetail } from '@/features/orders/types/order.types';
import { useOrderApiError } from './useOrderApiError';

export function useCustomerOrderDetail(orderId: string) {
  const [order, setOrder] = useState<CustomerOrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const handleError = useOrderApiError();

  const reload = useCallback(async () => {
    if (!orderId) {
      setError('Mã đơn không hợp lệ.');
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      setOrder(await ordersService.getOrder(orderId));
    } catch (caughtError) {
      setError(await handleError(caughtError));
    } finally {
      setIsLoading(false);
    }
  }, [handleError, orderId]);

  return { order, isLoading, error, reload };
}
