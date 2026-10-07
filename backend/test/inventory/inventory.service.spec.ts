import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { InventoryService } from '../../src/inventory/inventory.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { IdempotencyService } from '../../src/common/services/idempotency.service';
import { AuditLogService } from '../../src/common/services/audit-log.service';
import { ReservationStatus, LedgerSourceType } from '@prisma/client';

describe('InventoryService', () => {
  let service: InventoryService;
  let prismaMock: any;
  let idempotencyMock: any;
  let auditLogMock: any;

  beforeEach(async () => {
    process.env.RETAIL_RESERVATION_TTL_MINUTES = '15';
    prismaMock = {
      $transaction: jest.fn((cb) => cb(prismaMock)),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'bal-1' }]),
      stockBalance: {
        findUnique: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      inventoryReservation: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      stockLedgerEntry: {
        create: jest.fn(),
      },
    };

    idempotencyMock = {
      checkOrStartCommand: jest.fn().mockResolvedValue({
        isProcessed: false,
        commandRecordId: 'cmd-rec-1',
      }),
      completeCommand: jest.fn().mockResolvedValue(undefined),
      failCommand: jest.fn().mockResolvedValue(undefined),
    };

    auditLogMock = {
      logAction: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: IdempotencyService, useValue: idempotencyMock },
        { provide: AuditLogService, useValue: auditLogMock },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
  });

  describe('createReservation (Oversell prevention - R3-05, R3-06)', () => {
    it('should successfully reserve stock when sellable quantity is sufficient', async () => {
      // onHand: 10, reserved: 2, safetyBuffer: 2 -> sellable = 10 - 2 - 2 = 6
      prismaMock.stockBalance.findUnique.mockResolvedValue({
        id: 'sb-1',
        skuId: 'sku-rice-1',
        locationId: 'loc-store-1',
        onHand: 10,
        reserved: 2,
        safetyBuffer: 2,
      });

      prismaMock.inventoryReservation.create.mockResolvedValue({
        id: 'res-1',
        reservationNumber: 'RES-12345',
        skuId: 'sku-rice-1',
        locationId: 'loc-store-1',
        quantity: 4,
        status: ReservationStatus.ACTIVE,
      });

      const result = await service.createReservation({
        locationId: 'loc-store-1',
        idempotencyKey: 'idem-res-1',
        lines: [{ skuId: 'sku-rice-1', quantity: 4 }],
      });

      expect(result.reservations).toHaveLength(1);
      expect(prismaMock.stockBalance.update).toHaveBeenCalledWith({
        where: { id: 'sb-1' },
        data: {
          reserved: { increment: 4 },
          version: { increment: 1 },
        },
      });
      expect(idempotencyMock.completeCommand).toHaveBeenCalledWith('cmd-rec-1', result);
    });

    it('should throw ConflictException when requesting more than sellable stock (Oversell Prevention - RT01)', async () => {
      // onHand: 5, reserved: 3, safetyBuffer: 2 -> sellable = 0
      prismaMock.stockBalance.findUnique.mockResolvedValue({
        id: 'sb-1',
        skuId: 'sku-rice-1',
        locationId: 'loc-store-1',
        onHand: 5,
        reserved: 3,
        safetyBuffer: 2,
      });

      await expect(
        service.createReservation({
          locationId: 'loc-store-1',
          idempotencyKey: 'idem-res-oversell',
          lines: [{ skuId: 'sku-rice-1', quantity: 1 }],
        }),
      ).rejects.toThrow(ConflictException);

      expect(idempotencyMock.failCommand).toHaveBeenCalled();
    });
  });

  describe('commitReservation (Pick & Dispatch confirmation)', () => {
    it('should transition status to COMMITTED, decrease onHand and reserved, and create StockLedgerEntry', async () => {
      prismaMock.inventoryReservation.findUnique.mockResolvedValue({
        id: 'res-1',
        reservationNumber: 'RES-12345',
        skuId: 'sku-rice-1',
        locationId: 'loc-store-1',
        quantity: 3,
        status: ReservationStatus.ACTIVE,
      });

      prismaMock.stockBalance.findUnique.mockResolvedValue({
        id: 'sb-1',
        skuId: 'sku-rice-1',
        locationId: 'loc-store-1',
        onHand: 10,
        reserved: 5,
      });

      prismaMock.inventoryReservation.update.mockResolvedValue({
        id: 'res-1',
        status: ReservationStatus.COMMITTED,
      });

      await service.commitReservation('res-1', { idempotencyKey: 'idem-commit-1' });

      // Verify stock balance update: onHand = 10 - 3 = 7, reserved = 5 - 3 = 2
      expect(prismaMock.stockBalance.update).toHaveBeenCalledWith({
        where: { id: 'sb-1' },
        data: {
          onHand: 7,
          reserved: 2,
          version: { increment: 1 },
        },
      });

      // Verify immutable stock ledger entry
      expect(prismaMock.stockLedgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          skuId: 'sku-rice-1',
          locationId: 'loc-store-1',
          sourceType: LedgerSourceType.ORDER_COMMIT,
          quantity: -3,
          balanceAfter: 7,
        }),
      });
    });
  });

  describe('releaseReservation (Order cancellation / expiry - RR22)', () => {
    it('should release reserved quantity if reservation is ACTIVE', async () => {
      prismaMock.inventoryReservation.findUnique.mockResolvedValue({
        id: 'res-1',
        skuId: 'sku-rice-1',
        locationId: 'loc-store-1',
        quantity: 2,
        status: ReservationStatus.ACTIVE,
      });

      prismaMock.stockBalance.findUnique.mockResolvedValue({
        id: 'sb-1',
        reserved: 5,
      });

      prismaMock.inventoryReservation.update.mockResolvedValue({
        id: 'res-1',
        status: ReservationStatus.RELEASED,
      });

      await service.releaseReservation('res-1', { idempotencyKey: 'idem-rel-1' });

      expect(prismaMock.stockBalance.update).toHaveBeenCalledWith({
        where: { id: 'sb-1' },
        data: {
          reserved: { decrement: 2 },
          version: { increment: 1 },
        },
      });
    });

    it('should reject releasing a reservation that has already been COMMITTED (RR22)', async () => {
      prismaMock.inventoryReservation.findUnique.mockResolvedValue({
        id: 'res-1',
        status: ReservationStatus.COMMITTED,
      });

      await expect(
        service.releaseReservation('res-1', { idempotencyKey: 'idem-rel-err' }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
