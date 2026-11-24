import type { OfflineDriverCommand } from "@/features/driver-offline/types/offline-driver-command.types";
import type { DriverTripStop } from "@/features/driver-trips/types/driver-trip.types";

export type OfflineStopPresentation =
  | "SERVER_CONFIRMED"
  | "ARRIVED_PENDING_SYNC"
  | "COMPLETED_PENDING_SYNC"
  | "CONFLICT"
  | "FAILED";

export function stopOfflinePresentation(
  stopId: string,
  commands: OfflineDriverCommand[],
): OfflineStopPresentation {
  const stopCommands = commands
    .filter(
      (command) => command.stopId === stopId && command.state !== "SYNCED",
    )
    .sort((left, right) => left.sequence - right.sequence);
  if (stopCommands.some((command) => command.state === "CONFLICT")) {
    return "CONFLICT";
  }
  if (
    stopCommands.some((command) =>
      ["FAILED", "BLOCKED"].includes(command.state),
    )
  ) {
    return "FAILED";
  }
  if (stopCommands.some((command) => command.commandType === "COMPLETE_STOP")) {
    return "COMPLETED_PENDING_SYNC";
  }
  if (stopCommands.some((command) => command.commandType === "ARRIVE_STOP")) {
    return "ARRIVED_PENDING_SYNC";
  }
  return "SERVER_CONFIRMED";
}

export function firstLocallyActionableStop(
  stops: DriverTripStop[],
  commands: OfflineDriverCommand[],
) {
  return stops.find((stop) => {
    const presentation = stopOfflinePresentation(stop.id, commands);
    if (presentation === "COMPLETED_PENDING_SYNC") return false;
    return stop.status !== "COMPLETED" && stop.status !== "SKIPPED";
  });
}
