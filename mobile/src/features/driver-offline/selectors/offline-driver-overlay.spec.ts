import {
  firstLocallyActionableStop,
  stopOfflinePresentation,
} from "./offline-driver-overlay";
import type { OfflineDriverCommand } from "@/features/driver-offline/types/offline-driver-command.types";
import type { DriverTripStop } from "@/features/driver-trips/types/driver-trip.types";

function command(
  stopId: string,
  commandType: OfflineDriverCommand["commandType"],
  state: OfflineDriverCommand["state"] = "PENDING",
): OfflineDriverCommand {
  return {
    id: `${stopId}-${commandType}`,
    ownerUserId: "user-1",
    tripId: "trip-1",
    stopId,
    commandType,
    sequence: commandType === "ARRIVE_STOP" ? 1 : 2,
    idempotencyKey: "key",
    payload:
      commandType === "ARRIVE_STOP"
        ? { kind: "ARRIVE_STOP" }
        : { kind: "COMPLETE_STOP", tasks: [] },
    payloadFingerprint: "fingerprint",
    observedTripVersion: 1,
    wireExpectedVersion: null,
    transmissionState: "NEVER_SENT",
    state,
    occurredAt: "2026-11-18T00:00:00.000Z",
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverResult: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
    syncedAt: null,
  };
}

const stops = [
  { id: "stop-1", status: "PENDING" },
  { id: "stop-2", status: "PENDING" },
] as DriverTripStop[];

describe("offline driver overlay", () => {
  it("hiển thị trạng thái optimistic mà không sửa snapshot server", () => {
    const queued = command("stop-1", "ARRIVE_STOP");
    expect(stopOfflinePresentation("stop-1", [queued])).toBe(
      "ARRIVED_PENDING_SYNC",
    );
    expect(stops[0]?.status).toBe("PENDING");
  });

  it("bỏ qua stop đã complete cục bộ để mở stop kế tiếp", () => {
    const active = firstLocallyActionableStop(stops, [
      command("stop-1", "ARRIVE_STOP"),
      command("stop-1", "COMPLETE_STOP"),
    ]);
    expect(active?.id).toBe("stop-2");
  });

  it("ưu tiên cảnh báo conflict hơn optimistic state", () => {
    expect(
      stopOfflinePresentation("stop-1", [
        command("stop-1", "ARRIVE_STOP", "CONFLICT"),
      ]),
    ).toBe("CONFLICT");
  });
});
