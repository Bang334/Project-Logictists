import * as Linking from "expo-linking";
import type {
  ExternalNavigationErrorCode,
  ExternalNavigationTarget,
} from "@/features/driver-navigation/types/driver-navigation.types";

export const INVALID_NAVIGATION_COORDINATE_MESSAGE =
  "Điểm dừng chưa có tọa độ hợp lệ để điều hướng.";
export const EXTERNAL_NAVIGATION_OPEN_FAILED_MESSAGE =
  "Không thể mở ứng dụng bản đồ.";

export class ExternalNavigationError extends Error {
  constructor(
    public readonly code: ExternalNavigationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExternalNavigationError";
  }
}

export function hasValidNavigationCoordinates(
  target: ExternalNavigationTarget,
): target is { latitude: number; longitude: number } {
  return (
    typeof target.latitude === "number" &&
    Number.isFinite(target.latitude) &&
    target.latitude >= -90 &&
    target.latitude <= 90 &&
    typeof target.longitude === "number" &&
    Number.isFinite(target.longitude) &&
    target.longitude >= -180 &&
    target.longitude <= 180
  );
}

export function buildGoogleMapsNavigationUrl(
  target: ExternalNavigationTarget,
): string {
  if (!hasValidNavigationCoordinates(target)) {
    throw new ExternalNavigationError(
      "INVALID_COORDINATE",
      INVALID_NAVIGATION_COORDINATE_MESSAGE,
    );
  }

  const params = new URLSearchParams({
    api: "1",
    destination: `${target.latitude},${target.longitude}`,
    travelmode: "driving",
    dir_action: "navigate",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export async function openExternalNavigation(
  target: ExternalNavigationTarget,
): Promise<void> {
  const url = buildGoogleMapsNavigationUrl(target);
  try {
    await Linking.openURL(url);
  } catch {
    throw new ExternalNavigationError(
      "OPEN_FAILED",
      EXTERNAL_NAVIGATION_OPEN_FAILED_MESSAGE,
    );
  }
}
