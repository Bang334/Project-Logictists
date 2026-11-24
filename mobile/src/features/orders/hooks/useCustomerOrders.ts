import { useCallback, useRef, useState } from 'react';
import { ordersService } from '@/features/orders/services/orders.service';
import type {
  CustomerOrderSummary,
  OrderStatusFilter,
} from '@/features/orders/types/order.types';
import { useOrderApiError } from './useOrderApiError';

const PAGE_SIZE = 20;

export function useCustomerOrders(status: OrderStatusFilter) {
  const [orders, setOrders] = useState<CustomerOrderSummary[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const handleError = useOrderApiError();

  const loadFirstPage = useCallback(
    async (refreshing = false) => {
      const currentRequest = ++requestId.current;
      if (refreshing) setIsRefreshing(true);
      else {
        setIsInitialLoading(true);
        setOrders([]);
        setPage(0);
        setTotalPages(0);
      }
      setError(null);
      try {
        const result = await ordersService.getOrders(
          1,
          PAGE_SIZE,
          status === 'ALL' ? undefined : status,
        );
        if (currentRequest !== requestId.current) return;
        setOrders(result.items);
        setPage(result.page);
        setTotalPages(result.totalPages);
      } catch (caughtError) {
        if (currentRequest === requestId.current) {
          setError(await handleError(caughtError));
        }
      } finally {
        if (currentRequest === requestId.current) {
          setIsInitialLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [handleError, status],
  );

  const loadMore = useCallback(async () => {
    if (isLoadingMore || page === 0 || page >= totalPages) return;
    const currentRequest = requestId.current;
    setIsLoadingMore(true);
    setError(null);
    try {
      const result = await ordersService.getOrders(
        page + 1,
        PAGE_SIZE,
        status === 'ALL' ? undefined : status,
      );
      if (currentRequest !== requestId.current) return;
      setOrders((current) => {
        const knownIds = new Set(current.map((order) => order.id));
        return [
          ...current,
          ...result.items.filter((order) => !knownIds.has(order.id)),
        ];
      });
      setPage(result.page);
      setTotalPages(result.totalPages);
    } catch (caughtError) {
      if (currentRequest === requestId.current) {
        setError(await handleError(caughtError));
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [handleError, isLoadingMore, page, status, totalPages]);

  const reload = useCallback(() => loadFirstPage(false), [loadFirstPage]);
  const refresh = useCallback(() => loadFirstPage(true), [loadFirstPage]);

  return {
    orders,
    error,
    isInitialLoading,
    isRefreshing,
    isLoadingMore,
    hasMore: page < totalPages,
    reload,
    refresh,
    loadMore,
  };
}
