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

@Global()
@Module({
  imports: [PrismaModule, EventsModule],
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
