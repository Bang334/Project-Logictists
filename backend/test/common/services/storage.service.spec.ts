import { ForbiddenException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { StorageService } from '../../../src/common/services/storage.service';

describe('StorageService', () => {
  let storageRoot: string;
  let service: StorageService;
  const signingSecret = 'storage-signing-secret-at-least-32-characters';
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('test-png-content'),
  ]);

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(path.join(tmpdir(), 'tms-storage-'));
    const config = {
      get: jest.fn((key: string) =>
        key === 'STORAGE_ROOT'
          ? storageRoot
          : key === 'STORAGE_MAX_FILE_BYTES'
            ? '1024'
            : undefined,
      ),
      getOrThrow: jest.fn(() => signingSecret),
    } as unknown as ConfigService;
    service = new StorageService(config);
  });

  afterEach(async () => {
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  it('lưu file thật, tạo SHA-256 và chỉ tải được bằng chữ ký gắn user', async () => {
    const uploaded = await service.uploadFile(png, '../../proof.png', 'image/png', 'pod');
    expect(uploaded.fileKey).toMatch(/^pod\/[a-f0-9-]+-proof\.png$/);
    expect(uploaded.checksum).toMatch(/^[a-f0-9]{64}$/);

    const signedUrl = await service.getSignedDownloadUrl(uploaded.fileKey, 'user-1', 60);
    const query = new URL(signedUrl, 'http://local.test').searchParams;
    const fileKey = query.get('fileKey');
    const expires = query.get('expires');
    const signature = query.get('signature');
    if (!fileKey || !expires || !signature) throw new Error('Signed URL thiếu query bắt buộc');
    const downloaded = await service.downloadWithSignature(
      fileKey,
      'user-1',
      Number(expires),
      signature,
    );
    expect(downloaded.buffer).toEqual(png);
    expect(downloaded.checksum).toBe(uploaded.checksum);

    await expect(
      service.downloadWithSignature(
        fileKey,
        'user-2',
        Number(expires),
        signature,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('từ chối MIME khai báo không khớp chữ ký nội dung', async () => {
    await expect(
      service.uploadFile(Buffer.from('not-a-png'), 'fake.png', 'image/png'),
    ).rejects.toThrow(UnsupportedMediaTypeException);
  });

  it('phát hiện file bị sửa sau khi lưu', async () => {
    const uploaded = await service.uploadFile(png, 'proof.png', 'image/png', 'pod');
    const signedUrl = await service.getSignedDownloadUrl(uploaded.fileKey, 'user-1', 60);
    const query = new URL(signedUrl, 'http://local.test').searchParams;
    const expires = query.get('expires');
    const signature = query.get('signature');
    if (!expires || !signature) throw new Error('Signed URL thiếu query bắt buộc');
    const storedPath = path.resolve(storageRoot, ...uploaded.fileKey.split('/'));
    await fs.writeFile(storedPath, Buffer.concat([png, Buffer.from('tampered')]));

    await expect(
      service.downloadWithSignature(
        uploaded.fileKey,
        'user-1',
        Number(expires),
        signature,
      ),
    ).rejects.toThrow('không khớp metadata/checksum');
  });

  it('từ chối path traversal', async () => {
    await expect(service.getSignedDownloadUrl('../secret', 'user-1')).rejects.toThrow(
      'File key không hợp lệ',
    );
  });
});
