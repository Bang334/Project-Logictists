import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { OutboxService } from '../../src/common/services/outbox.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SalesOrdersService } from '../../src/sales-orders/sales-orders.service';

describe('SalesOrdersService (unified orders)', () => {
  it('từ chối checkout không có mặt hàng trước khi ghi database', async () => {
    const module = await Test.createTestingModule({ providers: [SalesOrdersService, { provide: PrismaService, useValue: {} }, { provide: OutboxService, useValue: {} }, { provide: InventoryService, useValue: {} }] }).compile();
    const service = module.get(SalesOrdersService);
    await expect(service.checkoutOrder({ customerName: 'A', customerPhone: '0900', selectedPickupPointId: 'point', idempotencyKey: 'key', items: [] }, { id: 'user', role: Role.CUSTOMER })).rejects.toBeInstanceOf(BadRequestException);
  });
});
