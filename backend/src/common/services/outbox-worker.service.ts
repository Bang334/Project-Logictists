import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxEventPublisher } from './outbox-event.publisher';

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly workerId = `outbox-${process.pid}-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private processing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly publisher: OutboxEventPublisher,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('OUTBOX_WORKER_ENABLED') === 'false') return;
    const pollMs = this.numberConfig('OUTBOX_POLL_INTERVAL_MS', 2000, 250);
    this.timer = setInterval(() => this.scheduleBatch(), pollMs);
    this.timer.unref();
    this.scheduleBatch();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async processBatch(): Promise<number> {
    if (this.processing) return 0;
    this.processing = true;
    try {
      const events = await this.claimBatch();
      for (const event of events) await this.processEvent(event);
      return events.length;
    } finally {
      this.processing = false;
    }
  }

  private scheduleBatch() {
    void this.processBatch().catch(() => {
      this.logger.error('Outbox worker không thể claim/process batch; sẽ thử lại ở chu kỳ sau');
    });
  }

  private async claimBatch(): Promise<OutboxEvent[]> {
    const batchSize = this.numberConfig('OUTBOX_BATCH_SIZE', 25, 1);
    const leaseMs = this.numberConfig('OUTBOX_LEASE_MS', 60_000, 5000);
    const staleBefore = new Date(Date.now() - leaseMs);
    return this.prisma.$queryRaw<OutboxEvent[]>`
      UPDATE "outbox_events"
      SET "lockedAt" = NOW(), "lockedBy" = ${this.workerId}
      WHERE "id" IN (
        SELECT "id"
        FROM "outbox_events"
        WHERE "publishedAt" IS NULL
          AND "deadLetteredAt" IS NULL
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${batchSize}
      )
      RETURNING *
    `;
  }

  private async processEvent(event: OutboxEvent): Promise<void> {
    try {
      await this.publisher.publish(event);
      await this.prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: this.workerId, publishedAt: null },
        data: {
          publishedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const attempts = event.attempts + 1;
      const maxAttempts = this.numberConfig('OUTBOX_MAX_ATTEMPTS', 10, 1);
      const retryBaseMs = this.numberConfig('OUTBOX_RETRY_BASE_MS', 1000, 100);
      const retryDelayMs = Math.min(retryBaseMs * 2 ** Math.min(attempts - 1, 8), 300_000);
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'Unknown publish error';
      await this.prisma.outboxEvent.updateMany({
        where: { id: event.id, lockedBy: this.workerId, publishedAt: null },
        data: {
          attempts,
          lastError: message,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: attempts >= maxAttempts ? null : new Date(Date.now() + retryDelayMs),
          deadLetteredAt: attempts >= maxAttempts ? new Date() : null,
        },
      });
      this.logger.warn(`Outbox event ${event.eventId} publish failed (attempt ${attempts})`);
    }
  }

  private numberConfig(key: string, fallback: number, minimum: number): number {
    const raw = this.config.get<string>(key);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(`${key} phải là số nguyên >= ${minimum}`);
    }
    return value;
  }
}
