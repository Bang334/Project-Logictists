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
