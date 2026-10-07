import { Test } from '@nestjs/testing';
import { OutboxService } from '../../src/common/services/outbox.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { OrderProcessingService } from '../../src/fulfillment/fulfillment.service';

describe('OrderProcessingService', () => {
  it('trả hàng đợi rỗng từ dữ liệu thật của repository', async () => {
    const module = await Test.createTestingModule({
      providers: [
        OrderProcessingService,
        { provide: PrismaService, useValue: { order: { findMany: jest.fn().mockResolvedValue([]) } } },
        { provide: OutboxService, useValue: {} },
        { provide: InventoryService, useValue: {} },
      ],
    }).compile();
    await expect(module.get(OrderProcessingService).getPreparationQueue({})).resolves.toEqual([]);
  });
});
