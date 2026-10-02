import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { PickupService } from '../../src/pickup/pickup.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OutboxService } from '../../src/common/services/outbox.service';

describe('PickupService', () => {
  it('bắt buộc OTP hoặc QR khi xác nhận nhận hàng', async () => {
    const module = await Test.createTestingModule({ providers: [PickupService, { provide: PrismaService, useValue: {} }, { provide: OutboxService, useValue: {} }] }).compile();
    await expect(module.get(PickupService).verifyAndCollect({ salesOrderId: 'order', pickupPointId: 'point' }, { id: 'staff', role: Role.ADMIN })).rejects.toBeInstanceOf(BadRequestException);
  });
});
