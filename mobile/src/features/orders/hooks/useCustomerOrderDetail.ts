import { useCallback, useEffect, useRef, useState } from 'react';
import { ordersService } from '@/features/orders/services/orders.service';
import type { CustomerOrderDetail } from '@/features/orders/types/order.types';
import { useOrderApiError } from './useOrderApiError';

export function useCustomerOrderDetail(orderId: string) {
  const [order, setOrder] = useState<CustomerOrderDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const handleError = useOrderApiError();
  const requestId = useRef(0);

  useEffect(() => () => { requestId.current += 1; }, [orderId]);

  const reload = useCallback(async () => {
    const currentRequest = ++requestId.current;
    if (!orderId) {
      setError('Mã đơn không hợp lệ.');
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await ordersService.getOrder(orderId);
      if (currentRequest !== requestId.current) return;
      setOrder((current) => current?.id === result.id && current.version > result.version ? current : result);
    } catch (caughtError) {
      if (currentRequest !== requestId.current) return;
      const message = await handleError(caughtError);
      if (currentRequest === requestId.current) setError(message);
    } finally {
      if (currentRequest === requestId.current) setIsLoading(false);
    }
  }, [handleError, orderId]);

  return { order, isLoading, error, reload };
}
