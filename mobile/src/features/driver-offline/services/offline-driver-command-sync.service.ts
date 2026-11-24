import type {
  OfflineDriverCommand,
  OfflineDriverCommandRepository,
} from "@/features/driver-offline/types/offline-driver-command.types";
import { driverTripsService } from "@/features/driver-trips/services/driver-trips.service";
import type {
  DriverStopCommandResponse,
  DriverTripDetail,
} from "@/features/driver-trips/types/driver-trip.types";
import { ApiError } from "@/shared/api/api-error";
import { offlineDriverIdentity } from "@/features/auth/services/offline-driver-identity";
import { offlineTripSnapshots } from "@/features/driver-trips/storage/offline-trip-snapshots";

const MAX_OFFLINE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const CONFLICT_CODES = new Set([
  "TRIP_VERSION_CONFLICT",
  "STOP_OUT_OF_SEQUENCE",
  "INVALID_STOP_STATE",
  "INVALID_TRIP_STATE",
  "INVALID_COMMAND_TIMESTAMP",
]);

export interface OfflineDriverCommandSyncDependencies {
  repository: OfflineDriverCommandRepository;
  getTrip(tripId: string): Promise<DriverTripDetail>;
  arrive(
    tripId: string,
    stopId: string,
    payload: {
      idempotencyKey: string;
      expectedTripVersion: number;
      occurredAt: string;
    },
  ): Promise<DriverStopCommandResponse>;
  complete(
    tripId: string,
    stopId: string,
    payload: {
      idempotencyKey: string;
      expectedTripVersion: number;
      occurredAt: string;
      tasks: { taskId: string; actualQuantity: number }[];
      deliveryResult?: "SUCCESS" | "PARTIAL" | "FAILED" | null;
      reasonCode?:
        | "PACKAGE_NOT_AVAILABLE"
        | "PACKAGE_DAMAGED"
        | "QUANTITY_MISMATCH"
        | "RECIPIENT_UNAVAILABLE"
        | "RECIPIENT_REFUSED"
        | "ADDRESS_ISSUE"
        | "ACCESS_RESTRICTED"
        | "OTHER"
        | null;
      note?: string | null;
      recipientName?: string | null;
    },
  ): Promise<DriverStopCommandResponse>;
  now(): Date;
  authorizeTrip?(tripId: string): Promise<boolean>;
}

export class DriverReplaySessionEnded extends Error {}

export type OfflineSyncResult =
  "SYNCED" | "IDLE" | "RETRY_WAIT" | "AUTH_PAUSED" | "CONFLICT" | "FAILED";

function retryDelayMs(retryCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 2 ** Math.min(retryCount, 8) * 1_000);
}

function sanitizedErrorMessage(error: ApiError): string {
  if (error.status === 401) return "AUTH_REQUIRED";
  if (CONFLICT_CODES.has(error.code)) return "SERVER_STATE_CONFLICT";
  if (error.status === 0 || error.status === 429 || error.status >= 500) {
    return "TEMPORARY_SYNC_FAILURE";
  }
  return "PERMANENT_SYNC_FAILURE";
}

function firstUnresolvedStop(trip: DriverTripDetail) {
  return trip.stops.find(
    (stop) => stop.status !== "COMPLETED" && stop.status !== "SKIPPED",
  );
}

function validatePrecondition(
  command: OfflineDriverCommand,
  trip: DriverTripDetail,
): string | null {
  if (
    trip.status !== "IN_PROGRESS" ||
    trip.assignment.role !== "PRIMARY" ||
    trip.assignment.status !== "ASSIGNED"
  ) {
    return "INVALID_TRIP_STATE";
  }
  const stop = trip.stops.find((item) => item.id === command.stopId);
  if (!stop || firstUnresolvedStop(trip)?.id !== command.stopId) {
    return "STOP_OUT_OF_SEQUENCE";
  }
  if (command.commandType === "ARRIVE_STOP") {
    return stop.status === "PENDING" ? null : "INVALID_STOP_STATE";
  }
  if (stop.status !== "ARRIVED" || command.payload.kind !== "COMPLETE_STOP") {
    return "INVALID_STOP_STATE";
  }
  const payloadTasks = new Map(
    command.payload.tasks.map((task) => [task.taskId, task.actualQuantity]),
  );
  if (
    payloadTasks.size !== stop.tasks.length ||
    stop.tasks.some((task) => {
      const actual = payloadTasks.get(task.id);
      const expectedPackageStatus =
        stop.stopType === "PICKUP" ? "ALLOCATED" : "LOADED";
      return (
        actual === undefined ||
        actual < 0 ||
        actual > task.plannedQuantity ||
        (task.package !== null && task.package.status !== expectedPackageStatus)
      );
    })
  ) {
    return "INVALID_TASK_EXECUTION";
  }
  return null;
}

export class OfflineDriverCommandSyncService {
  constructor(
    private readonly dependencies: OfflineDriverCommandSyncDependencies,
  ) {}

