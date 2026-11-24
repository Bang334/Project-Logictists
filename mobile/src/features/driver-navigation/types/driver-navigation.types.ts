import type { OfflineStopPresentation } from "@/features/driver-offline/selectors/offline-driver-overlay";
import type { DriverTripStop } from "@/features/driver-trips/types/driver-trip.types";

export interface ExternalNavigationTarget {
  latitude: unknown;
  longitude: unknown;
}

export type DriverNavigationBasis = "SERVER" | "LOCAL_PENDING" | "PREVIEW";

export interface DriverNavigationSelection {
  stop: DriverTripStop;
  basis: DriverNavigationBasis;
  contextLabel: string;
  offlinePresentation: OfflineStopPresentation;
  coordinateValid: boolean;
  blockedReason: string | null;
}

export type ExternalNavigationErrorCode =
  | "INVALID_COORDINATE"
  | "OPEN_FAILED";
