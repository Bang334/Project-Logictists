import { useEffect, useState } from 'react';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import { useDriverTrips } from '@/features/driver-trips/hooks/useDriverTrips';
import type { DriverTripDetail } from '@/features/driver-trips/types/driver-trip.types';
import { ApiError, toUserMessage } from '@/shared/api/api-error';
import { driverProfileService, type DriverSelfProfile } from '../services/driver-profile.service';

type ReadResult<T> = { data: T; error?: never } | { data?: never; error: string };

export function useDriverAccountData() {
  const upcoming = useDriverTrips('DISPATCHED');
  const active = useDriverTrips('IN_PROGRESS');
  const reloadUpcoming = upcoming.reload;
  const reloadActive = active.reload;
  const [reloadCount, setReloadCount] = useState(0);
  const [profile, setProfile] = useState<ReadResult<DriverSelfProfile>>();
  const [selectedId, setSelectedId] = useState<string>();
  const [tripDetail, setTripDetail] = useState<{ id: string; result: ReadResult<DriverTripDetail> }>();

  useEffect(() => {
    void reloadUpcoming();
    void reloadActive();
  }, [reloadUpcoming, reloadActive]);

  useEffect(() => {
    let current = true;
    void driverProfileService.getProfile().then(
      (data) => { if (current) setProfile({ data }); },
      (error: unknown) => {
        if (!current) return;
        setProfile({
          error: error instanceof ApiError && error.code === 'DRIVER_PROFILE_NOT_FOUND'
            ? 'Tài khoản chưa được liên kết với hồ sơ tài xế.'
            : toUserMessage(error),
        });
      },
    );
    return () => { current = false; };
  }, [reloadCount]);

  const trips = [...new Map([...upcoming.trips, ...active.trips].map((trip) => [trip.id, trip])).values()];
  const listsLoading = active.isInitialLoading || upcoming.isInitialLoading || active.isRefreshing || upcoming.isRefreshing;
  const listError = active.error ?? upcoming.error;
  const hasMore = active.hasMore || upcoming.hasMore;
  const automaticId = !listsLoading && !listError && !hasMore && trips.length === 1 ? trips[0]?.id : undefined;
  const trip = trips.find(({ id }) => id === (selectedId ?? automaticId));
  const tripId = trip?.id;

  useEffect(() => {
    if (!tripId) return;
    let current = true;
    void driverTripsService.getTrip(tripId).then(
      (data) => {
        if (!current) return;
        const result = data.id === tripId &&
          ['DISPATCHED', 'IN_PROGRESS'].includes(data.status) && data.assignment.status === 'ASSIGNED'
          ? { data }
          : { error: 'Chuyến không còn được phân công để vận hành.' };
        setTripDetail({ id: tripId, result });
      },
      (error: unknown) => {
        if (current) setTripDetail({ id: tripId, result: { error: toUserMessage(error) } });
      },
    );
    return () => { current = false; };
  }, [tripId, reloadCount]);

  return {
    profile,
    trips,
    trip,
    selectedVehicle: tripDetail?.id === tripId ? tripDetail?.result : undefined,
    selectTrip(id: string) {
      if (tripId === id) return;
      setTripDetail(undefined);
      setSelectedId(id);
    },
    listsLoading,
    listError: listError ?? active.loadMoreError ?? upcoming.loadMoreError,
    hasMore,
    loadingMore: active.isLoadingMore || upcoming.isLoadingMore,
    loadMore() {
      void active.loadMore();
      void upcoming.loadMore();
    },
    reload() {
      setProfile(undefined);
      setTripDetail(undefined);
      setReloadCount((count) => count + 1);
      void reloadActive();
      void reloadUpcoming();
    },
  };
}