  async sync(ownerUserId: string): Promise<OfflineSyncResult> {
    await this.dependencies.repository.recoverInterrupted(ownerUserId);
    const commands =
      await this.dependencies.repository.listForOwner(ownerUserId);
    if (commands.length === 0) return "IDLE";

    const chainedVersion = new Map<string, number>();
    const haltedTrips = new Set<string>();
    const authorizedTrips = new Set<string>();
    let syncedAny = false;
    let finalResult: OfflineSyncResult = "IDLE";

    for (const command of commands) {
      if (command.state === "SYNCED") {
        if (command.serverResult) {
          chainedVersion.set(command.tripId, command.serverResult.tripVersion);
        }
        continue;
      }
      if (haltedTrips.has(command.tripId)) continue;
      if (["CONFLICT", "FAILED", "BLOCKED"].includes(command.state)) {
        haltedTrips.add(command.tripId);
        continue;
      }
      if (command.state === "AUTH_PAUSED") {
        return "AUTH_PAUSED";
      }
      if (
        command.state === "RETRY_WAIT" &&
        command.nextRetryAt &&
        new Date(command.nextRetryAt).getTime() >
          this.dependencies.now().getTime()
      ) {
        haltedTrips.add(command.tripId);
        finalResult = "RETRY_WAIT";
        continue;
      }

      if (this.dependencies.authorizeTrip && !authorizedTrips.has(command.tripId)) {
        if (!(await this.dependencies.authorizeTrip(command.tripId))) {
          haltedTrips.add(command.tripId);
          continue;
        }
        authorizedTrips.add(command.tripId);
      }
      const result = await this.syncOne(
        ownerUserId,
        command,
        chainedVersion.get(command.tripId) ?? null,
      );
      finalResult = result.kind;
      if (result.kind === "SYNCED") {
        syncedAny = true;
        chainedVersion.set(command.tripId, result.tripVersion);
        continue;
      }
      if (result.kind === "AUTH_PAUSED") return result.kind;
      haltedTrips.add(command.tripId);
    }

    for (const tripId of new Set(
      commands
        .filter((command) => command.state === "SYNCED")
        .map((command) => command.tripId),
    )) {
      try {
        await this.dependencies.getTrip(tripId);
        await this.dependencies.repository.deleteSyncedForTrip(
          ownerUserId,
          tripId,
        );
      } catch {
        // Keep SYNCED rows until an authoritative refetch succeeds.
      }
    }
    for (const tripId of chainedVersion.keys()) {
      try {
        await this.dependencies.getTrip(tripId);
        await this.dependencies.repository.deleteSyncedForTrip(
          ownerUserId,
          tripId,
        );
      } catch {
        // Keep SYNCED rows until an authoritative refetch succeeds.
      }
    }
    return syncedAny ? "SYNCED" : finalResult;
  }

