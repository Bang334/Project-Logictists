import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { tokenStorage } from '@/shared/storage/token-storage';
import { jwtExpiry } from '@/features/auth/services/offline-driver-identity';

export async function readGpsCredential(userId: string) {
  try {
    const token = await tokenStorage.get();
    if (!token) return null;
    const expiresAt = jwtExpiry(token);
    if (expiresAt === null) return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    const body = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims: unknown = JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4, '=')));
    if (!claims || typeof claims !== 'object' ||
        !('sub' in claims) || claims.sub !== userId ||
        !('role' in claims) || claims.role !== 'DRIVER') return null;
    const tag = await digestStringAsync(CryptoDigestAlgorithm.SHA256, token);
    return { token, tag, expiresAt };
  } catch {
    return null;
  }
}
