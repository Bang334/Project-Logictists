import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { OfflineDriverIdentity } from '@/features/auth/services/offline-driver-identity';
import { withoutDriverStopPhones } from '../selectors/driver-stop-contact';
import { parseDriverTripDetail } from '../services/driver-trips.service';
import type { DriverTripDetail } from '../types/driver-trip.types';

const keyName = 'smart_tms_trip_snapshot_aes_v1';
const eightHours = 8 * 60 * 60 * 1000;
let database: Promise<SQLite.SQLiteDatabase> | undefined;
let creatingKey: Promise<Crypto.AESEncryptionKey> | undefined;

function open() {
  database ??= SQLite.openDatabaseAsync('smart-tms-trip-snapshots.db').then(async (db) => {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS trip_snapshots (
      owner_key TEXT NOT NULL,
      trip_key TEXT NOT NULL,
      checked_at INTEGER NOT NULL,
      trip_version INTEGER NOT NULL,
      sealed BLOB,
      PRIMARY KEY (owner_key, trip_key)
    )`);
    return db;
  }).catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}

async function key(create: boolean) {
  const existing = await SecureStore.getItemAsync(keyName);
  if (existing) return Crypto.AESEncryptionKey.import(existing, 'hex');
  if (!create) return null;
  creatingKey ??= (async () => {
    const generated = await Crypto.AESEncryptionKey.generate(256);
    await SecureStore.setItemAsync(keyName, await generated.encoded('hex'), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return generated;
  })().finally(() => { creatingKey = undefined; });
  return creatingKey;
}

function hash(value: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

function namespace(identity: OfflineDriverIdentity) {
  return hash(JSON.stringify([identity.scope, identity.ownerId, identity.tokenDigest]));
}

function allowed(trip: DriverTripDetail) {
  return trip.assignment.status === 'ASSIGNED' &&
    (trip.assignment.role === 'PRIMARY' || trip.assignment.role === 'RELIEF');
}

export const offlineTripSnapshots = {
  async save(identity: OfflineDriverIdentity, trip: DriverTripDetail, checkedAt: number) {
    const savedAt = Date.now();
    if (savedAt >= identity.expiresAt) return;
    if (!allowed(trip)) {
      await this.invalidate(identity, trip.id, checkedAt);
      return;
    }
    if (!trip.stops.length) return;
    const ownerKey = await namespace(identity);
    const tripKey = await hash(trip.id);
    const encryptionKey = await key(true);
    if (!encryptionKey) return;
    const bytes = new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1, ownerKey, tripKey, savedAt, verifiedAt: savedAt, trip: withoutDriverStopPhones(trip),
    }));
    const sealed = await Crypto.aesEncryptAsync(bytes, encryptionKey);
    await (await open()).runAsync(
      `INSERT INTO trip_snapshots VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner_key, trip_key) DO UPDATE SET checked_at = excluded.checked_at,
       trip_version = excluded.trip_version, sealed = excluded.sealed
       WHERE excluded.checked_at > trip_snapshots.checked_at
         AND excluded.trip_version >= trip_snapshots.trip_version`,
      ownerKey, tripKey, checkedAt, trip.version, await sealed.combined(),
    );
  },
  async invalidate(identity: OfflineDriverIdentity, tripId: string, checkedAt: number) {
    await (await open()).runAsync(
      `INSERT INTO trip_snapshots VALUES (?, ?, ?, 0, NULL)
       ON CONFLICT(owner_key, trip_key) DO UPDATE SET checked_at = excluded.checked_at, sealed = NULL
       WHERE excluded.checked_at >= trip_snapshots.checked_at`,
      await namespace(identity), await hash(tripId), checkedAt,
    );
  },
  async list(identity: OfflineDriverIdentity, now = Date.now()) {
    if (now < identity.verifiedAt || now >= identity.expiresAt) return [];
    const ownerKey = await namespace(identity);
    const encryptionKey = await key(false);
    if (!encryptionKey) return [];
    const rows = await (await open()).getAllAsync<{ trip_key: string; trip_version: number; sealed: Uint8Array }>(
      'SELECT trip_key, trip_version, sealed FROM trip_snapshots WHERE owner_key = ? AND sealed IS NOT NULL ORDER BY checked_at DESC',
      ownerKey,
    );
    const entries: { savedAt: number; trip: DriverTripDetail }[] = [];
    for (const row of rows) {
      try {
        const plaintext = await Crypto.aesDecryptAsync(Crypto.AESSealedData.fromCombined(row.sealed), encryptionKey);
        const record = JSON.parse(new TextDecoder().decode(plaintext));
        if (record.schemaVersion !== 1 || record.ownerKey !== ownerKey || record.tripKey !== row.trip_key ||
            !Number.isSafeInteger(record.verifiedAt) || record.verifiedAt !== record.savedAt ||
            record.savedAt > now || now - record.savedAt >= eightHours) continue;
        const trip = parseDriverTripDetail(record.trip);
        if (allowed(trip) && trip.stops.length && trip.version === row.trip_version &&
            await hash(trip.id) === row.trip_key) entries.push({ savedAt: record.savedAt, trip: withoutDriverStopPhones(trip) });
      } catch {
        // Authentication failures or incompatible records are not renderable.
      }
    }
    return entries;
  },
};
