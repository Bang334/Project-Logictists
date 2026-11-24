import * as SQLite from 'expo-sqlite';
import type {
  DriverGpsPoint,
  DriverTrackingSession,
} from '@/features/driver-tracking/types/driver-tracking.types';

const DATABASE_NAME = 'smart-tms-driver-gps.db';
const MAX_QUEUE_POINTS = 6_000;
const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1_000;

type SessionRow = {
  user_id: string;
  trip_id: string;
  device_session_id: string;
  next_sequence: number;
  state: DriverTrackingSession['state'];
  background_allowed: number;
  created_at: string;
  completed_at: string | null;
  last_sync_at: string | null;
  last_attempt_at: string | null;
  retry_after: string | null;
  failure_count: number;
  error_code: string | null;
  warning: string | null;
};

type PointRow = {
  user_id: string;
  trip_id: string;
  device_session_id: string;
  sequence: number;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  speed_mps: number | null;
  heading_deg: number | null;
  measured_at: string;
  created_at: string;
};

export type GpsCapture = {
  taskName: string;
  capturedAfter: number;
  tokenTag: string;
  session: DriverTrackingSession;
};

type BindingRow = { task_name: string | null; captured_after: number; token_tag: string };

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

const SQLITE_BUSY_RETRY_DELAYS_MS = [100, 250, 500];

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /database is locked|database is busy|SQLITE_BUSY|Error code 5/i.test(error.message);
}

