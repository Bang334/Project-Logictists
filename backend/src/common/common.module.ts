import { Module, Global } from '@nestjs/common';
import { IdempotencyService } from './services/idempotency.service';
import { AuditLogService } from './services/audit-log.service';
import { OutboxService } from './services/outbox.service';
import { StorageService } from './services/storage.service';
import { HealthController } from './health/health.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { OutboxEventPublisher } from './services/outbox-event.publisher';
import { OutboxWorkerService } from './services/outbox-worker.service';
import { OutboxAdminController } from './outbox-admin.controller';
import { FilesController } from './files.controller';

import { CloudinaryService } from './services/cloudinary.service';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

function redisConnection(urlValue: string | undefined) {
  const url = new URL(urlValue || 'redis://127.0.0.1:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Global()
@Module({
  imports: [
    PrismaModule,
    EventsModule,
    BullModule.registerQueueAsync({
      name: 'optimization',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnection(config.get<string>('REDIS_URL')),
      }),
    }),
  ],
  controllers: [HealthController, OutboxAdminController, FilesController],
  providers: [
    IdempotencyService,
    AuditLogService,
    OutboxService,
    StorageService,
    CloudinaryService,
    OutboxEventPublisher,
    OutboxWorkerService,
  ],
  exports: [
    IdempotencyService,
    AuditLogService,
    OutboxService,
    StorageService,
    CloudinaryService,
  ],
})
export class CommonModule {}
