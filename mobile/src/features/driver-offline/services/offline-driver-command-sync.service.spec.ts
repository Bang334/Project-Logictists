import {
  OfflineDriverCommandSyncService,
  type OfflineDriverCommandSyncDependencies,
} from "./offline-driver-command-sync.service";
import type {
  OfflineDriverCommand,
  OfflineDriverCommandRepository,
} from "@/features/driver-offline/types/offline-driver-command.types";
import type {
  DriverStopCommandResponse,
  DriverTripDetail,
} from "@/features/driver-trips/types/driver-trip.types";
import { ApiError } from "@/shared/api/api-error";

class MemoryRepository implements OfflineDriverCommandRepository {
  constructor(public commands: OfflineDriverCommand[]) {}

  async enqueue(): Promise<OfflineDriverCommand> {
    throw new Error("not used");
  }

  async listForOwner(ownerUserId: string) {
    return this.commands
      .filter((command) => command.ownerUserId === ownerUserId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async update(
    ownerUserId: string,
    commandId: string,
    changes: Parameters<OfflineDriverCommandRepository["update"]>[2],
  ) {
    const command = this.commands.find(
      (item) => item.ownerUserId === ownerUserId && item.id === commandId,
    );
    if (command) Object.assign(command, changes);
  }

  async blockDescendants(
    ownerUserId: string,
    tripId: string,
    sequence: number,
  ) {
    for (const command of this.commands) {
      if (
        command.ownerUserId === ownerUserId &&
        command.tripId === tripId &&
        command.sequence > sequence &&
        !["SYNCED", "CONFLICT", "FAILED"].includes(command.state)
      ) {
        command.state = "BLOCKED";
      }
    }
  }

  async deleteSyncedForTrip(ownerUserId: string, tripId: string) {
    this.commands = this.commands.filter(
      (command) =>
        command.ownerUserId !== ownerUserId ||
        command.tripId !== tripId ||
        command.state !== "SYNCED",
    );
  }

  async recoverInterrupted(ownerUserId: string) {
    for (const command of this.commands) {
      if (command.ownerUserId === ownerUserId && command.state === "SYNCING") {
        command.state = "PENDING";
      }
    }
  }
}

function queuedCommand(
  overrides: Partial<OfflineDriverCommand> = {},
): OfflineDriverCommand {
  return {
    id: "command-1",
    ownerUserId: "owner-1",
    tripId: "trip-1",
    stopId: "stop-1",
    commandType: "ARRIVE_STOP",
    sequence: 1,
    idempotencyKey: "idempotency-1",
    payload: { kind: "ARRIVE_STOP" },
    payloadFingerprint: "fingerprint-1",
    observedTripVersion: 2,
    wireExpectedVersion: null,
    transmissionState: "NEVER_SENT",
    state: "PENDING",
    occurredAt: "2026-11-18T11:00:00.000Z",
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverResult: null,
    createdAt: "2026-11-18T11:00:00.000Z",
    updatedAt: "2026-11-18T11:00:00.000Z",
    syncedAt: null,
    ...overrides,
  };
}

function trip(
  version: number,
  stopStatus: "PENDING" | "ARRIVED",
): DriverTripDetail {
  return {
    id: "trip-1",
    tripNumber: "QA-OFFLINE-1",
    status: "IN_PROGRESS",
    version,
    assignment: {
      id: "assignment-1",
      role: "PRIMARY",
      status: "ASSIGNED",
      startTime: "2026-11-18T10:00:00.000Z",
      endTime: "2026-11-18T14:00:00.000Z",
    },
    stops: [
      {
        id: "stop-1",
        sequence: 1,
        stopType: "PICKUP",
        status: stopStatus,
        tasks: [
          {
            id: "task-1",
            action: "LOAD",
            plannedQuantity: 2,
            actualQuantity: null,
            order: null,
            package: {
              id: "package-1",
              packageCode: "PKG-1",
              weightKg: 10,
              lengthCm: 10,
              widthCm: 10,
              heightCm: 10,
              status: "ALLOCATED",
            },
          },
        ],
      },
    ],
  } as DriverTripDetail;
}

function stopResponse(version: number): DriverStopCommandResponse {
  return {
    tripId: "trip-1",
    tripVersion: version,
    eventType: "STOP_ARRIVED",
    stop: { id: "stop-1", status: "ARRIVED" },
    deliveryAttempt: null,
  };
}

function dependencies(
  repository: OfflineDriverCommandRepository,
): OfflineDriverCommandSyncDependencies {
  return {
    repository,
    getTrip: jest.fn(async () => trip(2, "PENDING")),
    arrive: jest.fn(async () => stopResponse(3)),
    complete: jest.fn(async (): Promise<DriverStopCommandResponse> => ({
      ...stopResponse(4),
      eventType: "STOP_COMPLETED",
      stop: { id: "stop-1", status: "COMPLETED" },
    })),
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  };
}

describe("OfflineDriverCommandSyncService", () => {
  it("giữ nguyên lệnh SENT_UNCERTAIN nếu chuyến chưa được phép phát lại", async () => {
    const command = queuedCommand({ transmissionState: "SENT_UNCERTAIN", wireExpectedVersion: 7 });
    const repository = new MemoryRepository([command]);
    const deps = { ...dependencies(repository), authorizeTrip: jest.fn(async () => false) };
    await new OfflineDriverCommandSyncService(deps).sync("owner-1");
    expect(deps.authorizeTrip).toHaveBeenCalledWith("trip-1");
    expect(deps.arrive).not.toHaveBeenCalled();
    expect(repository.commands).toEqual([command]);
  });

  it("đồng bộ tuần tự ARRIVE rồi COMPLETE và rebase theo version vừa trả về", async () => {
    const repository = new MemoryRepository([
      queuedCommand(),
      queuedCommand({
        id: "command-2",
        commandType: "COMPLETE_STOP",
        sequence: 2,
        idempotencyKey: "idempotency-2",
        payload: {
          kind: "COMPLETE_STOP",
          tasks: [{ taskId: "task-1", actualQuantity: 2 }],
        },
      }),
    ]);
    const deps = dependencies(repository);
    jest
      .mocked(deps.getTrip)
      .mockResolvedValueOnce(trip(2, "PENDING"))
      .mockResolvedValueOnce(trip(3, "ARRIVED"))
      .mockResolvedValue(trip(4, "ARRIVED"));

    await expect(
      new OfflineDriverCommandSyncService(deps).sync("owner-1"),
    ).resolves.toBe("SYNCED");

    expect(deps.arrive).toHaveBeenCalledWith(
      "trip-1",
      "stop-1",
      expect.objectContaining({
        expectedTripVersion: 2,
        occurredAt: "2026-11-18T11:00:00.000Z",
      }),
    );
    expect(deps.complete).toHaveBeenCalledWith(
      "trip-1",
      "stop-1",
      expect.objectContaining({ expectedTripVersion: 3 }),
    );
    expect(repository.commands).toHaveLength(0);
  });

  it("replay SENT_UNCERTAIN với đúng key, payload, occurredAt và wire version", async () => {
    const repository = new MemoryRepository([
      queuedCommand({
        transmissionState: "SENT_UNCERTAIN",
        wireExpectedVersion: 7,
        state: "RETRY_WAIT",
        nextRetryAt: null,
      }),
    ]);
    const deps = dependencies(repository);
    await new OfflineDriverCommandSyncService(deps).sync("owner-1");

    expect(deps.arrive).toHaveBeenCalledWith("trip-1", "stop-1", {
      idempotencyKey: "idempotency-1",
      expectedTripVersion: 7,
      occurredAt: "2026-11-18T11:00:00.000Z",
    });
  });

  it("không tự rebase khi server version đổi từ nguồn bên ngoài", async () => {
    const repository = new MemoryRepository([
      queuedCommand(),
      queuedCommand({ id: "command-2", sequence: 2 }),
    ]);
    const deps = dependencies(repository);
    jest.mocked(deps.getTrip).mockResolvedValue(trip(9, "PENDING"));

    await expect(
      new OfflineDriverCommandSyncService(deps).sync("owner-1"),
    ).resolves.toBe("CONFLICT");
    expect(deps.arrive).not.toHaveBeenCalled();
    expect(repository.commands[0]?.state).toBe("CONFLICT");
    expect(repository.commands[1]?.state).toBe("BLOCKED");
  });

  it("giữ SENT_UNCERTAIN và lên lịch retry khi timeout", async () => {
    const repository = new MemoryRepository([queuedCommand()]);
    const deps = dependencies(repository);
    jest
      .mocked(deps.arrive)
      .mockRejectedValue(new ApiError("timeout", 0, "REQUEST_TIMEOUT"));

    await expect(
      new OfflineDriverCommandSyncService(deps).sync("owner-1"),
    ).resolves.toBe("RETRY_WAIT");
    expect(repository.commands[0]).toMatchObject({
      state: "RETRY_WAIT",
      transmissionState: "SENT_UNCERTAIN",
      wireExpectedVersion: 2,
      retryCount: 1,
    });
  });

  it("retry HTTP 5xx nhưng không retry lỗi permanent và block descendants", async () => {
    const retryRepository = new MemoryRepository([queuedCommand()]);
    const retryDeps = dependencies(retryRepository);
    jest
      .mocked(retryDeps.arrive)
      .mockRejectedValue(new ApiError("server", 503, "SERVICE_UNAVAILABLE"));
    await new OfflineDriverCommandSyncService(retryDeps).sync("owner-1");
    expect(retryRepository.commands[0]?.state).toBe("RETRY_WAIT");

    const failedRepository = new MemoryRepository([
      queuedCommand(),
      queuedCommand({ id: "command-2", sequence: 2 }),
    ]);
    const failedDeps = dependencies(failedRepository);
    jest
      .mocked(failedDeps.arrive)
      .mockRejectedValue(new ApiError("forbidden", 403, "DRIVER_NOT_PRIMARY"));
    await new OfflineDriverCommandSyncService(failedDeps).sync("owner-1");
    expect(failedRepository.commands[0]?.state).toBe("FAILED");
    expect(failedRepository.commands[1]?.state).toBe("BLOCKED");
  });

  it("đánh dấu conflict thay vì sửa occurredAt khi command NEVER_SENT quá 24 giờ", async () => {
    const repository = new MemoryRepository([
      queuedCommand({ occurredAt: "2026-11-17T11:59:59.000Z" }),
    ]);
    const deps = dependencies(repository);
    await new OfflineDriverCommandSyncService(deps).sync("owner-1");
    expect(deps.getTrip).not.toHaveBeenCalled();
    expect(deps.arrive).not.toHaveBeenCalled();
    expect(repository.commands[0]).toMatchObject({
      state: "CONFLICT",
      occurredAt: "2026-11-17T11:59:59.000Z",
      lastErrorCode: "OFFLINE_COMMAND_EXPIRED",
    });
  });

  it("tạm dừng queue khi token hết hạn và không đụng command owner khác", async () => {
    const repository = new MemoryRepository([
      queuedCommand(),
      queuedCommand({ id: "other", ownerUserId: "owner-2" }),
    ]);
    const deps = dependencies(repository);
    jest
      .mocked(deps.arrive)
      .mockRejectedValue(new ApiError("unauthorized", 401, "UNAUTHORIZED"));

    await expect(
      new OfflineDriverCommandSyncService(deps).sync("owner-1"),
    ).resolves.toBe("AUTH_PAUSED");
    expect(repository.commands[0]?.state).toBe("AUTH_PAUSED");
    expect(repository.commands[1]?.state).toBe("PENDING");

    jest.mocked(deps.arrive).mockResolvedValue(stopResponse(3));
    await new OfflineDriverCommandSyncService(deps).sync("owner-1");
    expect(deps.arrive).toHaveBeenCalledTimes(1);

    await repository.update("owner-1", "command-1", { state: "PENDING" });
    await new OfflineDriverCommandSyncService(deps).sync("owner-1");
    expect(deps.arrive).toHaveBeenCalledTimes(2);
  });
});
jest.mock('@/features/driver-trips/storage/offline-trip-snapshots', () => ({
  offlineTripSnapshots: { save: jest.fn(), invalidate: jest.fn() },
}));
