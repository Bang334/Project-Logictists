import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useNetInfo } from '@react-native-community/netinfo';
import { driverProfileService } from '@/features/driver-home/services/driver-profile.service';
import { useDriverTripApiError } from '../hooks/useDriverTripApiError';
import { resolveDriverTimezone } from './driver-schedule-dates';

export function useDriverScheduleRead<T, Cursor>(
  load: (cursor?: Cursor) => Promise<{ data: T[]; next?: Cursor }>,
  enabled = true,
) {
  const { isConnected, isInternetReachable } = useNetInfo();
  const online = isConnected === true && isInternetReachable !== false;
  const offline = isConnected === false || isInternetReachable === false;
  const [result, setResult] = useState<{ request: typeof load; data: T[]; next?: Cursor }>();
  const [error, setError] = useState<{ request: typeof load; message: string }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const handleError = useDriverTripApiError();

  const current = result?.request === load ? result : undefined;
  const currentError = error?.request === load ? error.message : undefined;
  const request = useCallback(async (cursor?: Cursor) => {
    if (!online || !enabled || pending.current) return;
    const ticket = ++generation.current;
    pending.current = true;
    if (cursor === undefined) {
      setInitialLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(undefined);
    try {
      const { data, next } = await load(cursor);
      if (ticket !== generation.current) return;
      setResult((previous) => ({
        request: load,
        data: cursor !== undefined && previous?.request === load ? [...previous.data, ...data] : data,
        next,
      }));
    } catch (caught) {
      if (ticket !== generation.current) return;
      const message = await handleError(caught);
      if (ticket === generation.current) {
        if (cursor === undefined) setResult(undefined);
        setError({ request: load, message });
      }
    } finally {
      if (ticket === generation.current) {
        pending.current = false;
        setLoadingMore(false);
        setInitialLoading(false);
      }
    }
  }, [enabled, handleError, load, online]);

  useFocusEffect(useCallback(() => {
    void request();
    return () => {
      generation.current += 1;
      pending.current = false;
      setInitialLoading(false);
      setLoadingMore(false);
    };
  }, [request]));

  return {
    items: offline ? undefined : current?.data,
    cachedItems: current?.data,
    loading: !offline && (initialLoading || (!current && !currentError)),
    error: offline ? 'Ngoại tuyến. Chưa có bản lưu cho màn này.' : currentError,
    offline, loadingMore,
    refresh: () => void request(),
    loadMore: !offline && current?.next !== undefined ? () => void request(current.next) : undefined,
  };
}

async function loadTimezone() {
  const profile = await driverProfileService.getProfile();
  return { data: [resolveDriverTimezone(profile.homeBranch.timezone)] };
}

export function useDriverScheduleTimezone() {
  const state = useDriverScheduleRead(loadTimezone);
  return { ...state, zone: state.cachedItems?.[0] };
}
