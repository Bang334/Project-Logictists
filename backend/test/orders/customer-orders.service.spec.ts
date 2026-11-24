import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { OrderStatus, StopType } from "@prisma/client";
import { CustomerOrdersService } from "../../src/orders/customer-orders.service";
import { PrismaService } from "../../src/prisma/prisma.service";

describe("CustomerOrdersService", () => {
  const prisma = {
    customer: { findUnique: jest.fn() },
    order: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn((operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };
  const service = new CustomerOrdersService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (operations: Array<Promise<unknown>>) => Promise.all(operations),
    );
  });

  it("lọc list bằng customerId lấy từ user relation và phân trang ổn định", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "customer-a" });
    prisma.order.findMany.mockResolvedValue([
      {
        id: "order-a",
        orderNumber: "ORD-A",
        status: OrderStatus.DRAFT,
        version: 1,
        notes: null,
        totalPackages: 2,
        totalWeightKg: 20,
        totalVolumeM3: 0.1,
        orderedAt: new Date("2026-11-15T01:00:00.000Z"),
        createdAt: new Date("2026-11-15T01:00:00.000Z"),
        updatedAt: new Date("2026-11-15T01:00:00.000Z"),
        stops: [],
      },
    ]);
    prisma.order.count.mockResolvedValue(3);

    const result = await service.findAllForUser("user-a", {
      status: OrderStatus.DRAFT,
      page: 2,
      limit: 1,
    });

    expect(prisma.customer.findUnique).toHaveBeenCalledWith({
      where: { userId: "user-a" },
      select: { id: true },
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: "customer-a", status: OrderStatus.DRAFT },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: 1,
        take: 1,
      }),
    );
    expect(result).toMatchObject({
      page: 2,
      limit: 1,
      total: 3,
      totalPages: 3,
    });
    expect(JSON.stringify(result)).not.toContain("totalAmount");
  });

  it("trả detail đã chuyển đổi khối lượng/thể tích mỗi kiện và stops theo sequence", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "customer-a" });
    prisma.order.findFirst.mockResolvedValue({
      id: "order-a",
      orderNumber: "ORD-A",
      status: OrderStatus.DRAFT,
      version: 1,
      notes: "Hàng dễ vỡ",
      totalPackages: 4,
      totalWeightKg: 50,
      totalVolumeM3: 0.12,
      orderedAt: new Date("2026-11-15T01:00:00.000Z"),
      createdAt: new Date("2026-11-15T01:00:00.000Z"),
      updatedAt: new Date("2026-11-15T01:00:00.000Z"),
      stops: [
        {
          id: "pickup",
          type: StopType.PICKUP,
          sequence: 1,
          address: "Kho A",
          latitude: 10,
          longitude: 106,
          contactName: "A",
          contactPhone: "0900000001",
          serviceDurationMinutes: 15,
        },
        {
          id: "delivery",
          type: StopType.DELIVERY,
          sequence: 2,
          address: "Kho B",
          latitude: 11,
          longitude: 107,
          contactName: "B",
          contactPhone: "0900000002",
          serviceDurationMinutes: 15,
        },
      ],
      items: [
        {
          id: "item-a",
          description: "Thùng A",
          packageType: "CARTON",
          quantity: 4,
          weightKg: 50,
          lengthCm: 40,
          widthCm: 30,
          heightCm: 25,
          volumeM3: 0.12,
        },
      ],
    });

    const result = await service.findOneForUser("user-a", "order-a");

    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "order-a", customerId: "customer-a" },
      }),
    );
    expect(result.stops.map((stop) => stop.sequence)).toEqual([1, 2]);
    expect(result.items[0]).toMatchObject({
      quantity: 4,
      lineWeightKg: 50,
      unitWeightKg: 12.5,
      lineVolumeM3: 0.12,
      unitVolumeM3: 0.03,
    });
    expect(JSON.stringify(result)).not.toContain("totalAmount");
    expect(JSON.stringify(result)).not.toContain("customerId");
    expect(JSON.stringify(result)).not.toContain("branchId");
  });

  it("trả 404 khi Order không thuộc Customer hiện tại", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "customer-a" });
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(
      service.findOneForUser("user-a", "order-b"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("trả convention CUSTOMER_PROFILE_NOT_FOUND khi thiếu relation", async () => {
    prisma.customer.findUnique.mockResolvedValue(null);

    try {
      await service.findAllForUser("user-without-customer", {
        page: 1,
        limit: 20,
      });
      throw new Error("Expected service to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        errorCode: "CUSTOMER_PROFILE_NOT_FOUND",
      });
    }
  });
});

