const mockExecAsync = jest.fn(async (_sql: string) => undefined);
const mockRunAsync = jest.fn(async (..._args: unknown[]) => ({ changes: 1 }));
const mockGetAllAsync = jest.fn(async (..._args: unknown[]) => []);
const mockTransactionRunAsync = jest.fn(async (..._args: unknown[]) => ({
  changes: 1,
}));
const mockTransactionGetFirstAsync = jest.fn();
const mockWithExclusiveTransactionAsync = jest.fn(
  async (callback: (transaction: unknown) => Promise<void>) => {
    await callback({
      runAsync: mockTransactionRunAsync,
      getFirstAsync: mockTransactionGetFirstAsync,
    });
  },
);

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: mockExecAsync,
    runAsync: mockRunAsync,
    getAllAsync: mockGetAllAsync,
    withExclusiveTransactionAsync: mockWithExclusiveTransactionAsync,
  })),
}));

// Mock SQLite must be declared before loading the repository module.
// eslint-disable-next-line import/first
import { offlineDriverCommandStorage } from "./offline-driver-command.storage";

const row = {
  id: "command-1",
  owner_user_id: "owner-1",
  trip_id: "trip-1",
  stop_id: "stop-1",
  command_type: "ARRIVE_STOP",
  sequence: 3,
  idempotency_key: "key-1",
  payload_json: JSON.stringify({ kind: "ARRIVE_STOP" }),
  payload_fingerprint: "fingerprint-1",
  observed_trip_version: 2,
  wire_expected_version: null,
  transmission_state: "NEVER_SENT",
  state: "PENDING",
  occurred_at: "2026-11-18T11:00:00.000Z",
  retry_count: 0,
  next_retry_at: null,
  last_error_code: null,
  last_error_message: null,
  server_result_json: null,
  created_at: "2026-11-18T11:00:00.000Z",
  updated_at: "2026-11-18T11:00:00.000Z",
  synced_at: null,
};

describe("offlineDriverCommandStorage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionGetFirstAsync
      .mockResolvedValueOnce({ sequence: 2 })
      .mockResolvedValueOnce(row);
  });

  it("khởi tạo database riêng với WAL, busy timeout và unique constraints", async () => {
    await offlineDriverCommandStorage.listForOwner("owner-1");
    const initSql = String(mockExecAsync.mock.calls[0]?.[0]);
    expect(initSql).toContain("PRAGMA busy_timeout = 5000");
    expect(initSql).toContain("PRAGMA journal_mode = WAL");
    expect(initSql).toContain("UNIQUE(owner_user_id, trip_id, sequence)");
    expect(initSql).toContain(
      "UNIQUE(owner_user_id, command_type, idempotency_key)",
    );
  });

  it("insert dùng sequence tiếp theo theo owner/trip và giữ nguyên occurredAt", async () => {
    const inserted = await offlineDriverCommandStorage.enqueue({
      id: "command-1",
      ownerUserId: "owner-1",
      tripId: "trip-1",
      stopId: "stop-1",
      commandType: "ARRIVE_STOP",
      idempotencyKey: "key-1",
      payload: { kind: "ARRIVE_STOP" },
      payloadFingerprint: "fingerprint-1",
      observedTripVersion: 2,
      occurredAt: "2026-11-18T11:00:00.000Z",
    });

    expect(mockTransactionRunAsync).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO offline_driver_commands"),
      "command-1",
      "owner-1",
      "trip-1",
      "stop-1",
      "ARRIVE_STOP",
      3,
      "key-1",
      JSON.stringify({ kind: "ARRIVE_STOP" }),
      "fingerprint-1",
      2,
      "2026-11-18T11:00:00.000Z",
      expect.any(String),
      expect.any(String),
    );
    expect(inserted).toMatchObject({ sequence: 3, ownerUserId: "owner-1" });
  });

  it("mọi đọc/ghi/cleanup đều mang owner scope", async () => {
    await offlineDriverCommandStorage.listForOwner("owner-1");
    await offlineDriverCommandStorage.update("owner-1", "command-1", {
      state: "RETRY_WAIT",
      transmissionState: "SENT_UNCERTAIN",
      wireExpectedVersion: 2,
      retryCount: 1,
      nextRetryAt: "2026-11-18T12:01:00.000Z",
    });
    await offlineDriverCommandStorage.deleteSyncedForTrip("owner-1", "trip-1");

    expect(mockGetAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("WHERE owner_user_id = ?"),
      "owner-1",
    );
    expect(mockRunAsync).toHaveBeenCalledWith(
      expect.stringContaining("WHERE owner_user_id = ? AND id = ?"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(String),
      "owner-1",
      "command-1",
    );
    expect(mockRunAsync).toHaveBeenLastCalledWith(
      expect.stringContaining("state = 'SYNCED'"),
      "owner-1",
      "trip-1",
    );
  });
});
