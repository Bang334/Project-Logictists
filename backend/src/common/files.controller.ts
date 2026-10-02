import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Response } from 'express';
import { AuthenticatedUser } from '../auth/branch-scope';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StorageService } from './services/storage.service';
import { CloudinaryService } from './services/cloudinary.service';

@Controller('files')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.STAFF, Role.DRIVER, Role.CUSTOMER)
export class FilesController {
  constructor(
    private readonly storage: StorageService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Vui lòng chọn tệp ảnh để tải lên');
    }
    const result = await this.cloudinary.uploadBuffer(
      file.buffer,
      file.originalname,
      folder || 'tms/products',
    );
    return {
      url: result.url,
      publicId: result.publicId,
      format: result.format,
      bytes: result.bytes,
    };
  }

  @Get('download')
  async download(
    @Query('fileKey') fileKey: string,
    @Query('expires') expiresRaw: string,
    @Query('signature') signature: string,
    @Req() req: { user: AuthenticatedUser },
    @Res() response: Response,
  ) {
    const file = await this.storage.downloadWithSignature(
      fileKey,
      req.user.id,
      Number(expiresRaw),
      signature,
    );
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.sizeBytes));
    response.setHeader('ETag', `"sha256-${file.checksum}"`);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${file.filename.replace(/["\\]/g, '_')}"`,
    );
    return response.send(file.buffer);
  }
}
