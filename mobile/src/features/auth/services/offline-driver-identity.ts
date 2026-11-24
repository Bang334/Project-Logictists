import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { AuthProfile } from '../types/auth.types';
import { getApiBaseUrl } from '@/shared/config/environment';

const storageKey = 'smart_tms_offline_driver_identity_v1';
const maxAge = 8 * 60 * 60 * 1000;

export interface OfflineDriverIdentity {
  version: 1;
  ownerId: string;
  scope: string;
  tokenDigest: string;
  verifiedAt: number;
  expiresAt: number;
}

export function jwtExpiry(token: string): number | null {
  try {
    const segments = token.split('.');
    if (segments.length !== 3 || !segments.every((segment) => /^[\w-]+$/.test(segment))) return null;
    const body = (segments[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const expiration: unknown = JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, '='))).exp;
    return typeof expiration === 'number' && Number.isSafeInteger(expiration * 1000) && expiration > 0
      ? expiration * 1000 : null;
  } catch {
    return null;
  }
}

function digest(value: string) {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
}

export const offlineDriverIdentity = {
  async remember(token: string, profile: AuthProfile) {
    const expiry = jwtExpiry(token);
    const verifiedAt = Date.now();
    if (!profile.active || profile.role !== 'DRIVER' || !expiry || expiry <= verifiedAt) {
      return this.clear();
    }
    const record: OfflineDriverIdentity = {
      version: 1,
      ownerId: profile.id,
      scope: await digest(getApiBaseUrl()),
      tokenDigest: await digest(token),
      verifiedAt,
      expiresAt: Math.min(expiry, verifiedAt + maxAge),
    };
    await SecureStore.setItemAsync(storageKey, JSON.stringify(record), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  async read(token: string, now = Date.now()): Promise<OfflineDriverIdentity | null> {
    try {
      const stored = await SecureStore.getItemAsync(storageKey);
      if (!stored) return null;
      const record: OfflineDriverIdentity = JSON.parse(stored);
      const expiry = jwtExpiry(token);
      if (record.version !== 1 || typeof record.ownerId !== 'string' || !record.ownerId ||
          !Number.isSafeInteger(record.verifiedAt) || record.verifiedAt > now ||
          !expiry || record.expiresAt !== Math.min(expiry, record.verifiedAt + maxAge) ||
          now >= record.expiresAt || record.scope !== await digest(getApiBaseUrl()) ||
          record.tokenDigest !== await digest(token)) return null;
      return record;
    } catch {
      return null;
    }
  },
  clear() {
    return SecureStore.deleteItemAsync(storageKey);
  },
};
