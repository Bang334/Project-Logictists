import {
  firstLocallyActionableStop,
  stopOfflinePresentation,
} from "@/features/driver-offline/selectors/offline-driver-overlay";
import type { OfflineDriverCommand } from "@/features/driver-offline/types/offline-driver-command.types";
import { hasValidNavigationCoordinates } from "@/features/driver-navigation/services/external-navigation.service";
import type { DriverNavigationSelection } from "@/features/driver-navigation/types/driver-navigation.types";
import type {
  DriverTripDetail,
  DriverTripStop,
} from "@/features/driver-trips/types/driver-trip.types";

const BLOCKING_COMMAND_STATES = new Set(["CONFLICT", "FAILED", "BLOCKED"]);
const BLOCKED_NAVIGATION_MESSAGE =
  "Cần xử lý thao tác chưa đồng bộ tại điểm này trước khi điều hướng tiếp.";

function orderedStops(stops: DriverTripStop[]): DriverTripStop[] {
  return [...stops].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
}

function selection(
  stop: DriverTripStop,
  commands: OfflineDriverCommand[],
  values: Pick<
    DriverNavigationSelection,
    "basis" | "contextLabel" | "blockedReason"
  >,
): DriverNavigationSelection {
  return {
    stop,
    ...values,
    offlinePresentation: stopOfflinePresentation(stop.id, commands),
    coordinateValid: hasValidNavigationCoordinates(stop),
  };
}

export function selectDriverNavigationStop(
  trip: Pick<DriverTripDetail, "status" | "stops">,
  commands: OfflineDriverCommand[],
): DriverNavigationSelection | null {
  if (trip.status === "COMPLETED" || trip.status === "CANCELLED") {
    return null;
  }

  const stops = orderedStops(trip.stops);
  const stopIds = new Set(stops.map((stop) => stop.id));
  const relevantCommands = commands.filter(
    (command) => stopIds.has(command.stopId) && command.state !== "SYNCED",
  );
  const blockingCommand = [...relevantCommands]
    .filter((command) => BLOCKING_COMMAND_STATES.has(command.state))
    .sort((left, right) => left.sequence - right.sequence)[0];

  if (blockingCommand) {
    const problematicStop = stops.find(
      (stop) => stop.id === blockingCommand.stopId,
    );
    return problematicStop
      ? selection(problematicStop, relevantCommands, {
          basis: "LOCAL_PENDING",
          contextLabel: "Điểm cần xử lý đồng bộ",
          blockedReason: BLOCKED_NAVIGATION_MESSAGE,
        })
      : null;
  }

  const actionable = firstLocallyActionableStop(stops, relevantCommands);
  if (!actionable) return null;

  if (trip.status === "DISPATCHED") {
    return selection(actionable, relevantCommands, {
      basis: "PREVIEW",
      contextLabel: "Điểm xem trước",
      blockedReason: null,
    });
  }

  const presentation = stopOfflinePresentation(
    actionable.id,
    relevantCommands,
  );
  if (presentation === "ARRIVED_PENDING_SYNC") {
    return selection(actionable, relevantCommands, {
      basis: "LOCAL_PENDING",
      contextLabel: "Điểm hiện tại · chờ đồng bộ",
      blockedReason: null,
    });
  }

  const hasEarlierLocalCompletion = stops.some(
    (stop) =>
      stop.sequence < actionable.sequence &&
      stopOfflinePresentation(stop.id, relevantCommands) ===
        "COMPLETED_PENDING_SYNC",
  );
  if (hasEarlierLocalCompletion) {
    return selection(actionable, relevantCommands, {
      basis: "LOCAL_PENDING",
      contextLabel: "Tiếp theo trên thiết bị · chưa đồng bộ",
      blockedReason: null,
    });
  }

  return selection(actionable, relevantCommands, {
    basis: "SERVER",
    contextLabel:
      actionable.status === "ARRIVED" ? "Điểm hiện tại" : "Điểm tiếp theo",
    blockedReason: null,
  });
}
