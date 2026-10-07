import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

export interface EnqueueOutboxEventParams {
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  eventType: string;
  payload: Record<string, any>;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tạo bản ghi outbox event trong cùng Transaction với nghiệp vụ (R1-06, RR22)
   */
  async enqueue(
    params: EnqueueOutboxEventParams,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx || this.prisma;
    const eventId = randomUUID();

    await client.outboxEvent.create({
      data: {
        eventId,
        aggregateType: params.aggregateType,
        aggregateId: params.aggregateId,
        aggregateVersion: params.aggregateVersion || 1,
        eventType: params.eventType,
        payload: params.payload,
      },
    });

    this.logger.debug(
      `Đã xếp hàng outbox event ${params.eventType} cho ${params.aggregateType}:${params.aggregateId}`,
    );
  }

  async listFailures(page: number, limit: number) {
    const where: Prisma.OutboxEventWhereInput = {
      publishedAt: null,
      OR: [{ deadLetteredAt: { not: null } }, { lastError: { not: null } }],
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.outboxEvent.findMany({
        where,
        select: {
          id: true,
          eventId: true,
          aggregateType: true,
          aggregateId: true,
          aggregateVersion: true,
          eventType: true,
          attempts: true,
          lastError: true,
          nextAttemptAt: true,
          deadLetteredAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.outboxEvent.count({ where }),
    ]);
    return { data, page, limit, total };
  }

  async retryDeadLetter(id: string, actorUserId: string) {
    const event = await this.prisma.outboxEvent.findUnique({
      where: { id },
      select: { id: true, eventId: true, eventType: true, publishedAt: true, deadLetteredAt: true },
    });
    if (!event) throw new NotFoundException('Không tìm thấy outbox event');
    if (event.publishedAt) throw new ConflictException('Event đã được publish');
    if (!event.deadLetteredAt) throw new ConflictException('Event chưa ở dead-letter');

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.outboxEvent.updateMany({
        where: { id, publishedAt: null, deadLetteredAt: { not: null } },
        data: {
          attempts: 0,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
          nextAttemptAt: new Date(),
          deadLetteredAt: null,
        },
      });
      if (updated.count !== 1) throw new ConflictException('Event đã thay đổi, hãy tải lại');
      await tx.auditLog.create({
        data: {
          entityType: 'OutboxEvent',
          entityId: id,
          action: 'RETRY_DEAD_LETTER',
          performedBy: actorUserId,
          actorUserId,
          changeSummary: { eventId: event.eventId, eventType: event.eventType },
        },
      });
    });
    return { id, eventId: event.eventId, status: 'RETRY_SCHEDULED' };
  }
}
