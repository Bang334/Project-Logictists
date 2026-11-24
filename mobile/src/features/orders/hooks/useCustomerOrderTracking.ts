import { useCallback, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ordersService } from '@/features/orders/services/orders.service';
import type { CustomerOrderTracking } from '@/features/orders/types/order-tracking.types';
import { useOrderApiError } from './useOrderApiError';

export const CUSTOMER_TRACKING_POLL_INTERVAL_MS = 30_000;

export function useCustomerOrderTracking(orderId: string) {
  const [tracking, setTracking] = useState<CustomerOrderTracking | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackingRef = useRef<CustomerOrderTracking | null>(null);
  const canFetchRef = useRef(false);
  const generationRef = useRef(0);
  const inFlightGenerationRef = useRef<number | null>(null);
  const handleError = useOrderApiError();

  const fetchTracking = useCallback(
    async (showInitialLoading = false) => {
      if (!canFetchRef.current) return;
      const generation = generationRef.current;
      if (inFlightGenerationRef.current === generation) return;
      if (!orderId) {
        setError('Mã đơn không hợp lệ.');
        setIsLoading(false);
        return;
      }

      inFlightGenerationRef.current = generation;
      if (showInitialLoading && trackingRef.current === null) {
        setIsLoading(true);
      }
      setIsRefreshing(true);
      try {
        const next = await ordersService.getCustomerOrderTracking(orderId);
        if (!canFetchRef.current || generationRef.current !== generation) return;
        trackingRef.current = next;
        setTracking(next);
        setError(null);
      } catch (caughtError) {
        const message = await handleError(caughtError);
        if (!canFetchRef.current || generationRef.current !== generation) return;
        setError(message);
      } finally {
        if (inFlightGenerationRef.current === generation) {
          inFlightGenerationRef.current = null;
        }
        if (canFetchRef.current && generationRef.current === generation) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [handleError, orderId],
  );

  useFocusEffect(
    useCallback(() => {
      let interval: ReturnType<typeof setInterval> | null = null;

      const stopPolling = () => {
        if (interval) clearInterval(interval);
        interval = null;
      };
      const deactivate = () => {
        canFetchRef.current = false;
        generationRef.current += 1;
        stopPolling();
      };
      const activate = () => {
        if (canFetchRef.current) return;
        generationRef.current += 1;
        canFetchRef.current = true;
        void fetchTracking(trackingRef.current === null);
        interval = setInterval(() => {
          void fetchTracking(false);
        }, CUSTOMER_TRACKING_POLL_INTERVAL_MS);
      };
      const handleAppState = (nextState: AppStateStatus) => {
        if (nextState === 'active') activate();
        else deactivate();
      };

      if (AppState.currentState === 'active') activate();
      const subscription = AppState.addEventListener('change', handleAppState);

      return () => {
        deactivate();
        subscription.remove();
      };
    }, [fetchTracking]),
  );

  const retry = useCallback(
    () => fetchTracking(trackingRef.current === null),
    [fetchTracking],
  );

  return { tracking, isLoading, isRefreshing, error, retry };
}
