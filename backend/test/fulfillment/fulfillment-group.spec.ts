import { Test, TestingModule } from '@nestjs/testing';
import { OrderProcessingService } from '../../src/fulfillment/fulfillment.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OutboxService } from '../../src/common/services/outbox.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FulfillmentGroupStatus, Role, TransportRequestStatus } from '@prisma/client';

describe('OrderProcessingService - Group Preparation & Physical Measurement (P4)', () => {
  let service: OrderProcessingService;
  let prisma: any;
  let outbox: any;

  const staffStoreA = {
    id: 'user-staff-a',
    role: Role.STAFF,
    branchId: 'branch-hn',
    locationId: 'store-a',
  };

  const staffStoreB = {
    id: 'user-staff-b',
    role: Role.STAFF,
    branchId: 'branch-hn',
    locationId: 'store-b',
  };

  const mockGroup = {
    id: 'group-1',
    groupNumber: 'FG-SO01-A',
    orderId: 'ord-1',
    sourceLocationId: 'store-a',
    status: FulfillmentGroupStatus.PENDING,
    version: 1,
    lines: [
      {
        id: 'line-cement',
        fulfillmentGroupId: 'group-1',
        orderItemId: 'item-cement',
        skuId: 'sku-cement',
        requestedQuantity: 5,
        reservedQuantity: 5,
        packedQuantity: 0,
      },
    ],
    order: {
      id: 'ord-1',
      orderNumber: 'SO01',
      stops: [
        { id: 'stop-pickup-a', type: 'PICKUP', latitude: 21.01, longitude: 105.82 },
        { id: 'stop-delivery', type: 'DELIVERY', latitude: 21.05, longitude: 105.85 },
      ],
    },
  };

  beforeEach(async () => {
    prisma = {
      fulfillmentGroup: {
        findMany: jest.fn().mockResolvedValue([mockGroup]),
        findUnique: jest.fn((args) => {
          if (args.where.id === 'group-1') return Promise.resolve(mockGroup);
          return Promise.resolve(null);
        }),
        update: jest.fn().mockImplementation((args) => Promise.resolve({ ...mockGroup, ...args.data })),
      },
      fulfillmentLine: {
        update: jest.fn().mockResolvedValue({ id: 'line-cement' }),
      },
      package: {
        create: jest.fn().mockImplementation((args) => Promise.resolve({ id: 'pkg-1', ...args.data })),
      },
      transportRequest: {
        create: jest.fn().mockImplementation((args) =>
          Promise.resolve({
            id: 'tr-1',
            ...args.data,
            status: TransportRequestStatus.READY_FOR_ROUTING,
          }),
        ),
      },
      order: {
        update: jest.fn().mockResolvedValue({ id: 'ord-1' }),
      },
      orderEvent: {
        create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      },
      $transaction: jest.fn((cb) => cb(prisma)),
    };

    outbox = {
      enqueue: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderProcessingService,
        { provide: PrismaService, useValue: prisma },
        { provide: OutboxService, useValue: outbox },
        { provide: InventoryService, useValue: {} },
      ],
    }).compile();

    service = module.get<OrderProcessingService>(OrderProcessingService);
  });

  describe('MN18: Permission boundaries per Store', () => {
    it('nhân viên Store B không được truy cập nhóm hàng của Store A', async () => {
      await expect(
        service.getGroupDetail('group-1', staffStoreB as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('nhân viên Store A được truy cập và bắt đầu chuẩn bị nhóm hàng của Store A', async () => {
      const group = await service.startGroupPreparation('group-1', staffStoreA as any);
      expect(group.status).toBe(FulfillmentGroupStatus.PREPARING);
      expect(prisma.orderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'GROUP_PREPARATION_STARTED',
          actorUserId: staffStoreA.id,
        }),
      });
    });
  });

  describe('MN09 & MN10: Package physical measurement & Quantity preservation', () => {
    it('đóng gói và đo kích thước thành công khi số lượng khớp chính xác và tạo TransportRequest READY_FOR_ROUTING', async () => {
      const result = await service.packAndMeasureGroup(
        {
          groupId: 'group-1',
          packages: [
            {
              lengthMm: 600,
              widthMm: 400,
              heightMm: 300,
              weightG: 50000,
              items: [
                {
                  fulfillmentLineId: 'line-cement',
                  quantity: 5, // Khớp đúng 5 bao
                },
              ],
            },
          ],
        },
        staffStoreA as any,
      );

      expect(result.status).toBe(FulfillmentGroupStatus.PACKED);

      // Kiểm tra Package được tạo với số đo thực tế và người đo
      expect(prisma.package.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          lengthMm: 600,
          widthMm: 400,
          heightMm: 300,
          weightG: 50000n,
          measurementSource: 'PHYSICAL_MEASURED',
          measuredByUserId: staffStoreA.id,
        }),
        include: { items: true },
      });

      // Kiểm tra TransportRequest được tạo ở trạng thái READY_FOR_ROUTING
      expect(prisma.transportRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          requestNumber: 'TR-FG-SO01-A',
          status: TransportRequestStatus.READY_FOR_ROUTING,
        }),
      });

      // Outbox event được phát
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    });

    it('từ chối khi số lượng đóng gói không khớp (thừa hoặc thiếu hàng)', async () => {
      await expect(
        service.packAndMeasureGroup(
          {
            groupId: 'group-1',
            packages: [
              {
                lengthMm: 600,
                widthMm: 400,
                heightMm: 300,
                weightG: 40000,
                items: [
                  {
                    fulfillmentLineId: 'line-cement',
                    quantity: 4, // Thiếu 1 bao (phân bổ là 5)
                  },
                ],
              },
            ],
          },
          staffStoreA as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('từ chối khi kích thước hoặc trọng lượng kiện không hợp lệ (<= 0)', async () => {
      await expect(
        service.packAndMeasureGroup(
          {
            groupId: 'group-1',
            packages: [
              {
                lengthMm: 0, // Không hợp lệ
                widthMm: 400,
                heightMm: 300,
                weightG: 50000,
                items: [{ fulfillmentLineId: 'line-cement', quantity: 5 }],
              },
            ],
          },
          staffStoreA as any,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

