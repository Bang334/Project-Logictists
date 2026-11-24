import { useCallback, useEffect, useRef, useState } from 'react';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import type {
  DriverTripStatusFilter,
  DriverTripSummary,
} from '@/features/driver-trips/types/driver-trip.types';
import { useDriverTripApiError } from './useDriverTripApiError';
import { ApiError } from '@/shared/api/api-error';

const PAGE_SIZE = 20;

export function useDriverTrips(status: DriverTripStatusFilter) {
  const [trips, setTrips] = useState<DriverTripSummary[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const requestId = useRef(0);
  const firstPageRequest = useRef<number | null>(null);
  const nextPageRequest = useRef<number | null>(null);
  const hasLoaded = useRef(false);
  const handleError = useDriverTripApiError();

  useEffect(() => () => {
    requestId.current += 1;
    firstPageRequest.current = null;
    nextPageRequest.current = null;
  }, []);

  const loadFirstPage = useCallback(
    async (refreshing = false) => {
      if (firstPageRequest.current !== null) return;
      const currentRequest = ++requestId.current;
      firstPageRequest.current = currentRequest;
      nextPageRequest.current = null;
      setIsLoadingMore(false);
      setLoadMoreError(null);
      if (refreshing || hasLoaded.current) setIsRefreshing(true);
      else setIsInitialLoading(true);
      setError(null);
      try {
        const result = await driverTripsService.getTrips(
          1,
          PAGE_SIZE,
          status === 'ALL' ? undefined : status,
        );
        if (currentRequest !== requestId.current) return;
        hasLoaded.current = true;
        setTrips(result.items);
        setPage(result.page);
        setTotalPages(result.totalPages);
      } catch (caughtError) {
        if (currentRequest !== requestId.current) return;
        const message = await handleError(caughtError);
        if (currentRequest !== requestId.current) return;
        if (caughtError instanceof ApiError && [401, 403, 404, 409].includes(caughtError.status)) {
          hasLoaded.current = false;
          setTrips([]);
          setPage(0);
          setTotalPages(0);
        }
        setError(message);
      } finally {
        if (currentRequest === requestId.current) {
          firstPageRequest.current = null;
          setIsInitialLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [handleError, status],
  );

  const loadMore = useCallback(async () => {
    if (firstPageRequest.current !== null || nextPageRequest.current !== null || page === 0 || page >= totalPages) return;
    const currentRequest = ++requestId.current;
    nextPageRequest.current = currentRequest;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const result = await driverTripsService.getTrips(
        page + 1,
        PAGE_SIZE,
        status === 'ALL' ? undefined : status,
      );
      if (currentRequest !== requestId.current) return;
      setTrips((current) => {
        const knownIds = new Set(current.map((trip) => trip.id));
        return [
          ...current,
          ...result.items.filter((trip) => !knownIds.has(trip.id)),
        ];
      });
      setPage(result.page);
      setTotalPages(result.totalPages);
    } catch (caughtError) {
      if (currentRequest !== requestId.current) return;
      const message = await handleError(caughtError);
      if (currentRequest === requestId.current) setLoadMoreError(message);
    } finally {
      if (currentRequest === requestId.current) {
        nextPageRequest.current = null;
        setIsLoadingMore(false);
      }
    }
  }, [handleError, page, status, totalPages]);

  const reload = useCallback(() => loadFirstPage(false), [loadFirstPage]);
  const refresh = useCallback(() => loadFirstPage(true), [loadFirstPage]);

  return {
    trips,
    error,
    loadMoreError,
    hasSnapshot: page > 0,
    isInitialLoading,
    isRefreshing,
    isLoadingMore,
    hasMore: page < totalPages,
    reload,
    refresh,
    loadMore,
  };
}
