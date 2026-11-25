import { apiClient } from "@/shared/api/api-client";
import { tokenStorage } from "@/shared/storage/token-storage";
import { driverTripsService, parseDriverTripDetail } from "./driver-trips.service";

jest.mock("@/shared/api/api-client", () => ({
  apiClient: { request: jest.fn() },
}));

jest.mock("@/shared/storage/token-storage", () => ({
  tokenStorage: { get: jest.fn() },
}));

const summary = {
  id: "trip-1",
  tripNumber: "TRIP-001",
  status: "DISPATCHED",
  version: 2,
  plannedStartTime: "2026-11-16T01:00:00.000Z",
  plannedEndTime: "2026-11-16T03:00:00.000Z",
  actualStartTime: null,
  actualEndTime: null,
  totalDistanceKm: 25.5,
  totalDurationMinutes: 120,
  vehicle: {
    id: "vehicle-1",
    plateNumber: "43C-12345",
    model: "Hino 500",
    vehicleType: "Truck",
  },
  assignment: {
    id: "assignment-1",
    role: "PRIMARY",
    status: "ASSIGNED",
    startTime: "2026-11-16T01:00:00.000Z",
    endTime: "2026-11-16T03:00:00.000Z",
  },
  stopCount: 2,
};

const stop = (sequence: number, action: "LOAD" | "UNLOAD") => ({
  id: `stop-${sequence}`,
  sequence,
  stopType: action === "LOAD" ? "PICKUP" : "DELIVERY",
  status: "PENDING",
  address: `Address ${sequence}`,
  latitude: 10 + sequence,
  longitude: 106 + sequence,
  contactName: "Contact",
  contactPhone: "0900000000",
  plannedArrivalTime: null,
  plannedDepartureTime: null,
  actualArrivalTime: null,
  actualDepartureTime: null,
  tasks: [
    {
      id: `task-${sequence}`,
      action,
      plannedQuantity: 1,
      actualQuantity: null,
      order: { id: "order-1", orderNumber: "ORD-001" },
      package: {
        id: "package-1",
        packageCode: "PKG-001",
        weightKg: 12.5,
        lengthCm: 120,
        widthCm: 80,
        heightCm: 60,
        status: "ALLOCATED",
      },
    },
  ],
});

it.each(["COMPLETED", "CANCELLED"])("redacts stop phone for all consumers of %s", (status) => {
  const trip = parseDriverTripDetail({ ...summary, status, stops: [stop(1, "LOAD")] });
  expect(trip.stops[0]).toMatchObject({ contactName: "Contact", address: "Address 1", contactPhone: null });
});

it('maps additive vehicle specifications and keeps legacy vehicle responses compatible', () => {
  expect(parseDriverTripDetail({ ...summary, stops: [] }).vehicle).toEqual(summary.vehicle);
  const data = parseDriverTripDetail({
    ...summary,
    vehicle: { ...summary.vehicle, payloadCapacityKg: 6000, volumeCapacityM3: 20,
      lengthCm: 620, widthCm: 242, heightCm: 255, currentLocation: { lat: 10, lng: 20 } },
    stops: [],
  });
  expect(data.vehicle).toEqual({ ...summary.vehicle,
    payloadCapacityKg: 6000, volumeCapacityM3: 20, lengthCm: 620, widthCm: 242, heightCm: 255,
  });
});

