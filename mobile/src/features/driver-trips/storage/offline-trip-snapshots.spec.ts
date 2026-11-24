/// <reference types="node" />
import * as Crypto from 'expo-crypto';
import { offlineTripSnapshots } from './offline-trip-snapshots';
import type { DriverTripDetail } from '../types/driver-trip.types';

const mockRun = jest.fn();
const mockRead = jest.fn();
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({ execAsync: jest.fn(), runAsync: mockRun, getAllAsync: mockRead }),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => 'ab'.repeat(32),
}));
jest.mock('expo-crypto', () => {
  const { createCipheriv, createDecipheriv, createHash, randomBytes } =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digestStringAsync: async (_: string, value: string) => createHash('sha256').update(value).digest('hex'),
  AESEncryptionKey: { import: async (raw: string) => Buffer.from(raw, 'hex') },
  AESSealedData: { fromCombined: (raw: Buffer) => raw },
  aesEncryptAsync: async (bytes: Uint8Array, key: Buffer) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return { combined: async () => Buffer.concat([iv, cipher.getAuthTag(), body]) };
  },
  aesDecryptAsync: async (bytes: Buffer, key: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  },
  };
});

const now = Date.UTC(2026, 10, 21);
const profile = { version: 1 as const, ownerId: 'owner', scope: 'server', tokenDigest: 'verified',
  verifiedAt: now - 1000, expiresAt: now + 60_000 };
const time = new Date(now).toISOString();
const trip: DriverTripDetail = {
  id: 'trip-1', tripNumber: 'QA-SECRET-TRIP', status: 'IN_PROGRESS', version: 2, stopCount: 1,
  plannedStartTime: time, plannedEndTime: time, actualStartTime: time, actualEndTime: null,
  totalDistanceKm: 1, totalDurationMinutes: 1,
  assignment: { id: 'a', role: 'RELIEF', status: 'ASSIGNED', startTime: time, endTime: time },
  vehicle: { id: 'v', plateNumber: 'QA-01', model: 'QA', vehicleType: 'TRUCK' },
  stops: [{ id: 's', sequence: 1, stopType: 'DEPOT_START', status: 'PENDING', address: 'Địa chỉ QA',
    latitude: 10, longitude: 106, contactName: null, contactPhone: null, plannedArrivalTime: null,
    plannedDepartureTime: null, actualArrivalTime: null, actualDepartureTime: null, tasks: [] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  mockRead.mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

it('snapshot RELIEF được mã hóa, giải mã và kiểm tra owner/Trip', async () => {
  await offlineTripSnapshots.save(profile, trip, now);
  const [, owner, tripKey, , version, ciphertext] = mockRun.mock.lastCall;
  expect(ciphertext.includes(Buffer.from(trip.tripNumber))).toBe(false);
  expect(tripKey).not.toBe(trip.id);
  const row = { trip_key: tripKey, trip_version: version, sealed: ciphertext };
  mockRead.mockResolvedValue([row]);
  expect(await offlineTripSnapshots.list(profile)).toMatchObject([{ savedAt: now, trip }]);
  expect(mockRead.mock.lastCall?.[1]).toBe(owner);
  expect(await offlineTripSnapshots.list({ ...profile, ownerId: 'other' })).toEqual([]);
  expect(await offlineTripSnapshots.list({ ...profile, tokenDigest: 'new-token' })).toEqual([]);
});

it('cache rỗng, hỏng hoặc hết hạn không trả dữ liệu', async () => {
  expect(await offlineTripSnapshots.list(profile)).toEqual([]);
  await offlineTripSnapshots.save(profile, trip, now);
  const [, , tripKey, , version, ciphertext] = mockRun.mock.lastCall;
  const tampered = Buffer.from(ciphertext);
  tampered[15] = (tampered[15] ?? 0) ^ 1;
  mockRead.mockResolvedValue([{ trip_key: tripKey, trip_version: version, sealed: tampered }]);
  expect(await offlineTripSnapshots.list(profile)).toEqual([]);
  expect(await offlineTripSnapshots.list(profile, profile.expiresAt)).toEqual([]);
});

it('loại số khỏi snapshot mới và giữ tương thích với snapshot Phase 4C cũ', async () => {
  const original = { ...trip, stops: trip.stops.map((stop) => ({
    ...stop, contactName: 'Contact QA', contactPhone: '0900000001',
  })) };
  await offlineTripSnapshots.save(profile, original, now);
  const [, , tripKey, , version, ciphertext] = mockRun.mock.lastCall;
  const key = await Crypto.AESEncryptionKey.import('ab'.repeat(32), 'hex');
  const decrypted = await Crypto.aesDecryptAsync(Crypto.AESSealedData.fromCombined(ciphertext), key);
  const snapshot = JSON.parse(new TextDecoder().decode(decrypted));
  expect(snapshot.trip.stops[0].contactPhone).toBeNull();
  expect(original.stops[0]?.contactPhone).toBe('0900000001');

  const legacy = await Crypto.aesEncryptAsync(new TextEncoder().encode(JSON.stringify({ ...snapshot, trip: original })), key);
  mockRead.mockResolvedValue([{ trip_key: tripKey, trip_version: version, sealed: await legacy.combined() }]);
  const [entry] = await offlineTripSnapshots.list(profile);
  expect(entry?.trip.stops[0]).toMatchObject({ address: 'Địa chỉ QA', contactName: 'Contact QA', contactPhone: null });
});

it('response thiếu điểm không ghi đè snapshot, quyền bị hủy tạo dấu vô hiệu', async () => {
  await offlineTripSnapshots.save(profile, { ...trip, stops: [] }, now);
  expect(mockRun).not.toHaveBeenCalled();
  await offlineTripSnapshots.save(profile, { ...trip, assignment: { ...trip.assignment, status: 'CANCELLED' } }, now);
  expect(mockRun.mock.lastCall?.[0]).toContain('sealed = NULL');
});
