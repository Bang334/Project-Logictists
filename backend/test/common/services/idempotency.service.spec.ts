import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { IdempotencyService } from '../../../src/common/services/idempotency.service';
import { PrismaService } from '../../../src/prisma/prisma.service';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  let prismaMock: {
    processedCommand: {
      findUnique: jest.Mock;
      createMany: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prismaMock = {
      processedCommand: {
        findUnique: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
  });

  it('should hash payloads deterministically using SHA-256', () => {
    const payloadA = { skuId: 'sku-1', qty: 2 };
    const payloadB = { skuId: 'sku-1', qty: 2 };
    const payloadC = { skuId: 'sku-1', qty: 3 };

    const hashA = service.hashPayload(payloadA);
    const hashB = service.hashPayload(payloadB);
    const hashC = service.hashPayload(payloadC);

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
  });

  it('should return isProcessed: false and commandRecordId when command is fresh', async () => {
    prismaMock.processedCommand.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
      id: 'cmd-rec-1',
      actorUserId: 'user-1',
      commandType: 'RESERVE_INVENTORY',
      idempotencyKey: 'idem-1',
      requestHash: service.hashPayload({ skuId: 'sku-1', qty: 1 }),
      status: 'PROCESSING',
    });
    prismaMock.processedCommand.createMany.mockResolvedValue({ count: 1 });

    const result = await service.checkOrStartCommand(
      'user-1',
      'RESERVE_INVENTORY',
      'idem-1',
      { skuId: 'sku-1', qty: 1 },
    );

    expect(result.isProcessed).toBe(false);
    if (!result.isProcessed) {
      expect(result.commandRecordId).toBe('cmd-rec-1');
    }
    expect(prismaMock.processedCommand.findUnique).toHaveBeenCalledTimes(2);
    expect(prismaMock.processedCommand.createMany).toHaveBeenCalledTimes(1);
  });

  it('should return cached result when command is already COMPLETED with same payload', async () => {
    const payload = { skuId: 'sku-1', qty: 1 };
    const hash = service.hashPayload(payload);

    prismaMock.processedCommand.findUnique.mockResolvedValue({
      id: 'cmd-rec-1',
      actorUserId: 'user-1',
      commandType: 'RESERVE_INVENTORY',
      idempotencyKey: 'idem-1',
      requestHash: hash,
      status: 'COMPLETED',
      result: { reservationId: 'res-99' },
    });

    const result = await service.checkOrStartCommand(
      'user-1',
      'RESERVE_INVENTORY',
      'idem-1',
      payload,
    );

    expect(result.isProcessed).toBe(true);
    if (result.isProcessed) {
      expect(result.result).toEqual({ reservationId: 'res-99' });
    }
    expect(prismaMock.processedCommand.createMany).not.toHaveBeenCalled();
  });

  it('should throw ConflictException (RR07, RT03) when idempotency key is reused with different payload', async () => {
    const originalPayload = { skuId: 'sku-1', qty: 1 };
    const originalHash = service.hashPayload(originalPayload);

    prismaMock.processedCommand.findUnique.mockResolvedValue({
      id: 'cmd-rec-1',
      actorUserId: 'user-1',
      commandType: 'RESERVE_INVENTORY',
      idempotencyKey: 'idem-1',
      requestHash: originalHash,
      status: 'COMPLETED',
      result: { reservationId: 'res-99' },
    });

    const differentPayload = { skuId: 'sku-1', qty: 5 }; // Thay đổi qty

    await expect(
      service.checkOrStartCommand(
        'user-1',
        'RESERVE_INVENTORY',
        'idem-1',
        differentPayload,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('should throw ConflictException when command is currently PROCESSING', async () => {
    const payload = { skuId: 'sku-1', qty: 1 };
    const hash = service.hashPayload(payload);

    prismaMock.processedCommand.findUnique.mockResolvedValue({
      id: 'cmd-rec-1',
      actorUserId: 'user-1',
      commandType: 'RESERVE_INVENTORY',
      idempotencyKey: 'idem-1',
      requestHash: hash,
      status: 'PROCESSING',
    });

    await expect(
      service.checkOrStartCommand(
        'user-1',
        'RESERVE_INVENTORY',
        'idem-1',
        payload,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('chỉ một request được claim khi hai request cùng key chạy đồng thời', async () => {
    const payload = { skuId: 'sku-1', qty: 1 };
    const hash = service.hashPayload(payload);
    prismaMock.processedCommand.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'cmd-rec-1',
        requestHash: hash,
        status: 'PROCESSING',
        result: null,
        updatedAt: new Date(),
      });
    prismaMock.processedCommand.createMany.mockResolvedValue({ count: 0 });

    await expect(
      service.checkOrStartCommand(
        'user-1',
        'RESERVE_INVENTORY',
        'idem-1',
        payload,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('should mark command as COMPLETED with result', async () => {
    prismaMock.processedCommand.update.mockResolvedValue({});

    await service.completeCommand('cmd-rec-1', { reservationId: 'res-100' });

    expect(prismaMock.processedCommand.update).toHaveBeenCalledWith({
      where: { id: 'cmd-rec-1' },
      data: {
        status: 'COMPLETED',
        result: { reservationId: 'res-100' },
      },
    });
  });

  it('should mark command as FAILED with error reason', async () => {
    prismaMock.processedCommand.update.mockResolvedValue({});

    await service.failCommand('cmd-rec-1', 'INVENTORY_SHORTAGE');

    expect(prismaMock.processedCommand.update).toHaveBeenCalledWith({
      where: { id: 'cmd-rec-1' },
      data: {
        status: 'FAILED',
        result: { error: 'INVENTORY_SHORTAGE' },
      },
    });
  });
});
