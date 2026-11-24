import { selectDriverNavigationStop } from "./driver-navigation-stop.selector";
import type { OfflineDriverCommand } from "@/features/driver-offline/types/offline-driver-command.types";
import type {
  DriverTripDetail,
  DriverTripStop,
} from "@/features/driver-trips/types/driver-trip.types";

function stop(
  id: string,
  sequence: number,
  values: Partial<DriverTripStop> = {},
): DriverTripStop {
  return {
    id,
    sequence,
    stopType: "PICKUP",
    status: "PENDING",
    address: `Address ${sequence}`,
    latitude: 10 + sequence,
    longitude: 106 + sequence,
    contactName: null,
    contactPhone: null,
    plannedArrivalTime: null,
    plannedDepartureTime: null,
    actualArrivalTime: null,
    actualDepartureTime: null,
    tasks: [],
    ...values,
  };
}

function trip(
  status: DriverTripDetail["status"],
  stops: DriverTripStop[],
): Pick<DriverTripDetail, "status" | "stops"> {
  return { status, stops };
}

function command(
  stopId: string,
  commandType: OfflineDriverCommand["commandType"],
  state: OfflineDriverCommand["state"] = "PENDING",
  sequence = 1,
): OfflineDriverCommand {
  return {
    id: `${stopId}-${commandType}-${state}`,
    ownerUserId: "user-1",
    tripId: "trip-1",
    stopId,
    commandType,
    sequence,
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
    occurredAt: "2026-11-19T00:00:00.000Z",
    retryCount: 0,
    nextRetryAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    serverResult: null,
    createdAt: "2026-11-19T00:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    syncedAt: null,
  };
}

describe("driver navigation stop selector", () => {
  it("chọn Stop đầu tiên để xem trước cho DISPATCHED", () => {
    const selected = selectDriverNavigationStop(
      trip("DISPATCHED", [stop("stop-2", 2), stop("stop-1", 1)]),
      [],
    );
    expect(selected).toMatchObject({
      stop: { id: "stop-1" },
      basis: "PREVIEW",
      contextLabel: "Điểm xem trước",
    });
  });

  it("chọn PENDING Stop đầu tiên cho IN_PROGRESS", () => {
    const selected = selectDriverNavigationStop(
      trip("IN_PROGRESS", [stop("stop-1", 1), stop("stop-2", 2)]),
      [],
    );
    expect(selected).toMatchObject({
      stop: { id: "stop-1" },
      basis: "SERVER",
      contextLabel: "Điểm tiếp theo",
    });
  });

  it("giữ ARRIVED Stop làm điểm hiện tại", () => {
    const selected = selectDriverNavigationStop(
      trip("IN_PROGRESS", [stop("stop-1", 1, { status: "ARRIVED" })]),
      [],
    );
    expect(selected?.contextLabel).toBe("Điểm hiện tại");
  });

  it("bỏ qua Stop server đã hoàn tất theo sequence", () => {
    const selected = selectDriverNavigationStop(
      trip("IN_PROGRESS", [
        stop("stop-2", 2),
        stop("stop-1", 1, { status: "COMPLETED" }),
      ]),
      [],
    );
    expect(selected?.stop.id).toBe("stop-2");
  });

  it("giữ Stop có ARRIVE pending local làm điểm hiện tại", () => {
    const selected = selectDriverNavigationStop(
      trip("IN_PROGRESS", [stop("stop-1", 1), stop("stop-2", 2)]),
      [command("stop-1", "ARRIVE_STOP")],
    );
    expect(selected).toMatchObject({
      stop: { id: "stop-1" },
      basis: "LOCAL_PENDING",
      contextLabel: "Điểm hiện tại · chờ đồng bộ",
    });
  });

  it("trình bày Stop sau là local pending khi COMPLETE chưa sync", () => {
    const selected = selectDriverNavigationStop(
      trip("IN_PROGRESS", [stop("stop-1", 1), stop("stop-2", 2)]),
      [
        command("stop-1", "ARRIVE_STOP", "PENDING", 1),
        command("stop-1", "COMPLETE_STOP", "PENDING", 2),
      ],
    );
    expect(selected).toMatchObject({
      stop: { id: "stop-2" },
      basis: "LOCAL_PENDING",
      contextLabel: "Tiếp theo trên thiết bị · chưa đồng bộ",
    });
  });

  it.each(["CONFLICT", "FAILED", "BLOCKED"] as const)(
    "không quảng bá Stop sau khi queue ở trạng thái %s",
    (state) => {
      const selected = selectDriverNavigationStop(
        trip("IN_PROGRESS", [stop("stop-1", 1), stop("stop-2", 2)]),
        [command("stop-1", "ARRIVE_STOP", state)],
      );
      expect(selected).toMatchObject({
        stop: { id: "stop-1" },
        contextLabel: "Điểm cần xử lý đồng bộ",
      });
      expect(selected?.blockedReason).toBeTruthy();
    },
  );

  it("không trả target khi mọi Stop đã hoàn tất", () => {
    expect(
      selectDriverNavigationStop(
        trip("IN_PROGRESS", [
          stop("stop-1", 1, { status: "COMPLETED" }),
          stop("stop-2", 2, { status: "SKIPPED" }),
        ]),
        [],
      ),
    ).toBeNull();
  });

  it("hỗ trợ Depot Stop", () => {
    const selected = selectDriverNavigationStop(
      trip("DISPATCHED", [
        stop("depot", 1, { stopType: "DEPOT_START" }),
      ]),
      [],
    );
    expect(selected).toMatchObject({
      stop: { id: "depot", stopType: "DEPOT_START" },
      coordinateValid: true,
    });
  });

  it("đánh dấu coordinate ngoài phạm vi là không hợp lệ", () => {
    const selected = selectDriverNavigationStop(
      trip("DISPATCHED", [stop("stop-1", 1, { latitude: 91 })]),
      [],
    );
    expect(selected?.coordinateValid).toBe(false);
  });

  it("đánh dấu coordinate bị thiếu ở runtime là không hợp lệ", () => {
    const selected = selectDriverNavigationStop(
      trip("DISPATCHED", [
        stop("stop-1", 1, { latitude: undefined as never }),
      ]),
      [],
    );
    expect(selected?.coordinateValid).toBe(false);
  });

  it("không trả target cho COMPLETED hoặc CANCELLED", () => {
    expect(
      selectDriverNavigationStop(
        trip("COMPLETED", [stop("stop-1", 1)]),
        [],
      ),
    ).toBeNull();
    expect(
      selectDriverNavigationStop(
        trip("CANCELLED", [stop("stop-1", 1)]),
        [],
      ),
    ).toBeNull();
  });
});
