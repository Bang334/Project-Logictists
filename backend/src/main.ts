import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { BigIntSerializationInterceptor } from './common/interceptors/bigint-serialization.interceptor';
import { ConfiguredIoAdapter } from './events/configured-io.adapter';

async function bootstrap() {
  const logger = new Logger('Retail_TMS_Bootstrap');
  const app = await NestFactory.create(AppModule);

  if (!process.env.MAPBOX_ACCESS_TOKEN) {
    logger.warn('Chưa cấu hình MAPBOX_ACCESS_TOKEN; các tính năng Mapbox sẽ không khả dụng.');
  }

  // Bật CORS cho Web và Mobile
  const allowedOrigins = process.env.CORS_ORIGIN!.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, allowedOrigins));
  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Gắn Correlation ID Interceptor tự động cho mọi request
  app.useGlobalInterceptors(
    new CorrelationIdInterceptor(),
    new BigIntSerializationInterceptor(),
  );

  // Global Exception Filter chuẩn hóa mã lỗi và chống lộ stack trace
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global Validation Pipe cho Runtime Input
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const port = process.env.PORT || 4000;
  await app.listen(port);
  logger.log(`🛒 Smart Retail & TMS Backend API đang chạy tại: http://localhost:${port}`);
}

bootstrap();
