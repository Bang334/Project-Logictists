import { useCallback, useState } from 'react';
import { ordersService } from '@/features/orders/services/orders.service';
import type { CustomerBranch } from '@/features/orders/types/order.types';
import { useOrderApiError } from './useOrderApiError';

export function useCustomerBranches() {
  const [branches, setBranches] = useState<CustomerBranch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const handleError = useOrderApiError();

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setBranches(await ordersService.getBranches());
    } catch (caughtError) {
      setError(await handleError(caughtError));
    } finally {
      setIsLoading(false);
    }
  }, [handleError]);

  return { branches, isLoading, error, reload };
}
