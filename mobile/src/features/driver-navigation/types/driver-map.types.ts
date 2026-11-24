import type { DriverStopType } from '@/features/driver-trips/types/driver-trip.types';

export type DriverMapStopState =
  | 'COMPLETED'
  | 'CURRENT'
  | 'UPCOMING'
  | 'PENDING_SYNC'
  | 'CONFLICT'
  | 'SKIPPED';

export interface DriverMapMarker {
  id: string;
  sequence: number;
  stopType: DriverStopType;
  address: string;
  latitude: number;
  longitude: number;
  state: DriverMapStopState;
  accessibilityLabel: string;
}

export interface DriverMapLocation {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  headingDeg?: number;
  measuredAt: string;
  isStale: boolean;
}
