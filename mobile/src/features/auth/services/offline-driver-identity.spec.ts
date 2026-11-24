/// <reference types="node" />
import { createHash } from 'node:crypto';
import * as SecureStore from 'expo-secure-store';
import type { AuthProfile } from '../types/auth.types';
import { offlineDriverIdentity } from './offline-driver-identity';
import { getApiBaseUrl } from '@/shared/config/environment';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digestStringAsync: jest.fn(),
}));
jest.mock('@/shared/config/environment', () => ({ getApiBaseUrl: jest.fn() }));

const profile: AuthProfile = { id: 'owner', username: 'qa', fullName: 'QA',
  role: 'DRIVER', active: true, phone: null, email: null, customer: null, branchId: null, locationId: null };
const hour = 3_600_000;
const now = Date.UTC(2026, 10, 21);
const tokenUntil = (exp: number) => `header.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString('base64url')}.signature`;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(getApiBaseUrl).mockReturnValue('https://example.test');
  const crypto = jest.requireMock<typeof import('expo-crypto')>('expo-crypto');
  jest.mocked(crypto.digestStringAsync).mockImplementation(async (_, value) =>
    createHash('sha256').update(value).digest('hex'));
  let stored: string | null = null;
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async () => stored);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (_, value) => { stored = value; });
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => { stored = null; });
});

afterEach(() => jest.restoreAllMocks());

it.each([2, 10])('giới hạn quyền đọc bằng JWT và tối đa 8h, exp sau %s giờ', async (hours) => {
  const token = tokenUntil(now + hours * hour);
  const expiry = now + Math.min(hours, 8) * hour;
  await offlineDriverIdentity.remember(token, profile);
  expect(await offlineDriverIdentity.read(token, expiry - 1)).toMatchObject({ ownerId: profile.id, expiresAt: expiry });
  expect(await offlineDriverIdentity.read(token, expiry)).toBeNull();
  expect(await offlineDriverIdentity.read(token, now - 1)).toBeNull();
  expect(jest.mocked(SecureStore.setItemAsync).mock.lastCall?.[1]).not.toContain(token);
});

it('yêu cầu đúng token, đúng môi trường và ngừng khôi phục sau logout', async () => {
  const token = tokenUntil(now + hour);
  expect(await offlineDriverIdentity.read(token)).toBeNull();
  await offlineDriverIdentity.remember(token, profile);
  expect(await offlineDriverIdentity.read(token + 'changed')).toBeNull();
  jest.mocked(getApiBaseUrl).mockReturnValue('https://other.example.test');
  expect(await offlineDriverIdentity.read(token)).toBeNull();
  jest.mocked(getApiBaseUrl).mockReturnValue('https://example.test');
  await offlineDriverIdentity.clear();
  expect(await offlineDriverIdentity.read(token)).toBeNull();
});

it('không cấp quyền Driver cho Customer và từ chối bản ghi hỏng', async () => {
  const token = tokenUntil(now + hour);
  await offlineDriverIdentity.remember(token, { ...profile, role: 'CUSTOMER' });
  expect(await offlineDriverIdentity.read(token)).toBeNull();
  jest.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('{broken');
  expect(await offlineDriverIdentity.read(token)).toBeNull();
});