describe("CustomerOrdersService create", () => {
  const currentUtcDate = new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
  const expectedOrderNumber = `ORD-CUS-${currentUtcDate}-0008`;
  const tx = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    processedCommand: { findUnique: jest.fn(), create: jest.fn() },
    customer: { findUnique: jest.fn() },
    branch: { findFirst: jest.fn() },
    order: { create: jest.fn() },
    orderEvent: { create: jest.fn() },
  };
  const prisma = {
    branch: { findMany: jest.fn() },
    order: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new CustomerOrdersService(prisma as unknown as PrismaService);
  const dto = {
    idempotencyKey: "f62193bb-2106-4e56-b6cf-59d9f918d940",
    branchId: "7a227ab5-b170-4681-9628-a72bb813c1ac",
    pickup: {
      address: "Kho A",
      latitude: 10,
      longitude: 106,
      contactName: "Người gửi",
      contactPhone: "0900000001",
    },
    delivery: {
      address: "Kho B",
      latitude: 11,
      longitude: 107,
      contactName: "Người nhận",
      contactPhone: "0900000002",
    },
    items: [
      {
        description: "Pallet",
        quantity: 2,
        unitWeightKg: 780,
        lengthCm: 220,
        widthCm: 120,
        heightCm: 110,
      },
    ],
    notes: "DRAFT để nhân viên kiểm tra",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    tx.processedCommand.findUnique.mockResolvedValue(null);
    tx.customer.findUnique.mockResolvedValue({ id: "customer-a" });
    tx.branch.findFirst.mockResolvedValue({ id: dto.branchId });
    tx.$queryRaw.mockResolvedValue([{ maxSequence: 7 }]);
    tx.order.create.mockResolvedValue({ id: "order-a" });
    tx.processedCommand.create.mockResolvedValue({ id: "command-a" });
    prisma.order.findFirst.mockResolvedValue({
      id: "order-a",
      orderNumber: expectedOrderNumber,
      status: OrderStatus.DRAFT,
      version: 1,
      totalPackages: 2,
      totalWeightKg: 1560,
      totalVolumeM3: 5.808,
      branch: { id: dto.branchId, code: "DAD", name: "Đà Nẵng" },
    });
  });

  it("tạo DRAFT và tự tính line/tổng thay vì nhận từ client", async () => {
    const result = await service.createForUser("user-a", dto);

    expect(tx.branch.findFirst).toHaveBeenCalledWith({
      where: { id: dto.branchId, active: true },
      select: { id: true },
    });
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderNumber: expectedOrderNumber,
          customerId: "customer-a",
          branchId: dto.branchId,
          status: OrderStatus.DRAFT,
          totalAmount: 0,
          totalPackages: 2,
          totalWeightKg: 1560,
          totalVolumeM3: 5.808,
          stops: {
            create: [
              expect.objectContaining({ type: StopType.PICKUP, sequence: 1 }),
              expect.objectContaining({ type: StopType.DELIVERY, sequence: 2 }),
            ],
          },
          items: {
            create: [
              expect.objectContaining({
                weightKg: 1560,
                volumeM3: 5.808,
              }),
            ],
          },
        }),
      }),
    );
    expect(tx.orderEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-a",
        eventType: "ORDER_CREATED",
        toStatus: OrderStatus.DRAFT,
        actorUserId: "user-a",
        commandId: "command-a",
      }),
    });
    expect(result).toMatchObject({ id: "order-a", status: OrderStatus.DRAFT });
  });

  it("chỉ liệt kê Branch active bằng allowlist", async () => {
    prisma.branch.findMany.mockResolvedValue([]);
    await service.findActiveBranches();
    expect(prisma.branch.findMany).toHaveBeenCalledWith({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: "asc" }, { id: "asc" }],
    });
  });

  it("từ chối Branch không tồn tại hoặc inactive trong transaction", async () => {
    tx.branch.findFirst.mockResolvedValue(null);
    await expect(service.createForUser("user-a", dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it("chặn tổng không hữu hạn ngay cả khi service bị gọi bỏ qua DTO pipe", async () => {
    const invalid = {
      ...dto,
      items: [{ ...dto.items[0], unitWeightKg: Number.POSITIVE_INFINITY }],
    };
    await expect(
      service.createForUser("user-a", invalid),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