  private async syncOne(
    ownerUserId: string,
    command: OfflineDriverCommand,
    chainedVersion: number | null,
  ): Promise<{ kind: OfflineSyncResult; tripVersion: number }> {
    let expectedVersion = command.wireExpectedVersion;
    if (command.transmissionState === "NEVER_SENT") {
      if (
        this.dependencies.now().getTime() -
          new Date(command.occurredAt).getTime() >
        MAX_OFFLINE_AGE_MS
      ) {
        await this.markTerminal(
          ownerUserId,
          command,
          "CONFLICT",
          "OFFLINE_COMMAND_EXPIRED",
        );
        return { kind: "CONFLICT", tripVersion: command.observedTripVersion };
      }
      let trip: DriverTripDetail;
      try {
        trip = await this.dependencies.getTrip(command.tripId);
      } catch (error) {
        return this.handleError(ownerUserId, command, error);
      }
      const canChain =
        chainedVersion !== null && trip.version === chainedVersion;
      if (trip.version !== command.observedTripVersion && !canChain) {
        await this.markTerminal(
          ownerUserId,
          command,
          "CONFLICT",
          "EXTERNAL_VERSION_CHANGE",
        );
        return { kind: "CONFLICT", tripVersion: trip.version };
      }
      const preconditionError = validatePrecondition(command, trip);
      if (preconditionError) {
        await this.markTerminal(
          ownerUserId,
          command,
          "CONFLICT",
          preconditionError,
        );
        return { kind: "CONFLICT", tripVersion: trip.version };
      }
      expectedVersion = trip.version;
      await this.dependencies.repository.update(ownerUserId, command.id, {
        state: "SYNCING",
        transmissionState: "SENT_UNCERTAIN",
        wireExpectedVersion: expectedVersion,
        nextRetryAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    } else {
      if (expectedVersion === null) {
        await this.markTerminal(
          ownerUserId,
          command,
          "FAILED",
          "WIRE_VERSION_MISSING",
        );
        return { kind: "FAILED", tripVersion: command.observedTripVersion };
      }
      await this.dependencies.repository.update(ownerUserId, command.id, {
        state: "SYNCING",
      });
    }

    try {
      const response = await this.send(command, expectedVersion);
      const syncedAt = this.dependencies.now().toISOString();
      await this.dependencies.repository.update(ownerUserId, command.id, {
        state: "SYNCED",
        serverResult: response,
        syncedAt,
        nextRetryAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
      return { kind: "SYNCED", tripVersion: response.tripVersion };
    } catch (error) {
      return this.handleError(ownerUserId, command, error);
    }
  }

  private send(command: OfflineDriverCommand, expectedVersion: number) {
    const base = {
      idempotencyKey: command.idempotencyKey,
      expectedTripVersion: expectedVersion,
      occurredAt: command.occurredAt,
    };
    if (command.commandType === "ARRIVE_STOP") {
      return this.dependencies.arrive(command.tripId, command.stopId, base);
    }
    if (command.payload.kind !== "COMPLETE_STOP") {
      throw new Error("OFFLINE_COMMAND_PAYLOAD_INVALID");
    }
    return this.dependencies.complete(command.tripId, command.stopId, {
      ...base,
      tasks: command.payload.tasks,
      deliveryResult: command.payload.deliveryResult,
      reasonCode: command.payload.reasonCode,
      note: command.payload.note,
      recipientName: command.payload.recipientName,
    });
  }

  private async handleError(
    ownerUserId: string,
    command: OfflineDriverCommand,
    error: unknown,
  ): Promise<{ kind: OfflineSyncResult; tripVersion: number }> {
    if (error instanceof DriverReplaySessionEnded) throw error;
    if (!(error instanceof ApiError)) {
      await this.markTerminal(
        ownerUserId,
        command,
        "FAILED",
        "UNEXPECTED_SYNC_ERROR",
      );
      return { kind: "FAILED", tripVersion: command.observedTripVersion };
    }
    if (error.status === 401) {
      await this.dependencies.repository.update(ownerUserId, command.id, {
        state: "AUTH_PAUSED",
        lastErrorCode: error.code,
        lastErrorMessage: sanitizedErrorMessage(error),
      });
      return { kind: "AUTH_PAUSED", tripVersion: command.observedTripVersion };
    }
    if (CONFLICT_CODES.has(error.code)) {
      await this.markTerminal(ownerUserId, command, "CONFLICT", error.code);
      return { kind: "CONFLICT", tripVersion: command.observedTripVersion };
    }
    const retryable =
      (error.status === 0 &&
        ["NETWORK_ERROR", "REQUEST_TIMEOUT"].includes(error.code)) ||
      error.status === 429 ||
      error.status >= 500;
    if (retryable) {
      const retryCount = command.retryCount + 1;
      await this.dependencies.repository.update(ownerUserId, command.id, {
        state: "RETRY_WAIT",
        retryCount,
        nextRetryAt: new Date(
          this.dependencies.now().getTime() + retryDelayMs(retryCount),
        ).toISOString(),
        lastErrorCode: error.code,
        lastErrorMessage: sanitizedErrorMessage(error),
      });
      return { kind: "RETRY_WAIT", tripVersion: command.observedTripVersion };
    }
    await this.markTerminal(ownerUserId, command, "FAILED", error.code);
    return { kind: "FAILED", tripVersion: command.observedTripVersion };
  }

  private async markTerminal(
    ownerUserId: string,
    command: OfflineDriverCommand,
    state: "CONFLICT" | "FAILED",
    errorCode: string,
  ) {
    await this.dependencies.repository.update(ownerUserId, command.id, {
      state,
      lastErrorCode: errorCode,
      lastErrorMessage:
        state === "CONFLICT"
          ? "SERVER_STATE_CONFLICT"
          : "PERMANENT_SYNC_FAILURE",
    });
    await this.dependencies.repository.blockDescendants(
      ownerUserId,
      command.tripId,
      command.sequence,
    );
  }
}

export function createOfflineDriverCommandSyncService(
  repository: OfflineDriverCommandRepository,
  token: string,
  isCurrent: () => boolean,
) {
  function assertCurrent() {
    if (!isCurrent()) throw new DriverReplaySessionEnded();
  }
  const getTrip = (tripId: string) => {
    assertCurrent();
    return driverTripsService.getTrip(tripId, token);
  };
  return new OfflineDriverCommandSyncService({
    repository,
    getTrip,
    async authorizeTrip(tripId) {
      const checkedAt = Date.now();
      try {
        const trip = await getTrip(tripId);
        assertCurrent();
        const identity = await offlineDriverIdentity.read(token);
        if (identity && trip.id === tripId) {
          await offlineTripSnapshots.save(identity, trip, checkedAt).catch(() => undefined);
        }
        assertCurrent();
        return trip.id === tripId && trip.assignment.role === 'PRIMARY' && trip.assignment.status === 'ASSIGNED';
      } catch (error) {
        if (error instanceof DriverReplaySessionEnded || (error instanceof ApiError && error.status === 401)) throw error;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          const identity = await offlineDriverIdentity.read(token);
          if (identity) await offlineTripSnapshots.invalidate(identity, tripId, checkedAt).catch(() => undefined);
        }
        return false;
      }
    },
    arrive(tripId, stopId, payload) {
      assertCurrent();
      return driverTripsService.arriveStop(tripId, stopId, payload, token);
    },
    complete(tripId, stopId, payload) {
      assertCurrent();
      return driverTripsService.completeStop(tripId, stopId, payload, token);
    },
    now: () => new Date(),
  });
}
