import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RetailAnalyticsService } from '../../src/retail-analytics/retail-analytics.service';

describe('RetailAnalyticsService', () => {
  it('không cho ghi thanh toán bằng 0', async () => {
    const module = await Test.createTestingModule({ providers: [RetailAnalyticsService, { provide: PrismaService, useValue: {} }] }).compile();
    await expect(module.get(RetailAnalyticsService).recordRetailPayment({ salesOrderId: 'order', paymentMethod: 'CASH', amountPaid: 0, idempotencyKey: 'key' }, { id: 'staff', role: Role.ADMIN })).rejects.toBeInstanceOf(BadRequestException);
  });
});
