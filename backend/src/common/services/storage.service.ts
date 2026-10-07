import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export type StorageFolder = 'products' | 'pod' | 'discrepancy';

export interface UploadFileResult {
  fileKey: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}

export interface StoredFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  checksum: string;
  sizeBytes: number;
}

type StoredFileMetadata = Omit<StoredFile, 'buffer'> & {
  version: 1;
  fileKey: string;
  createdAt: string;
};

const MIME_SIGNATURES: Record<string, (buffer: Buffer) => boolean> = {
  'image/jpeg': (buffer) =>
    buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/png': (buffer) =>
    buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/webp': (buffer) =>
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': (buffer) =>
    buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-',
};

@Injectable()
export class StorageService {
  private readonly storageRoot: string;
  private readonly signingSecret: string;
  private readonly maxFileBytes: number;

  constructor(private readonly config: ConfigService) {
    this.storageRoot = path.resolve(
      this.config.get<string>('STORAGE_ROOT') || path.join(process.cwd(), '.data', 'uploads'),
    );
    this.signingSecret =
      this.config.get<string>('STORAGE_SIGNING_SECRET') ||
      this.config.getOrThrow<string>('JWT_SECRET');
    this.maxFileBytes = Number(this.config.get<string>('STORAGE_MAX_FILE_BYTES') || 10_485_760);
    if (!Number.isInteger(this.maxFileBytes) || this.maxFileBytes <= 0) {
      throw new Error('STORAGE_MAX_FILE_BYTES phải là số nguyên dương');
    }
  }

  async uploadFile(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    folder: StorageFolder = 'products',
  ): Promise<UploadFileResult> {
    this.validateContent(fileBuffer, mimeType);
    const safeFilename = this.sanitizeFilename(filename);
    const fileKey = `${folder}/${randomUUID()}-${safeFilename}`;
    const targetPath = this.resolveFilePath(fileKey);
    const metadataPath = `${targetPath}.meta.json`;
    const temporarySuffix = `.tmp-${randomUUID()}`;
    const temporaryFilePath = `${targetPath}${temporarySuffix}`;
    const temporaryMetadataPath = `${metadataPath}${temporarySuffix}`;
    const checksum = createHash('sha256').update(fileBuffer).digest('hex');
    const metadata: StoredFileMetadata = {
      version: 1,
      fileKey,
      filename: safeFilename,
      mimeType,
      checksum,
      sizeBytes: fileBuffer.length,
      createdAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    try {
      await fs.writeFile(temporaryFilePath, fileBuffer, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(temporaryMetadataPath, JSON.stringify(metadata), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporaryFilePath, targetPath);
      await fs.rename(temporaryMetadataPath, metadataPath);
    } catch (error) {
      await Promise.allSettled([
        fs.unlink(temporaryFilePath),
        fs.unlink(temporaryMetadataPath),
        fs.unlink(targetPath),
        fs.unlink(metadataPath),
      ]);
      throw error;
    }

    return { fileKey, checksum, sizeBytes: fileBuffer.length, mimeType };
  }

  async getSignedDownloadUrl(
    fileKey: string,
    actorUserId: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600) {
      throw new BadRequestException('Thời hạn URL tải xuống phải từ 1 đến 3600 giây');
    }
    await this.readMetadata(fileKey);
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = this.sign(fileKey, actorUserId, expires);
    const query = new URLSearchParams({ fileKey, expires: String(expires), signature });
    return `/files/download?${query.toString()}`;
  }

  async downloadWithSignature(
    fileKey: string,
    actorUserId: string,
    expires: number,
    signature: string,
  ): Promise<StoredFile> {
    if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) {
      throw new ForbiddenException('URL tải tệp đã hết hạn');
    }
    const expected = this.sign(fileKey, actorUserId, expires);
    const suppliedBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(suppliedBuffer, expectedBuffer)
    ) {
      throw new ForbiddenException('Chữ ký tải tệp không hợp lệ');
    }

    const metadata = await this.readMetadata(fileKey);
    const buffer = await fs.readFile(this.resolveFilePath(fileKey));
    const checksum = createHash('sha256').update(buffer).digest('hex');
    if (buffer.length !== metadata.sizeBytes || checksum !== metadata.checksum) {
      throw new ConflictException('Tệp lưu trữ không khớp metadata/checksum');
    }
    return {
      buffer,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
      checksum,
      sizeBytes: buffer.length,
    };
  }

  private validateContent(buffer: Buffer, mimeType: string) {
    if (buffer.length === 0) throw new BadRequestException('Tệp tải lên không được rỗng');
    if (buffer.length > this.maxFileBytes) {
      throw new PayloadTooLargeException(`Tệp vượt giới hạn ${this.maxFileBytes} bytes`);
    }
    const signatureValidator = MIME_SIGNATURES[mimeType];
    if (!signatureValidator || !signatureValidator(buffer)) {
      throw new UnsupportedMediaTypeException('MIME type hoặc chữ ký nội dung tệp không hợp lệ');
    }
  }

  private sanitizeFilename(filename: string): string {
    const safe = path
      .basename(filename.normalize('NFKC'))
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120);
    if (!safe) throw new BadRequestException('Tên tệp không hợp lệ');
    return safe;
  }

  private resolveFilePath(fileKey: string): string {
    if (!/^(products|pod|discrepancy)\/[a-zA-Z0-9._-]+$/.test(fileKey)) {
      throw new BadRequestException('File key không hợp lệ');
    }
    const resolved = path.resolve(this.storageRoot, ...fileKey.split('/'));
    if (!resolved.startsWith(`${this.storageRoot}${path.sep}`)) {
      throw new BadRequestException('File key nằm ngoài storage root');
    }
    return resolved;
  }

  private async readMetadata(fileKey: string): Promise<StoredFileMetadata> {
    try {
      const content = await fs.readFile(`${this.resolveFilePath(fileKey)}.meta.json`, 'utf8');
      const metadata = JSON.parse(content) as StoredFileMetadata;
      if (
        metadata.version !== 1 ||
        metadata.fileKey !== fileKey ||
        typeof metadata.filename !== 'string' ||
        typeof metadata.mimeType !== 'string' ||
        !/^[a-f0-9]{64}$/.test(metadata.checksum) ||
        !Number.isInteger(metadata.sizeBytes)
      ) {
        throw new Error('invalid metadata');
      }
      return metadata;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new NotFoundException('Không tìm thấy tệp lưu trữ');
      throw new ConflictException('Metadata tệp lưu trữ bị hỏng');
    }
  }

  private sign(fileKey: string, actorUserId: string, expires: number): string {
    return createHmac('sha256', this.signingSecret)
      .update(`${fileKey}\n${actorUserId}\n${expires}`)
      .digest('hex');
  }
}
