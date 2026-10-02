import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';

export function encryptSensitivePayload(
  payload: Record<string, string>,
  secret: string,
): string {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(secret).digest();
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptSensitivePayload(
  encrypted: string,
  secret: string,
): Record<string, string> {
  const parts = encrypted.split('.');
  if (parts.length !== 3) throw new Error('Encrypted payload không hợp lệ');
  const [ivEncoded, tagEncoded, ciphertextEncoded] = parts;
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivEncoded, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const parsed: unknown = JSON.parse(plaintext);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Decrypted payload không hợp lệ');
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string') throw new Error('Decrypted payload chứa giá trị không hợp lệ');
  }
  return parsed as Record<string, string>;
}
