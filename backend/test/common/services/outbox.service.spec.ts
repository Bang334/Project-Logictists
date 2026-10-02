import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { OutboxService } from '../../../src/common/services/outbox.service';

describe('OutboxService admin operations', () => {
  const prisma = {
    $transaction: jest.fn(),
    outboxEvent: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  } as unknown as PrismaService;
  const service = new OutboxService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (arg) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
    );
  });

  it('liệt kê lỗi nhưng không trả payload có thể chứa credential', async () => {
    (prisma.outboxEvent.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.outboxEvent.count as jest.Mock).mockResolvedValue(0);

    await service.listFailures(1, 20);
    const query = (prisma.outboxEvent.findMany as jest.Mock).mock.calls[0][0];
    expect(query.select.payload).toBeUndefined();
    expect(query.select.lastError).toBe(true);
  });

  it('retry dead-letter và ghi audit trong cùng transaction', async () => {
    (prisma.outboxEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 'row-1',
      eventId: 'event-1',
      eventType: 'RETAIL_READY_FOR_COLLECTION',
      publishedAt: null,
      deadLetteredAt: new Date(),
    });
    (prisma.outboxEvent.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    await expect(service.retryDeadLetter('row-1', 'admin-1')).resolves.toEqual({
      id: 'row-1',
      eventId: 'event-1',
      status: 'RETRY_SCHEDULED',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RETRY_DEAD_LETTER', actorUserId: 'admin-1' }),
      }),
    );
  });

  it('không retry event chưa vào dead-letter', async () => {
    (prisma.outboxEvent.findUnique as jest.Mock).mockResolvedValue({
      id: 'row-1',
      eventId: 'event-1',
      eventType: 'SALES_ORDER_CONFIRMED',
      publishedAt: null,
      deadLetteredAt: null,
    });
    await expect(service.retryDeadLetter('row-1', 'admin-1')).rejects.toThrow(
      ConflictException,
    );
  });
});
