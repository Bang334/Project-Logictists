import {
  decryptSensitivePayload,
  encryptSensitivePayload,
} from '../../../src/common/security/sensitive-payload.crypto';

describe('sensitive payload crypto', () => {
  it('mã hóa authenticated và giải mã đúng dữ liệu', () => {
    const encrypted = encryptSensitivePayload(
      { otpCode: '123456', qrToken: 'qr-secret' },
      'collection-secret',
    );
    expect(encrypted).not.toContain('123456');
    expect(decryptSensitivePayload(encrypted, 'collection-secret')).toEqual({
      otpCode: '123456',
      qrToken: 'qr-secret',
    });
  });

  it('từ chối ciphertext bị sửa', () => {
    const encrypted = encryptSensitivePayload({ otpCode: '123456' }, 'collection-secret');
    const [iv, tag, ciphertext] = encrypted.split('.');
    const changedCiphertext = Buffer.from(ciphertext, 'base64url');
    changedCiphertext[0] ^= 1;
    const tampered = `${iv}.${tag}.${changedCiphertext.toString('base64url')}`;
    expect(() => decryptSensitivePayload(tampered, 'collection-secret')).toThrow();
  });
});
