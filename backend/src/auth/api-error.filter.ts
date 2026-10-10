import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json({ statusCode: error.getStatus(), code: `HTTP_${error.getStatus()}`, ...(typeof body === 'string' ? { message: body } : body) });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003', 'P2025'].includes(error.code)) {
      response.status(409).json({ statusCode: 409, code: 'DATA_CONFLICT', message: 'Dữ liệu trùng, không tồn tại hoặc đã thay đổi. Vui lòng tải lại' });
      return;
    }
    response.status(503).json({ statusCode: 503, code: 'SERVICE_UNAVAILABLE', message: 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại' });
  }
}
