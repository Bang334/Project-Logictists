import { Test, TestingModule } from '@nestjs/testing';
import { SalesOrdersService } from '../../src/sales-orders/sales-orders.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OutboxService } from '../../src/common/services/outbox.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { ShoppingService, QuoteResult } from '../../src/shopping/shopping.service';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';

describe('SalesOrdersService - Multi-source Checkout (P3)', () => {
  let service: SalesOrdersService;
  let prisma: any;
  let shoppingService: any;
  let outbox: any;

  const mockUser = {
    id: 'user-cus-1',
    role: Role.CUSTOMER,
    branchId: 'branch-hn',
    locationId: undefined,
  };

  const mockQuote: QuoteResult = {
    quoteId: 'QTE-12345',
    quoteVersion: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    provinceCode: 'HN',
    deliveryAddress: '123 Đường Láng, Đống Đa, Hà Nội',
    deliveryLatitude: 21.015,
    deliveryLongitude: 105.81,
    items: [
      {
        skuId: 'sku-cement',
        skuCode: 'XM-01',
        name: 'Xi măng',
        quantity: 10,
        unitPrice: 100000,
        lineTotal: 1000000,
        sourceAllocations: [
          { locationId: 'store-a', locationName: 'Store A', quantity: 6 },
          { locationId: 'store-b', locationName: 'Store B', quantity: 4 },
        ],
      },
    ],
    subtotal: 1000000,
    shippingFee: 0,
    shippingFeeStatus: 'ESTIMATED_PENDING_MEASUREMENT',
    totalAmount: 1000000,
    sourceStores: [
      { id: 'store-a', name: 'Store A', address: 'Đống Đa', distanceToDeliveryKm: 5 },
      { id: 'store-b', name: 'Store B', address: 'Cầu Giấy', distanceToDeliveryKm: 8 },
    ],
    maxDistanceBetweenSourcesKm: 40,
    conditionsToAccept: ['Chấp nhận đo thực tế'],
  };

  beforeEach(async () => {
    prisma = {
      processedCommand: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'cmd-1' }),
      },
      customer: {
        upsert: jest.fn().mockResolvedValue({ id: 'cus-1', name: 'Nguyễn Văn A' }),
      },
      customerAddress: {
        create: jest.fn().mockResolvedValue({ id: 'addr-1' }),
      },
      location: {
        findUnique: jest.fn((args) => {
          if (args.where.id === 'store-a') {
            return Promise.resolve({
              id: 'store-a',
              code: 'ST-A',
              name: 'Store A',
              address: 'Đống Đa',
              latitude: 21.01,
              longitude: 105.82,
              managingBranchId: 'branch-hn',
            });
          }
          if (args.where.id === 'store-b') {
            return Promise.resolve({
              id: 'store-b',
              code: 'ST-B',
              name: 'Store B',
              address: 'Cầu Giấy',
              latitude: 21.03,
              longitude: 105.78,
              managingBranchId: 'branch-hn',
            });
          }
          return Promise.resolve(null);
        }),
      },
      order: {
        create: jest.fn().mockImplementation((args) => {
          return Promise.resolve({
            id: 'ord-123',
            orderNumber: args.data.orderNumber,
            version: 1,
            items: [{ id: 'order-item-1', skuId: 'sku-cement' }],
          });
        }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord-123',
          orderNumber: 'SO-TEST-001',
          orderType: 'RETAIL_DELIVERY',
          customer: { userId: mockUser.id },
          items: [],
          fulfillmentGroups: [
            { id: 'fg-1', sourceLocationId: 'store-a', lines: [] },
            { id: 'fg-2', sourceLocationId: 'store-b', lines: [] },
          ],
        }),
      },
      orderStop: {
        create: jest.fn().mockResolvedValue({ id: 'stop-1' }),
      },
      fulfillmentGroup: {
        create: jest.fn().mockImplementation((args) => ({ id: `fg-${args.data.sourceLocationId}`, ...args.data })),
      },
      fulfillmentLine: {
        create: jest.fn().mockImplementation((args) => ({ id: 'fline-1', ...args.data })),
      },
      inventoryReservation: {
        create: jest.fn().mockResolvedValue({ id: 'res-1' }),
      },
      stockBalance: {
        findUnique: jest.fn((args) => {
          // Cả 2 store đều đủ tồn kho theo allocation
          return Promise.resolve({
            id: `bal-${args.where.skuId_locationId.locationId}`,
            onHand: 20,
            reserved: 0,
            safetyBuffer: 0,
          });
        }),
        update: jest.fn().mockResolvedValue({ id: 'bal-1' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'bal-1' }]),
      $transaction: jest.fn((cb) => cb(prisma)),
    };

    shoppingService = {
      getQuoteById: jest.fn().mockReturnValue(mockQuote),
    };

    outbox = {
      enqueue: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SalesOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ShoppingService, useValue: shoppingService },
        { provide: OutboxService, useValue: outbox },
        { provide: InventoryService, useValue: {} },
      ],
    }).compile();

    service = module.get<SalesOrdersService>(SalesOrdersService);
  });

  describe('MN04: Multi-source Order creation & Reservation', () => {
    it('tạo 1 Order, 2 FulfillmentGroup, giữ hàng atomic tại 2 nguồn và không auto READY package', async () => {
      const order = await service.checkoutMultiSourceOrder(
        {
          quoteId: 'QTE-12345',
          customerName: 'Nguyễn Văn A',
          customerPhone: '0987654321',
          idempotencyKey: 'idem-1',
          acceptedConditions: true,
        },
        mockUser as any,
      );

      expect(order).toBeDefined();
      expect(order.id).toBe('ord-123');

      // Kiểm tra Order được tạo
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      const orderCreateCall = prisma.order.create.mock.calls[0][0];
      expect(orderCreateCall.data.maxSourcesAllowed).toBe(2);
      expect(orderCreateCall.data.subtotal.toNumber()).toBe(1000000);

      // Kiểm tra 2 FulfillmentGroup được tạo (1 cho Store A, 1 cho Store B)
      expect(prisma.fulfillmentGroup.create).toHaveBeenCalledTimes(2);

      // Kiểm tra 2 điểm PICKUP và 1 điểm DELIVERY được tạo
      expect(prisma.orderStop.create).toHaveBeenCalledTimes(3);

      // Kiểm tra 2 reservation được tạo cho 2 nguồn
      expect(prisma.inventoryReservation.create).toHaveBeenCalledTimes(2);
      expect(prisma.stockBalance.update).toHaveBeenCalledTimes(2);

      // Không tự sinh Package READY tại checkout
      expect(prisma['package']?.create).toBeUndefined();
    });

    it('từ chối khi khách hàng chưa chấp thuận điều kiện (POL-M03/M06)', async () => {
      await expect(
        service.checkoutMultiSourceOrder(
          {
            quoteId: 'QTE-12345',
            customerName: 'Nguyễn Văn A',
            customerPhone: '0987654321',
            idempotencyKey: 'idem-1',
            acceptedConditions: false,
          },
          mockUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('MN06: Idempotency & Collision handling', () => {
    it('cùng idempotency key khác payload -> ném ConflictException (409)', async () => {
      prisma.processedCommand.findUnique.mockResolvedValue({
        id: 'cmd-old',
        requestHash: 'different-hash-123',
        result: { orderId: 'ord-123' },
      });

      await expect(
        service.checkoutMultiSourceOrder(
          {
            quoteId: 'QTE-12345',
            customerName: 'Nguyễn Văn A',
            customerPhone: '0987654321',
            idempotencyKey: 'idem-1',
            acceptedConditions: true,
          },
          mockUser as any,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('MN07: Rollback when one source runs out of stock', () => {
    it('Store B hết hàng giữa chừng -> ném ConflictException và không tạo đơn', async () => {
      // Store A đủ tồn, nhưng Store B không đủ tồn
      prisma.stockBalance.findUnique.mockImplementation((args: any) => {
        if (args.where.skuId_locationId.locationId === 'store-b') {
          return Promise.resolve({
            id: 'bal-store-b',
            onHand: 1, // Khách cần 4
            reserved: 0,
            safetyBuffer: 0,
          });
        }
        return Promise.resolve({
          id: 'bal-store-a',
          onHand: 20,
          reserved: 0,
          safetyBuffer: 0,
        });
      });

      await expect(
        service.checkoutMultiSourceOrder(
          {
            quoteId: 'QTE-12345',
            customerName: 'Nguyễn Văn A',
            customerPhone: '0987654321',
            idempotencyKey: 'idem-1',
            acceptedConditions: true,
          },
          mockUser as any,
        ),
      ).rejects.toThrow(ConflictException);

      // Order không được tạo vì transaction bị rollback
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('MN08: Quote Expiry handling', () => {
    it('quote quá hạn 15 phút -> ném BadRequestException bắt tạo lại', async () => {
      shoppingService.getQuoteById.mockReturnValue({
        ...mockQuote,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // Đã hết hạn
      });

      await expect(
        service.checkoutMultiSourceOrder(
          {
            quoteId: 'QTE-12345',
            customerName: 'Nguyễn Văn A',
            customerPhone: '0987654321',
            idempotencyKey: 'idem-1',
            acceptedConditions: true,
          },
          mockUser as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

