import * as SQLite from "expo-sqlite";
import { parseOfflinePayload } from "@/features/driver-offline/services/offline-command-serialization";
import type {
  EnqueueOfflineDriverCommandInput,
  OfflineDriverCommand,
  OfflineDriverCommandRepository,
  OfflineDriverCommandState,
  OfflineDriverTransmissionState,
} from "@/features/driver-offline/types/offline-driver-command.types";
import type { DriverStopCommandResponse } from "@/features/driver-trips/types/driver-trip.types";

const DATABASE_NAME = "smart-tms-driver-offline.db";
const SQLITE_BUSY_RETRY_DELAYS_MS = [100, 250, 500];

type CommandRow = {
  id: string;
  owner_user_id: string;
  trip_id: string;
  stop_id: string;
  command_type: OfflineDriverCommand["commandType"];
  sequence: number;
  idempotency_key: string;
  payload_json: string;
  payload_fingerprint: string;
  observed_trip_version: number;
  wire_expected_version: number | null;
  transmission_state: OfflineDriverTransmissionState;
  state: OfflineDriverCommandState;
  occurred_at: string;
  retry_count: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  server_result_json: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function isSqliteBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /database is locked|database is busy|SQLITE_BUSY|Error code 5/i.test(
      error.message,
    )
  );
}

async function withSqliteBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !isSqliteBusyError(error) ||
        attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, SQLITE_BUSY_RETRY_DELAYS_MS[attempt]),
      );
    }
  }
}

function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(
    () => withSqliteBusyRetry(operation),
    () => withSqliteBusyRetry(operation),
  );
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(DATABASE_NAME)
      .then(async (db) => {
        await withSqliteBusyRetry(() =>
          db.execAsync(`
            PRAGMA busy_timeout = 5000;
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS offline_driver_commands (
              id TEXT PRIMARY KEY NOT NULL,
              owner_user_id TEXT NOT NULL,
              trip_id TEXT NOT NULL,
              stop_id TEXT NOT NULL,
              command_type TEXT NOT NULL CHECK(command_type IN ('ARRIVE_STOP', 'COMPLETE_STOP')),
              sequence INTEGER NOT NULL,
              idempotency_key TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              payload_fingerprint TEXT NOT NULL,
              observed_trip_version INTEGER NOT NULL,
              wire_expected_version INTEGER,
              transmission_state TEXT NOT NULL CHECK(transmission_state IN ('NEVER_SENT', 'SENT_UNCERTAIN')),
              state TEXT NOT NULL CHECK(state IN ('PENDING', 'SYNCING', 'RETRY_WAIT', 'AUTH_PAUSED', 'CONFLICT', 'FAILED', 'BLOCKED', 'SYNCED')),
              occurred_at TEXT NOT NULL,
              retry_count INTEGER NOT NULL DEFAULT 0,
              next_retry_at TEXT,
              last_error_code TEXT,
              last_error_message TEXT,
              server_result_json TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              synced_at TEXT,
              UNIQUE(owner_user_id, trip_id, sequence),
              UNIQUE(owner_user_id, command_type, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS offline_driver_commands_owner_fifo
              ON offline_driver_commands(owner_user_id, trip_id, sequence);
            CREATE INDEX IF NOT EXISTS offline_driver_commands_owner_state
              ON offline_driver_commands(owner_user_id, state, next_retry_at);
          `),
        );
        return db;
      })
      .catch((error) => {
        databasePromise = null;
        throw error;
      });
  }
  return databasePromise;
}

function parseServerResult(
  value: string | null,
): DriverStopCommandResponse | null {
  if (!value) return null;
  const parsed: unknown = JSON.parse(value);
  return parsed as DriverStopCommandResponse;
}

