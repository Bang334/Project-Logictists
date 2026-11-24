import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';

export interface CloudinaryUploadResponse {
  url: string;
  publicId: string;
  bytes: number;
  format: string;
}

export interface CloudinaryPodAsset {
  publicId: string;
  bytes: number;
  format: string;
}

interface CloudinaryApiError {
  http_code?: number;
  error?: {
    http_code?: number;
  };
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private readonly isConfigured: boolean;

  constructor(private readonly config: ConfigService) {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');

    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      this.isConfigured = true;
      this.logger.log(`Cloudinary đã được cấu hình với cloud_name: ${cloudName}`);
    } else {
      this.isConfigured = false;
      this.logger.warn('Chưa cấu hình CLOUDINARY credentials trong môi trường');
    }
  }

  async uploadBuffer(
    buffer: Buffer,
    filename: string,
    folder = 'tms/products',
  ): Promise<CloudinaryUploadResponse> {
    if (!this.isConfigured) {
      throw new BadRequestException('Dịch vụ Cloudinary chưa được cấu hình');
    }

    if (!buffer || buffer.length === 0) {
      throw new BadRequestException('Tệp rỗng hoặc không hợp lệ');
    }

    const cleanFilename = filename
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_');

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: `${cleanFilename}_${Date.now()}`,
          resource_type: 'auto',
          overwrite: true,
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error || !result) {
            this.logger.error('Lỗi upload lên Cloudinary:', error);
            return reject(new BadRequestException(error?.message || 'Không thể upload ảnh lên Cloudinary'));
          }
          resolve({
            url: result.secure_url,
            publicId: result.public_id,
            bytes: result.bytes,
            format: result.format,
          });
        },
      );

      const readableStream = new Readable();
      readableStream.push(buffer);
      readableStream.push(null);
      readableStream.pipe(uploadStream);
    });
  }

  async uploadPodImage(
    buffer: Buffer,
    storageKey: string,
  ): Promise<CloudinaryPodAsset> {
    if (!this.isConfigured) {
      throw new BadRequestException('Dịch vụ Cloudinary chưa được cấu hình');
    }
    if (!buffer.length) {
      throw new BadRequestException('Tệp rỗng hoặc không hợp lệ');
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: storageKey,
          resource_type: 'image',
          type: 'authenticated',
          overwrite: false,
          unique_filename: false,
          use_filename: false,
        },
        (error, result: UploadApiResponse | undefined) => {
          if (error || !result) {
            this.logger.error('Lỗi upload POD lên Cloudinary');
            return reject(
              new BadRequestException(
                error?.message || 'Không thể upload POD lên Cloudinary',
              ),
            );
          }
          resolve({
            publicId: result.public_id,
            bytes: result.bytes,
            format: result.format,
          });
        },
      );
      Readable.from(buffer).pipe(uploadStream);
    });
  }

  async findPodImage(storageKey: string): Promise<CloudinaryPodAsset | null> {
    if (!this.isConfigured) {
      throw new BadRequestException('Dịch vụ Cloudinary chưa được cấu hình');
    }
    try {
      const result = await cloudinary.api.resource(storageKey, {
        resource_type: 'image',
        type: 'authenticated',
      });
      return {
        publicId: result.public_id as string,
        bytes: result.bytes as number,
        format: result.format as string,
      };
    } catch (error) {
      const cloudinaryError = error as CloudinaryApiError;
      const status =
        cloudinaryError.http_code ?? cloudinaryError.error?.http_code;
      if (status === 404) return null;
      this.logger.error('Lỗi kiểm tra POD trên Cloudinary');
      throw new BadRequestException('Không thể kiểm tra POD trên Cloudinary');
    }
  }

  createPodDownloadUrl(
    storageKey: string,
    format: string,
    expiresAt: Date,
  ): string {
    if (!this.isConfigured) {
      throw new BadRequestException('Dịch vụ Cloudinary chưa được cấu hình');
    }
    return cloudinary.utils.private_download_url(storageKey, format, {
      resource_type: 'image',
      type: 'authenticated',
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      attachment: false,
    });
  }

  async deleteFile(publicId: string): Promise<boolean> {
    if (!this.isConfigured) return false;
    try {
      const res = await cloudinary.uploader.destroy(publicId);
      return res.result === 'ok';
    } catch (err) {
      this.logger.error(`Lỗi khi xóa tệp ${publicId} trên Cloudinary:`, err);
      return false;
    }
  }
}
