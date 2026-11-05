import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { OutboxService } from '../../src/common/services/outbox.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SalesOrdersService } from '../../src/sales-orders/sales-orders.service';

describe('SalesOrdersService (unified orders)', () => {
  it('rejects transport cancellation through the retail endpoint even for ADMIN before writing', async () => {
    const transaction = jest.fn();
    const module = await Test.createTestingModule({ providers: [SalesOrdersService,
      { provide: PrismaService, useValue: { order: { findUnique: jest.fn().mockResolvedValue({ id: 'transport', orderType: 'B2B_TRANSPORT', status: 'ASSIGNED' }) }, $transaction: transaction } },
      { provide: OutboxService, useValue: {} }, { provide: InventoryService, useValue: {} },
    ] }).compile();
    await expect(module.get(SalesOrdersService).cancelOrder('transport', { reason: 'Bypass attempt', idempotencyKey: 'test-only-key' }, { id: 'admin', role: Role.ADMIN })).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('từ chối checkout không có mặt hàng trước khi ghi database', async () => {
    const module = await Test.createTestingModule({ providers: [SalesOrdersService, { provide: PrismaService, useValue: {} }, { provide: OutboxService, useValue: {} }, { provide: InventoryService, useValue: {} }] }).compile();
    const service = module.get(SalesOrdersService);
    await expect(service.checkoutOrder({ customerName: 'A', customerPhone: '0900', selectedPickupPointId: 'point', idempotencyKey: 'key', items: [] }, { id: 'user', role: Role.CUSTOMER })).rejects.toBeInstanceOf(BadRequestException);
  });
});
