import { ConfigService } from '@nestjs/config';
import { OutboxEvent } from '@prisma/client';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { OutboxEventPublisher } from '../../../src/common/services/outbox-event.publisher';
import { OutboxWorkerService } from '../../../src/common/services/outbox-worker.service';

describe('OutboxWorkerService', () => {
  const event: OutboxEvent = {
    id: 'row-1',
    eventId: 'event-1',
    aggregateType: 'SalesOrder',
    aggregateId: 'order-1',
    aggregateVersion: 1,
    eventType: 'SALES_ORDER_CONFIRMED',
    payload: { pickupPointId: 'location-1' },
    publishedAt: null,
    attempts: 0,
    lastError: null,
    lockedAt: new Date(),
    lockedBy: 'worker',
    nextAttemptAt: null,
    deadLetteredAt: null,
    createdAt: new Date(),
  };
  const prisma = {
    $queryRaw: jest.fn(),
    outboxEvent: { updateMany: jest.fn() },
  } as unknown as PrismaService;
  const config = {
    get: jest.fn((key: string) => (key === 'OUTBOX_MAX_ATTEMPTS' ? '2' : undefined)),
  } as unknown as ConfigService;
  const publisher = { publish: jest.fn() } as unknown as OutboxEventPublisher;
  let worker: OutboxWorkerService;

  beforeEach(() => {
    jest.clearAllMocks();
    worker = new OutboxWorkerService(prisma, config, publisher);
  });

  it('đánh dấu published chỉ sau khi transport thành công', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([event]);
    (publisher.publish as jest.Mock).mockResolvedValue(undefined);

    await expect(worker.processBatch()).resolves.toBe(1);
    expect(publisher.publish).toHaveBeenCalledWith(event);
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ publishedAt: expect.any(Date) }) }),
    );
  });

  it('retry với backoff và không đánh dấu published khi transport lỗi', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([event]);
    (publisher.publish as jest.Mock).mockRejectedValue(new Error('provider unavailable'));

    await worker.processBatch();
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attempts: 1,
          lastError: 'provider unavailable',
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
    const update = (prisma.outboxEvent.updateMany as jest.Mock).mock.calls[0][0];
    expect(update.data).not.toHaveProperty('publishedAt');
  });

  it('chuyển dead-letter khi đạt số lần thử tối đa', async () => {
    (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ ...event, attempts: 1 }]);
    (publisher.publish as jest.Mock).mockRejectedValue(new Error('still unavailable'));

    await worker.processBatch();
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attempts: 2,
          deadLetteredAt: expect.any(Date),
          nextAttemptAt: null,
        }),
      }),
    );
  });
});