function mapRow(row: CommandRow): OfflineDriverCommand {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    tripId: row.trip_id,
    stopId: row.stop_id,
    commandType: row.command_type,
    sequence: row.sequence,
    idempotencyKey: row.idempotency_key,
    payload: parseOfflinePayload(row.payload_json),
    payloadFingerprint: row.payload_fingerprint,
    observedTripVersion: row.observed_trip_version,
    wireExpectedVersion: row.wire_expected_version,
    transmissionState: row.transmission_state,
    state: row.state,
    occurredAt: row.occurred_at,
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    serverResult: parseServerResult(row.server_result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

export const offlineDriverCommandStorage: OfflineDriverCommandRepository = {
  async enqueue(input: EnqueueOfflineDriverCommandInput) {
    const db = await database();
    return serializeWrite(async () => {
      let inserted: CommandRow | null = null;
      await db.withExclusiveTransactionAsync(async (tx) => {
        const latest = await tx.getFirstAsync<{ sequence: number | null }>(
          `SELECT MAX(sequence) AS sequence FROM offline_driver_commands
           WHERE owner_user_id = ? AND trip_id = ?`,
          input.ownerUserId,
          input.tripId,
        );
        const sequence = (latest?.sequence ?? 0) + 1;
        const now = new Date().toISOString();
        await tx.runAsync(
          `INSERT INTO offline_driver_commands
           (id, owner_user_id, trip_id, stop_id, command_type, sequence,
            idempotency_key, payload_json, payload_fingerprint,
            observed_trip_version, wire_expected_version, transmission_state,
            state, occurred_at, retry_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'NEVER_SENT',
                   'PENDING', ?, 0, ?, ?)`,
          input.id,
          input.ownerUserId,
          input.tripId,
          input.stopId,
          input.commandType,
          sequence,
          input.idempotencyKey,
          JSON.stringify(input.payload),
          input.payloadFingerprint,
          input.observedTripVersion,
          input.occurredAt,
          now,
          now,
        );
        inserted = await tx.getFirstAsync<CommandRow>(
          `SELECT * FROM offline_driver_commands
           WHERE owner_user_id = ? AND id = ?`,
          input.ownerUserId,
          input.id,
        );
      });
      if (!inserted) throw new Error("OFFLINE_COMMAND_INSERT_FAILED");
      return mapRow(inserted);
    });
  },

  async listForOwner(ownerUserId: string) {
    const db = await database();
    const rows = await withSqliteBusyRetry(() =>
      db.getAllAsync<CommandRow>(
        `SELECT * FROM offline_driver_commands
         WHERE owner_user_id = ?
         ORDER BY created_at ASC, trip_id ASC, sequence ASC`,
        ownerUserId,
      ),
    );
    return rows.map(mapRow);
  },

  async update(ownerUserId, commandId, changes) {
    const entries = Object.entries(changes);
    if (entries.length === 0) return;
    const columns: Record<string, string> = {
      state: "state",
      transmissionState: "transmission_state",
      wireExpectedVersion: "wire_expected_version",
      retryCount: "retry_count",
      nextRetryAt: "next_retry_at",
      lastErrorCode: "last_error_code",
      lastErrorMessage: "last_error_message",
      serverResult: "server_result_json",
      syncedAt: "synced_at",
    };
    const values = entries.map(([key, value]) => {
      if (key === "serverResult") {
        return value === null ? null : JSON.stringify(value);
      }
      return value as string | number | null;
    });
    const db = await database();
    await serializeWrite(() =>
      db.runAsync(
        `UPDATE offline_driver_commands SET ${entries
          .map(([key]) => `${columns[key]} = ?`)
          .join(", ")}, updated_at = ?
         WHERE owner_user_id = ? AND id = ?`,
        ...values,
        new Date().toISOString(),
        ownerUserId,
        commandId,
      ),
    );
  },

  async blockDescendants(ownerUserId, tripId, sequence) {
    const db = await database();
    await serializeWrite(() =>
      db.runAsync(
        `UPDATE offline_driver_commands
         SET state = 'BLOCKED', updated_at = ?
         WHERE owner_user_id = ? AND trip_id = ? AND sequence > ?
           AND state NOT IN ('SYNCED', 'CONFLICT', 'FAILED')`,
        new Date().toISOString(),
        ownerUserId,
        tripId,
        sequence,
      ),
    );
  },

  async deleteSyncedForTrip(ownerUserId, tripId) {
    const db = await database();
    await serializeWrite(() =>
      db.runAsync(
        `DELETE FROM offline_driver_commands
         WHERE owner_user_id = ? AND trip_id = ? AND state = 'SYNCED'`,
        ownerUserId,
        tripId,
      ),
    );
  },

  async recoverInterrupted(ownerUserId) {
    const db = await database();
    await serializeWrite(() =>
      db.runAsync(
        `UPDATE offline_driver_commands
         SET state = 'PENDING', updated_at = ?
         WHERE owner_user_id = ? AND state = 'SYNCING'`,
        new Date().toISOString(),
        ownerUserId,
      ),
    );
  },
};
