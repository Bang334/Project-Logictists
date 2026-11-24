import { stopOfflinePresentation } from '@/features/driver-offline/selectors/offline-driver-overlay';
import type { OfflineDriverCommand } from '@/features/driver-offline/types/offline-driver-command.types';
import type { DriverLocalLocation } from '@/features/driver-tracking/types/driver-tracking.types';
import type { DriverTripDetail, DriverTripStop } from '@/features/driver-trips/types/driver-trip.types';
import { hasValidNavigationCoordinates } from '../services/external-navigation.service';
import { selectDriverNavigationStop } from './driver-navigation-stop.selector';
import type { DriverMapLocation, DriverMapMarker, DriverMapStopState } from '../types/driver-map.types';

const LOCATION_STALE_MS = 2 * 60 * 1000;

function stateForStop(
  stop: DriverTripStop,
  currentStopId: string | null,
  commands: OfflineDriverCommand[],
): DriverMapStopState {
  const presentation = stopOfflinePresentation(stop.id, commands);
  if (presentation === 'CONFLICT' || presentation === 'FAILED') return 'CONFLICT';
  if (presentation !== 'SERVER_CONFIRMED') return 'PENDING_SYNC';
  if (stop.status === 'COMPLETED') return 'COMPLETED';
  if (stop.status === 'SKIPPED') return 'SKIPPED';
  if (stop.id === currentStopId) return 'CURRENT';
  return 'UPCOMING';
}

const stopTypeLabels: Record<DriverTripStop['stopType'], string> = {
  DEPOT_START: 'Kho bắt đầu',
  PICKUP: 'Điểm lấy hàng',
  DELIVERY: 'Điểm giao hàng',
  DEPOT_END: 'Kho kết thúc',
};

const stateLabels: Record<DriverMapStopState, string> = {
  COMPLETED: 'đã hoàn thành',
  CURRENT: 'hiện tại hoặc tiếp theo',
  UPCOMING: 'sắp tới',
  PENDING_SYNC: 'chờ đồng bộ',
  CONFLICT: 'cần xử lý xung đột',
  SKIPPED: 'đã bỏ qua',
};

export function selectDriverMapMarkers(
  trip: Pick<DriverTripDetail, 'status' | 'stops'>,
  commands: OfflineDriverCommand[],
): { markers: DriverMapMarker[]; invalidCoordinateCount: number } {
  const navigation = selectDriverNavigationStop(trip, commands);
  const ordered = [...trip.stops].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const valid = ordered.filter(hasValidNavigationCoordinates);
  return {
    invalidCoordinateCount: ordered.length - valid.length,
    markers: valid.map((stop) => {
      const state = stateForStop(stop, navigation?.stop.id ?? null, commands);
      return {
        id: stop.id,
        sequence: stop.sequence,
        stopType: stop.stopType,
        address: stop.address,
        latitude: stop.latitude,
        longitude: stop.longitude,
        state,
        accessibilityLabel: `${stop.sequence}. ${stopTypeLabels[stop.stopType]}, ${stateLabels[state]}. ${stop.address}`,
      };
    }),
  };
}

export function selectDriverMapLocation(
  location: DriverLocalLocation | null,
  now = Date.now(),
): DriverMapLocation | null {
  if (!location) return null;
  const measuredAt = new Date(location.measuredAt).getTime();
  if (
    !Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90 ||
    !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180 ||
    !Number.isFinite(measuredAt)
  ) return null;
  return { ...location, isStale: now - measuredAt > LOCATION_STALE_MS };
}