async function withSqliteBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) {
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
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS driver_tracking_sessions (
          device_session_id TEXT PRIMARY KEY NOT NULL,
          user_id TEXT NOT NULL,
          trip_id TEXT NOT NULL,
          next_sequence INTEGER NOT NULL,
          state TEXT NOT NULL,
          background_allowed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          last_sync_at TEXT,
          last_attempt_at TEXT,
          retry_after TEXT,
          failure_count INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          warning TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS driver_tracking_active_trip
          ON driver_tracking_sessions(user_id, trip_id)
          WHERE state IN ('ACTIVE', 'COMPLETED');
        CREATE TABLE IF NOT EXISTS driver_gps_queue (
          user_id TEXT NOT NULL,
          trip_id TEXT NOT NULL,
          device_session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          accuracy_m REAL,
          speed_mps REAL,
          heading_deg REAL,
          measured_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(device_session_id, sequence),
          FOREIGN KEY(device_session_id)
            REFERENCES driver_tracking_sessions(device_session_id)
            ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS driver_gps_queue_owner
          ON driver_gps_queue(user_id, trip_id, device_session_id, sequence);
        CREATE TABLE IF NOT EXISTS driver_gps_bindings (
          device_session_id TEXT PRIMARY KEY NOT NULL
            REFERENCES driver_tracking_sessions(device_session_id) ON DELETE CASCADE,
          token_tag TEXT NOT NULL,
          task_name TEXT UNIQUE,
          captured_after INTEGER NOT NULL
        );
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

function mapSession(row: SessionRow): DriverTrackingSession {
  return {
    userId: row.user_id,
    tripId: row.trip_id,
    deviceSessionId: row.device_session_id,
    nextSequence: row.next_sequence,
    state: row.state,
    backgroundAllowed: row.background_allowed === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    lastSyncAt: row.last_sync_at,
    lastAttemptAt: row.last_attempt_at,
    retryAfter: row.retry_after,
    failureCount: row.failure_count,
    errorCode: row.error_code,
    warning: row.warning,
  };
}

function mapPoint(row: PointRow): DriverGpsPoint {
  return {
    userId: row.user_id,
    tripId: row.trip_id,
    deviceSessionId: row.device_session_id,
    sequence: row.sequence,
    latitude: row.latitude,
    longitude: row.longitude,
    ...(row.accuracy_m === null ? {} : { accuracyM: row.accuracy_m }),
    ...(row.speed_mps === null ? {} : { speedMps: row.speed_mps }),
    ...(row.heading_deg === null ? {} : { headingDeg: row.heading_deg }),
    measuredAt: row.measured_at,
    createdAt: row.created_at,
  };
}

export const driverGpsStorage = {
  readTaskNamesAtStartup(): string[] {
    try {
      const db = SQLite.openDatabaseSync(DATABASE_NAME, { useNewConnection: true });
      try {
        return db.getAllSync<{ task_name: string }>(
          'SELECT task_name FROM driver_gps_bindings WHERE task_name IS NOT NULL',
        ).map(({ task_name }) => task_name);
      } finally {
        db.closeSync();
      }
    } catch {
      return [];
    }
  },

  async getBinding(sessionId: string) {
    const db = await database();
    return withSqliteBusyRetry(() => db.getFirstAsync<BindingRow>(
      'SELECT token_tag, task_name, captured_after FROM driver_gps_bindings WHERE device_session_id = ?',
      sessionId,
    ));
  },

  async getCapture(taskName: string): Promise<GpsCapture | null> {
    const db = await database();
    const row = await withSqliteBusyRetry(() => db.getFirstAsync<SessionRow & BindingRow>(
      `SELECT s.*, b.task_name, b.captured_after, b.token_tag
         FROM driver_tracking_sessions s JOIN driver_gps_bindings b USING(device_session_id)
         WHERE b.task_name = ? AND s.state = 'ACTIVE'`,
      taskName,
    ));
    return row ? {
      taskName, capturedAfter: row.captured_after, tokenTag: row.token_tag, session: mapSession(row),
    } : null;
  },

  async enableCapture(sessionId: string, taskName: string, capturedAfter: number) {
    const db = await database();
    await serializeWrite(() => db.runAsync(
      'UPDATE driver_gps_bindings SET task_name = ?, captured_after = ? WHERE device_session_id = ?',
      taskName, capturedAfter, sessionId,
    ));
  },

  async disableCapture(taskName?: string) {
    const db = await database();
    await serializeWrite(() => taskName
      ? db.runAsync('UPDATE driver_gps_bindings SET task_name=NULL WHERE task_name=?', taskName)
      : db.runAsync('UPDATE driver_gps_bindings SET task_name=NULL WHERE task_name IS NOT NULL'));
  },

  async revokeBindings() {
    const db = await database();
    await serializeWrite(() => db.runAsync('DELETE FROM driver_gps_bindings'));
  },

  async createOrRestoreSession(
    userId: string,
    tripId: string,
    newSessionId: string,
    tokenTag: string,
  ): Promise<DriverTrackingSession> {
    const db = await database();
    return serializeWrite(async () => {
      let result: DriverTrackingSession | null = null;
      await db.withExclusiveTransactionAsync(async (tx) => {
        const existing = await tx.getFirstAsync<SessionRow>(
          `SELECT s.* FROM driver_tracking_sessions s JOIN driver_gps_bindings b USING(device_session_id)
         WHERE user_id = ? AND trip_id = ? AND state IN ('ACTIVE', 'COMPLETED') AND b.token_tag = ?`,
          userId,
          tripId,
          tokenTag,
        );
        if (existing) {
          result = mapSession(existing);
          return;
        }

        await tx.runAsync(
          `UPDATE driver_tracking_sessions SET state='BLOCKED'
             WHERE user_id=? AND trip_id=? AND state IN ('ACTIVE','COMPLETED')`,
          userId, tripId,
        );
        const createdAt = new Date().toISOString();
        await tx.runAsync(
          `INSERT INTO driver_tracking_sessions
          (device_session_id, user_id, trip_id, next_sequence, state,
           background_allowed, created_at, failure_count)
         VALUES (?, ?, ?, 1, 'ACTIVE', 0, ?, 0)`,
          newSessionId,
          userId,
          tripId,
          createdAt,
        );
        await tx.runAsync(
          'INSERT INTO driver_gps_bindings (device_session_id, token_tag, captured_after) VALUES (?, ?, 0)',
          newSessionId, tokenTag,
        );
        const created = await tx.getFirstAsync<SessionRow>(
          'SELECT * FROM driver_tracking_sessions WHERE device_session_id = ?',
          newSessionId,
        );
        if (!created) throw new Error('Không thể tạo GPS tracking session.');
        result = mapSession(created);
      });
      if (!result) throw new Error('Không thể tạo GPS tracking session.');
      return result;
    });
  },

  async getRestorableSession(userId: string, tripId?: string): Promise<DriverTrackingSession | null> {
    const db = await database();
    const row = await withSqliteBusyRetry(() =>
      db.getFirstAsync<SessionRow>(
        `SELECT * FROM driver_tracking_sessions
       WHERE user_id = ? AND (? IS NULL OR trip_id = ?) AND state IN ('ACTIVE', 'COMPLETED')
         AND device_session_id IN (SELECT device_session_id FROM driver_gps_bindings)
       ORDER BY (SELECT task_name IS NOT NULL FROM driver_gps_bindings b
                 WHERE b.device_session_id = driver_tracking_sessions.device_session_id) DESC,
                created_at DESC LIMIT 1`,
        userId, tripId ?? null, tripId ?? null,
      ),
    );
    return row ? mapSession(row) : null;
  },

  async getRestorableSessions(userId: string): Promise<DriverTrackingSession[]> {
    const db = await database();
    const rows = await withSqliteBusyRetry(() =>
      db.getAllAsync<SessionRow>(
        `SELECT * FROM driver_tracking_sessions
       WHERE user_id = ? AND state IN ('ACTIVE', 'COMPLETED')
         AND device_session_id IN (SELECT device_session_id FROM driver_gps_bindings)
       ORDER BY CASE state WHEN 'COMPLETED' THEN 0 ELSE 1 END, created_at ASC`,
        userId,
      ),
    );
    return rows.map(mapSession);
  },

  async getCurrentSession(): Promise<DriverTrackingSession | null> {
    const db = await database();
    const row = await withSqliteBusyRetry(() =>
      db.getFirstAsync<SessionRow>(
        `SELECT * FROM driver_tracking_sessions
       WHERE state IN ('ACTIVE', 'COMPLETED', 'BLOCKED')
         AND device_session_id IN (SELECT device_session_id FROM driver_gps_bindings)
       ORDER BY (SELECT task_name IS NOT NULL FROM driver_gps_bindings b
                 WHERE b.device_session_id = driver_tracking_sessions.device_session_id) DESC,
                created_at DESC LIMIT 1`,
      ),
    );
    return row ? mapSession(row) : null;
  },

  async appendLocations(
    session: DriverTrackingSession,
    locations: {
      latitude: number;
      longitude: number;
      accuracyM?: number;
      speedMps?: number;
      headingDeg?: number;
      measuredAt: string;
    }[],
    taskName: string,
  ): Promise<number[]> {
    if (locations.length === 0) return [];
    const db = await database();
    return serializeWrite(async () => {
      let result: number[] = [];
      await db.withExclusiveTransactionAsync(async (tx) => {
        const current = await tx.getFirstAsync<SessionRow>(
          `SELECT s.* FROM driver_tracking_sessions s JOIN driver_gps_bindings b USING(device_session_id)
         WHERE s.device_session_id = ? AND s.user_id = ? AND s.trip_id = ? AND s.state = 'ACTIVE' AND b.task_name = ?`,
          session.deviceSessionId,
          session.userId,
          session.tripId,
          taskName,
        );
        if (!current) return;

        const sequences: number[] = [];
        let nextSequence = current.next_sequence;
        const createdAt = new Date().toISOString();
        for (const location of locations) {
          const sequence = nextSequence++;
          sequences.push(sequence);
          await tx.runAsync(
            `INSERT INTO driver_gps_queue
            (user_id, trip_id, device_session_id, sequence, latitude, longitude,
             accuracy_m, speed_mps, heading_deg, measured_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            current.user_id,
            current.trip_id,
            current.device_session_id,
            sequence,
            location.latitude,
            location.longitude,
            location.accuracyM ?? null,
            location.speedMps ?? null,
            location.headingDeg ?? null,
            location.measuredAt,
            createdAt,
          );
        }
        await tx.runAsync(
          'UPDATE driver_tracking_sessions SET next_sequence = ? WHERE device_session_id = ?',
          nextSequence,
          current.device_session_id,
        );

        const cutoff = new Date(Date.now() - MAX_QUEUE_AGE_MS).toISOString();
        await tx.runAsync(
          'DELETE FROM driver_gps_queue WHERE user_id = ? AND created_at < ?',
          current.user_id,
          cutoff,
        );
        const count = await tx.getFirstAsync<{ count: number }>(
          'SELECT COUNT(*) AS count FROM driver_gps_queue WHERE user_id = ?',
          current.user_id,
        );
        const overflow = Math.max(0, (count?.count ?? 0) - MAX_QUEUE_POINTS);
        if (overflow > 0) {
          await tx.runAsync(
            `DELETE FROM driver_gps_queue WHERE rowid IN (
             SELECT rowid FROM driver_gps_queue
             WHERE user_id = ? ORDER BY created_at ASC, sequence ASC LIMIT ?
           )`,
            current.user_id,
            overflow,
          );
          await tx.runAsync(
            `UPDATE driver_tracking_sessions
           SET warning = 'GPS_QUEUE_LIMIT_REACHED'
           WHERE device_session_id = ?`,
            current.device_session_id,
          );
        }
        result = sequences;
      });
      return result;
    });
  },

  async getBatch(session: DriverTrackingSession, limit = 20): Promise<DriverGpsPoint[]> {
    const db = await database();
    const rows = await withSqliteBusyRetry(() =>
      db.getAllAsync<PointRow>(
        `SELECT * FROM driver_gps_queue
       WHERE user_id = ? AND trip_id = ? AND device_session_id = ?
       ORDER BY sequence ASC LIMIT ?`,
        session.userId,
        session.tripId,
        session.deviceSessionId,
        Math.min(20, Math.max(1, limit)),
      ),
    );
    return rows.map(mapPoint);
  },

  async pendingCount(session: DriverTrackingSession): Promise<number> {
    const db = await database();
    const row = await withSqliteBusyRetry(() =>
      db.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM driver_gps_queue
       WHERE user_id = ? AND trip_id = ? AND device_session_id = ?`,
        session.userId,
        session.tripId,
        session.deviceSessionId,
      ),
    );
    return row?.count ?? 0;
  },

  async removeSequences(session: DriverTrackingSession, sequences: number[]): Promise<void> {
    if (sequences.length === 0) return;
    const db = await database();
    const placeholders = sequences.map(() => '?').join(',');
    await serializeWrite(() =>
      db.runAsync(
        `DELETE FROM driver_gps_queue
       WHERE user_id = ? AND trip_id = ? AND device_session_id = ?
         AND sequence IN (${placeholders})`,
        session.userId,
        session.tripId,
        session.deviceSessionId,
        ...sequences,
      ),
    );
  },

  async updateSession(
    deviceSessionId: string,
    changes: Partial<{
      state: DriverTrackingSession['state'];
      backgroundAllowed: boolean;
      completedAt: string | null;
      lastSyncAt: string | null;
      lastAttemptAt: string | null;
      retryAfter: string | null;
      failureCount: number;
      errorCode: string | null;
      warning: string | null;
    }>,
  ): Promise<void> {
    const entries = Object.entries(changes);
    if (entries.length === 0) return;
    const columns: Record<string, string> = {
      state: 'state',
      backgroundAllowed: 'background_allowed',
      completedAt: 'completed_at',
      lastSyncAt: 'last_sync_at',
      lastAttemptAt: 'last_attempt_at',
      retryAfter: 'retry_after',
      failureCount: 'failure_count',
      errorCode: 'error_code',
      warning: 'warning',
    };
    const values = entries.map(([key, value]) =>
      key === 'backgroundAllowed' ? (value ? 1 : 0) : value,
    );
    const db = await database();
    await serializeWrite(() =>
      db.runAsync(
        `UPDATE driver_tracking_sessions SET ${entries
        .map(([key]) => `${columns[key]} = ?`)
        .join(', ')} WHERE device_session_id = ?`,
        ...values,
        deviceSessionId,
      ),
    );
  },

  async deleteSession(deviceSessionId: string): Promise<void> {
    const db = await database();
    await serializeWrite(() =>
      db.runAsync(
        'DELETE FROM driver_tracking_sessions WHERE device_session_id = ?',
        deviceSessionId,
      ),
    );
  },

};
