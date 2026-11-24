import { act, renderHook } from "@testing-library/react-native";
import NetInfo from "@react-native-community/netinfo";
import * as Crypto from "expo-crypto";
import { offlineDriverExecutionCoordinator } from "@/features/driver-offline/services/offline-driver-execution.coordinator";
import { driverTripsService } from "@/features/driver-trips/services/driver-trips.service";
import { ApiError } from "@/shared/api/api-error";
import { useDriverTripExecution } from "./useDriverTripExecution";

const mockHandleError = jest.fn(async (error: unknown) =>
  error instanceof Error ? error.message : "Lỗi",
);

jest.mock("expo-crypto", () => ({ randomUUID: jest.fn() }));
jest.mock("@react-native-community/netinfo", () => ({ fetch: jest.fn() }));
jest.mock("@/features/auth/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "driver-user-1", role: "DRIVER" } }),
}));
jest.mock(
  "@/features/driver-offline/services/offline-driver-execution.coordinator",
  () => ({
    offlineDriverExecutionCoordinator: {
      enqueue: jest.fn(),
      hasUnsynced: jest.fn(),
    },
  }),
);
jest.mock("@/features/driver-trips/services/driver-trips.service", () => ({
  driverTripsService: {
    startTrip: jest.fn(),
    arriveStop: jest.fn(),
    completeStop: jest.fn(),
    completeTrip: jest.fn(),
  },
}));
jest.mock("./useDriverTripApiError", () => ({
  useDriverTripApiError: () => mockHandleError,
}));

