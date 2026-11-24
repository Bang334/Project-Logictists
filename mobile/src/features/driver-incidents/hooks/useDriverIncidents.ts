import { useCallback, useEffect, useRef, useState } from 'react';
import { driverIncidentsService } from '@/features/driver-incidents/services/driver-incidents.service';
import type { DriverIncident } from '@/features/driver-incidents/types/driver-incident.types';
import { useDriverTripApiError } from '@/features/driver-trips/hooks/useDriverTripApiError';

const PAGE_SIZE = 20;

export function useDriverIncidents(tripId: string) {
  const [items, setItems] = useState<DriverIncident[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const handleError = useDriverTripApiError();

  const load = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!tripId) return;
      const requestGeneration = ++generation.current;
      if (append) setIsLoadingMore(true);
      else setIsLoading(true);
      setError(null);
      try {
        const result = await driverIncidentsService.getPage(tripId, {
          page: nextPage,
          limit: PAGE_SIZE,
        });
        if (requestGeneration !== generation.current) return;
        setItems((current) =>
          append ? [...current, ...result.items] : result.items,
        );
        setPage(result.page);
        setTotalPages(result.totalPages);
      } catch (caughtError) {
        if (requestGeneration !== generation.current) return;
        setError(await handleError(caughtError));
      } finally {
        if (requestGeneration === generation.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [handleError, tripId],
  );

  const reload = useCallback(() => load(1, false), [load]);
  const loadMore = useCallback(async () => {
    if (isLoadingMore || page >= totalPages) return;
    await load(page + 1, true);
  }, [isLoadingMore, load, page, totalPages]);

  useEffect(() => {
    const timeout = setTimeout(() => void reload(), 0);
    return () => {
      clearTimeout(timeout);
      generation.current += 1;
    };
  }, [reload]);

  return {
    items,
    isLoading,
    isLoadingMore,
    error,
    hasMore: page < totalPages,
    reload,
    loadMore,
  };
}