describe("driverTripsService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(tokenStorage.get).mockResolvedValue("secure-driver-token");
  });

  it("gọi list với pagination/status, không gửi driverId hoặc branchId", async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      items: [summary],
      page: 2,
      limit: 20,
      total: 21,
      totalPages: 2,
    });

    const result = await driverTripsService.getTrips(2, 20, "DISPATCHED");

    expect(apiClient.request).toHaveBeenCalledWith(
      "/driver/trips?page=2&limit=20&status=DISPATCHED",
      { token: "secure-driver-token" },
    );
    expect(result.items[0]).toMatchObject({
      tripNumber: "TRIP-001",
      assignment: { role: "PRIMARY", status: "ASSIGNED" },
    });
  });

  it("passes validated Planner geometry to the driver map", async () => {
    const route = { type: "LineString", coordinates: [[106, 21], [105, 20]] };
    jest.mocked(apiClient.request).mockResolvedValue({
      ...summary,
      routeGeometry: JSON.stringify(route),
      stops: [],
    });
    expect((await driverTripsService.getTrip("trip-1")).plannedRoute).toEqual(route);
  });

  it("map detail, sort stops và giữ LOAD/UNLOAD cùng package metrics", async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      ...summary,
      stops: [stop(2, "UNLOAD"), stop(1, "LOAD")],
    });

    const result = await driverTripsService.getTrip("trip-1");

    expect(apiClient.request).toHaveBeenCalledWith("/driver/trips/trip-1", {
      token: "secure-driver-token",
    });
    expect(result.stops.map((item) => item.sequence)).toEqual([1, 2]);
    expect(result.stops[0]?.tasks[0]).toMatchObject({
      action: "LOAD",
      package: {
        packageCode: "PKG-001",
        weightKg: 12.5,
        lengthCm: 120,
        widthCm: 80,
        heightCm: 60,
      },
    });
  });

  it("chỉ map allowlist và không giữ field nội bộ", async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      ...summary,
      planningSnapshot: { secret: true },
      routeGeometry: "secret-route",
      totalAmount: 999999,
      customer: { name: "Private Customer" },
      stops: [],
    });

    const result = await driverTripsService.getTrip("trip-1");
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("planningSnapshot");
    expect(serialized).not.toContain("routeGeometry");
    expect(serialized).not.toContain("totalAmount");
    expect(serialized).not.toContain("Private Customer");
  });

  it("từ chối response sai status/shape", async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      items: [{ ...summary, status: "PLANNED" }],
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });

    await expect(driverTripsService.getTrips()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("từ chối khi SecureStore không có token", async () => {
    jest.mocked(tokenStorage.get).mockResolvedValue(null);
    await expect(driverTripsService.getTrips()).rejects.toMatchObject({
      status: 401,
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("gọi đúng bốn mutation endpoint và không tự retry", async () => {
    jest
      .mocked(apiClient.request)
      .mockResolvedValueOnce({
        id: "trip-1",
        status: "IN_PROGRESS",
        version: 3,
        actualStartTime: "2026-11-16T01:00:00.000Z",
      })
      .mockResolvedValueOnce({
        tripId: "trip-1",
        tripVersion: 4,
        stop: {
          id: "stop-1",
          status: "ARRIVED",
          actualArrivalTime: "2026-11-16T01:30:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        tripId: "trip-1",
        tripVersion: 5,
        eventType: "DELIVERY_FAILED",
        stop: {
          id: "stop-1",
          status: "COMPLETED",
          actualDepartureTime: "2026-11-16T01:40:00.000Z",
        },
        deliveryAttempt: {
          id: "attempt-1",
          attemptNumber: 1,
          result: "FAILED",
        },
      })
      .mockResolvedValueOnce({
        id: "trip-1",
        status: "COMPLETED",
        version: 6,
        actualEndTime: "2026-11-16T02:00:00.000Z",
      });
    const base = { idempotencyKey: "key-1", expectedTripVersion: 2 };

    await driverTripsService.startTrip("trip-1", base);
    await driverTripsService.arriveStop("trip-1", "stop-1", {
      ...base,
      expectedTripVersion: 3,
      occurredAt: "2026-11-16T01:20:00.000Z",
    });
    await driverTripsService.completeStop("trip-1", "stop-1", {
      ...base,
      expectedTripVersion: 4,
      occurredAt: "2026-11-16T01:40:00.000Z",
      tasks: [{ taskId: "task-1", actualQuantity: 0 }],
      deliveryResult: "FAILED",
      reasonCode: "RECIPIENT_UNAVAILABLE",
    });
    await driverTripsService.completeTrip("trip-1", {
      ...base,
      expectedTripVersion: 5,
    });

    expect(apiClient.request).toHaveBeenNthCalledWith(
      1,
      "/driver/trips/trip-1/start",
      { method: "POST", token: "secure-driver-token", body: base },
    );
    expect(apiClient.request).toHaveBeenNthCalledWith(
      2,
      "/driver/trips/trip-1/stops/stop-1/arrive",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiClient.request).toHaveBeenNthCalledWith(
      3,
      "/driver/trips/trip-1/stops/stop-1/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiClient.request).toHaveBeenNthCalledWith(
      4,
      "/driver/trips/trip-1/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiClient.request).toHaveBeenCalledTimes(4);
  });

  it("từ chối mutation response sai contract", async () => {
    jest.mocked(apiClient.request).mockResolvedValue({
      id: "trip-1",
      status: "IN_PROGRESS",
      version: "3",
    });
    await expect(
      driverTripsService.startTrip("trip-1", {
        idempotencyKey: "key",
        expectedTripVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