describe("useDriverTripExecution", () => {
  const reload = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Crypto.randomUUID).mockReset();
    jest
      .mocked(Crypto.randomUUID)
      .mockReturnValueOnce("key-1")
      .mockReturnValueOnce("key-2")
      .mockReturnValue("key-next");
    jest.mocked(NetInfo.fetch).mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
    } as never);
    jest.mocked(offlineDriverExecutionCoordinator.enqueue).mockResolvedValue({
      queued: true,
      syncAttempted: true,
    });
    jest
      .mocked(offlineDriverExecutionCoordinator.hasUnsynced)
      .mockResolvedValue(false);
    jest.mocked(driverTripsService.startTrip).mockResolvedValue({
      id: "trip-1",
      status: "IN_PROGRESS",
      version: 3,
      actualStartTime: "2026-11-16T01:00:00.000Z",
    });
  });

  it("START_TRIP gửi current version và refetch sau success", async () => {
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(async () => {
      expect(
        await result.current.execute({
          command: "START_TRIP",
          tripId: "trip-1",
          expectedTripVersion: 2,
        }),
      ).toBe(true);
    });
    expect(driverTripsService.startTrip).toHaveBeenCalledWith("trip-1", {
      idempotencyKey: "key-1",
      expectedTripVersion: 2,
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("chỉ khởi động tracking sau khi START_TRIP được Backend xác nhận", async () => {
    const tracking = {
      onTripStarted: jest.fn(async () => undefined),
      onTripCompleted: jest.fn(async () => undefined),
      onCompleteUncertain: jest.fn(async () => undefined),
    };
    const { result } = await renderHook(() =>
      useDriverTripExecution(reload, tracking),
    );
    await act(async () => {
      await result.current.execute({
        command: "START_TRIP",
        tripId: "trip-1",
        expectedTripVersion: 2,
      });
    });
    expect(tracking.onTripStarted).toHaveBeenCalledWith(
      expect.objectContaining({ status: "IN_PROGRESS" }),
    );
  });

  it("timeout giữ key/payload để retry, không auto retry", async () => {
    jest
      .mocked(driverTripsService.startTrip)
      .mockRejectedValueOnce(new ApiError("Timeout", 0, "REQUEST_TIMEOUT"))
      .mockResolvedValueOnce({
        id: "trip-1",
        status: "IN_PROGRESS",
        version: 3,
      });
    const options = {
      command: "START_TRIP" as const,
      tripId: "trip-1",
      expectedTripVersion: 2,
    };
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(async () => void (await result.current.execute(options)));
    expect(driverTripsService.startTrip).toHaveBeenCalledTimes(1);
    expect(result.current.hasUncertainCommand).toBe(true);
    const firstKey = jest.mocked(driverTripsService.startTrip).mock
      .calls[0]?.[1].idempotencyKey;
    await act(async () => void (await result.current.execute(options)));
    expect(driverTripsService.startTrip).toHaveBeenNthCalledWith(2, "trip-1", {
      idempotencyKey: firstKey,
      expectedTripVersion: 2,
    });
  });

  it("payload đổi sau timeout dùng key mới", async () => {
    jest
      .mocked(driverTripsService.startTrip)
      .mockRejectedValue(new ApiError("Network", 0, "NETWORK_ERROR"));
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(
      async () =>
        void (await result.current.execute({
          command: "START_TRIP",
          tripId: "trip-1",
          expectedTripVersion: 2,
        })),
    );
    await act(
      async () =>
        void (await result.current.execute({
          command: "START_TRIP",
          tripId: "trip-1",
          expectedTripVersion: 3,
        })),
    );
    const calls = jest.mocked(driverTripsService.startTrip).mock.calls;
    expect(calls[1]?.[1].idempotencyKey).not.toBe(calls[0]?.[1].idempotencyKey);
  });

  it("double tap chỉ gửi một request", async () => {
    let resolveRequest!: () => void;
    jest.mocked(driverTripsService.startTrip).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = () =>
          resolve({ id: "trip-1", status: "IN_PROGRESS", version: 3 });
      }),
    );
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    const options = {
      command: "START_TRIP" as const,
      tripId: "trip-1",
      expectedTripVersion: 2,
    };
    let first!: Promise<boolean>;
    await act(async () => {
      first = result.current.execute(options);
      expect(await result.current.execute(options)).toBe(false);
      resolveRequest();
      await first;
    });
    expect(driverTripsService.startTrip).toHaveBeenCalledTimes(1);
  });

  it("version conflict refetch và hiển thị error code", async () => {
    jest
      .mocked(driverTripsService.startTrip)
      .mockRejectedValue(
        new ApiError("Conflict", 409, "TRIP_VERSION_CONFLICT"),
      );
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(
      async () =>
        void (await result.current.execute({
          command: "START_TRIP",
          tripId: "trip-1",
          expectedTripVersion: 2,
        })),
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.error).toContain("TRIP_VERSION_CONFLICT");
  });

  it("COMPLETE_STOP được lưu vào queue trước thay vì gọi API trực tiếp", async () => {
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(
      async () =>
        void (await result.current.execute({
          command: "COMPLETE_STOP",
          tripId: "trip-1",
          stopId: "stop-1",
          expectedTripVersion: 4,
          completion: {
            tasks: [{ taskId: "task-1", actualQuantity: 0 }],
            deliveryResult: "FAILED",
            reasonCode: "RECIPIENT_UNAVAILABLE",
            note: null,
            recipientName: null,
          },
        })),
    );
    expect(offlineDriverExecutionCoordinator.enqueue).toHaveBeenCalledWith({
      ownerUserId: "driver-user-1",
      tripId: "trip-1",
      stopId: "stop-1",
      commandType: "COMPLETE_STOP",
      observedTripVersion: 4,
      occurredAt: expect.any(String),
      payload: expect.objectContaining({
        kind: "COMPLETE_STOP",
        deliveryResult: "FAILED",
      }),
    });
    expect(driverTripsService.completeStop).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalled();
  });

  it("không COMPLETE_TRIP khi còn command chưa đồng bộ", async () => {
    jest
      .mocked(offlineDriverExecutionCoordinator.hasUnsynced)
      .mockResolvedValue(true);
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(async () => {
      expect(
        await result.current.execute({
          command: "COMPLETE_TRIP",
          tripId: "trip-1",
          expectedTripVersion: 8,
        }),
      ).toBe(false);
    });
    expect(driverTripsService.completeTrip).not.toHaveBeenCalled();
    expect(result.current.error).toContain("đồng bộ");
  });

  it("hiển thị lỗi rõ khi Backend yêu cầu e-POD trước Complete Trip", async () => {
    jest
      .mocked(driverTripsService.completeTrip)
      .mockRejectedValue(new ApiError("POD required", 409, "POD_REQUIRED"));
    const { result } = await renderHook(() => useDriverTripExecution(reload));
    await act(async () => {
      await result.current.execute({
        command: "COMPLETE_TRIP",
        tripId: "trip-1",
        expectedTripVersion: 8,
      });
    });
    expect(result.current.error).toContain("ảnh bằng chứng giao hàng");
    expect(result.current.error).toContain("POD_REQUIRED");
  });

  it("COMPLETE_TRIP timeout refetch trạng thái thay vì tự dừng tracking", async () => {
    jest
      .mocked(driverTripsService.completeTrip)
      .mockRejectedValue(new ApiError("Timeout", 0, "REQUEST_TIMEOUT"));
    const tracking = {
      onTripStarted: jest.fn(async () => undefined),
      onTripCompleted: jest.fn(async () => undefined),
      onCompleteUncertain: jest.fn(async () => undefined),
    };
    const { result } = await renderHook(() =>
      useDriverTripExecution(reload, tracking),
    );
    await act(async () => {
      await result.current.execute({
        command: "COMPLETE_TRIP",
        tripId: "trip-1",
        expectedTripVersion: 8,
      });
    });
    expect(tracking.onCompleteUncertain).toHaveBeenCalledTimes(1);
    expect(tracking.onTripCompleted).not.toHaveBeenCalled();
  });
});
