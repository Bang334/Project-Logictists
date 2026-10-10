import { Api } from "../api";
import { DriverStore, TokenStorage } from "../store";
export const date = "2030-01-15T02:00:00.000Z";
export const profile = {
  id: "driver-a",
  fullName: "Tài xế A",
  phone: "000",
  homeBranchId: "branch-a",
  homeBranch: { id: "branch-a", code: "A", name: "Chi nhánh A" },
};
export const assignment = {
  id: "a",
  status: "ASSIGNED",
  version: 1,
  offeredAt: date,
  respondedAt: null,
  rejectionReason: null,
  startTime: date,
  endTime: date,
  role: "PRIMARY",
  trip: {
    id: "trip-a",
    tripNumber: "TRIP-A",
    status: "DISPATCHED",
    version: 2,
    plannedStartTime: date,
    plannedEndTime: date,
    vehicle: { id: "vehicle", plateNumber: "DEMO-A", model: "Demo" },
    start: { id: "s1", sequence: 1, address: "Điểm lấy" },
    end: { id: "s2", sequence: 2, address: "Điểm giao" },
  },
};
export const list = { data: [assignment], total: 1, page: 1, limit: 20 };
export const detail = {
  ...assignment,
  trip: {
    ...assignment.trip,
    stops: [
      {
        id: "s1",
        sequence: 1,
        stopType: "PICKUP",
        address: "Điểm lấy",
        latitude: 21,
        longitude: 105,
        contactName: "Demo",
        contactPhone: "000",
        plannedArrivalTime: date,
        plannedDepartureTime: null,
        tasks: [
          {
            id: "task",
            action: "LOAD",
            plannedQuantity: 1,
            allocationId: "allocation",
            description: "Kiện thử",
            order: { id: "order", orderNumber: "ORDER-A" },
            package: {
              id: "parcel",
              packageCode: "PK-A",
              lengthMm: 200,
              widthMm: 200,
              heightMm: 200,
              weightG: "10000",
            },
            windowStart: date,
            windowEnd: date,
            windowBasis: "SERVICE_START",
          },
        ],
      },
    ],
  },
};
export const reply = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;
export function harness(saved: string | null = null) {
  let stored = saved;
  const storage: TokenStorage = {
    read: jest.fn(async () => stored),
    write: jest.fn(async (token) => {
      stored = token;
    }),
    clear: jest.fn(async () => {
      stored = null;
    }),
  };
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url) => {
      const path = String(url);
      if (path.endsWith("/auth/login"))
        return reply({ accessToken: "token-a", expiresAt: date });
      if (path.endsWith("/driver/me")) return reply(profile);
      if (path.includes("/assignments?")) return reply(list);
      if (path.endsWith("/assignments/a")) return reply(detail);
      if (path.endsWith("/auth/logout")) return reply({ loggedOut: true });
      throw new Error("Unexpected request");
    },
  );
  const store = new DriverStore(
    new Api("http://test", fetcher),
    storage,
    () => "unique-intent-key",
  );
  return { store, storage, fetcher, saved: () => stored };
}
