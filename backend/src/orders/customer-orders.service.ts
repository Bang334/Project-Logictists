import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, Prisma, StopType } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueryCustomerOrdersDto } from './dto/query-customer-orders.dto';
import { CreateCustomerOrderDto } from './dto/create-customer-order.dto';

const CREATE_CUSTOMER_ORDER_COMMAND = 'CREATE_CUSTOMER_ORDER';
const ORDER_COMMAND_LOCK_NAMESPACE = 22_021;
const ORDER_NUMBER_LOCK_NAMESPACE = 22_022;

const CUSTOMER_STOP_SELECT = {
  id: true,
  type: true,
  sequence: true,
  address: true,
  latitude: true,
  longitude: true,
  contactName: true,
  contactPhone: true,
  serviceDurationMinutes: true,
} as const;

const CUSTOMER_ORDER_SUMMARY_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  version: true,
  notes: true,
  totalPackages: true,
  totalWeightKg: true,
  totalVolumeM3: true,
  orderedAt: true,
  createdAt: true,
  updatedAt: true,
  stops: {
    select: CUSTOMER_STOP_SELECT,
    orderBy: { sequence: Prisma.SortOrder.asc },
  },
} as const;

const CUSTOMER_ORDER_DETAIL_SELECT = {
  ...CUSTOMER_ORDER_SUMMARY_SELECT,
  items: {
    select: {
      id: true,
      description: true,
      packageType: true,
      quantity: true,
      weightKg: true,
      lengthCm: true,
      widthCm: true,
      heightCm: true,
      volumeM3: true,
    },
    orderBy: { createdAt: Prisma.SortOrder.asc },
  },
} as const;

const CREATED_CUSTOMER_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  version: true,
  totalPackages: true,
  totalWeightKg: true,
  totalVolumeM3: true,
  createdAt: true,
  orderedAt: true,
  branch: { select: { id: true, code: true, name: true } },
} as const;

type CustomerOrderDetailRecord = Prisma.OrderGetPayload<{
  select: typeof CUSTOMER_ORDER_DETAIL_SELECT;
}>;

@Injectable()
export class CustomerOrdersService {
  constructor(private readonly prisma: PrismaService) {}

  findActiveBranches() {
    return this.prisma.branch.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
  }

  async createForUser(userId: string, dto: CreateCustomerOrderDto) {
    const calculatedItems = dto.items.map((item) => {
      const lineWeightKg = item.unitWeightKg * item.quantity;
      const lineVolumeM3 =
        (item.lengthCm * item.widthCm * item.heightCm * item.quantity) /
        1_000_000;
      this.assertFinitePositiveTotal(lineWeightKg, 'khối lượng dòng hàng');
      this.assertFinitePositiveTotal(lineVolumeM3, 'thể tích dòng hàng');
      return { ...item, lineWeightKg, lineVolumeM3 };
    });
    const totals = calculatedItems.reduce(
      (sum, item) => ({
        totalPackages: sum.totalPackages + item.quantity,
        totalWeightKg: sum.totalWeightKg + item.lineWeightKg,
        totalVolumeM3: sum.totalVolumeM3 + item.lineVolumeM3,
      }),
      { totalPackages: 0, totalWeightKg: 0, totalVolumeM3: 0 },
    );
    this.assertFinitePositiveTotal(totals.totalWeightKg, 'tổng khối lượng');
    this.assertFinitePositiveTotal(totals.totalVolumeM3, 'tổng thể tích');
    if (!Number.isSafeInteger(totals.totalPackages)) {
      throw new BadRequestException('Tổng số kiện vượt giới hạn số nguyên an toàn');
    }

    const canonicalPayload = {
      branchId: dto.branchId,
      pickup: dto.pickup,
      delivery: dto.delivery,
      items: calculatedItems.map((item) => ({
        description: item.description,
        packageType: item.packageType || 'CARTON',
        quantity: item.quantity,
        unitWeightKg: item.unitWeightKg,
        lengthCm: item.lengthCm,
        widthCm: item.widthCm,
        heightCm: item.heightCm,
      })),
      notes: dto.notes ?? null,
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify(canonicalPayload))
      .digest('hex');

    const orderId = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_COMMAND_LOCK_NAMESPACE}::int4, hashtext(${`${userId}:${CREATE_CUSTOMER_ORDER_COMMAND}:${dto.idempotencyKey}`})::int4)`;

      const existingCommand = await tx.processedCommand.findUnique({
        where: {
          actorUserId_commandType_idempotencyKey: {
            actorUserId: userId,
            commandType: CREATE_CUSTOMER_ORDER_COMMAND,
            idempotencyKey: dto.idempotencyKey,
          },
        },
      });
      if (existingCommand) {
        if (existingCommand.requestHash !== requestHash) {
          throw new ConflictException(
            'Idempotency key đã được dùng với nội dung tạo đơn khác',
          );
        }
        const result = existingCommand.result as { orderId?: unknown } | null;
        if (
          existingCommand.status === 'COMPLETED' &&
          typeof result?.orderId === 'string'
        ) {
          return result.orderId;
        }
        throw new ConflictException('Lệnh tạo đơn trước đang được xử lý');
      }

      const [customer, branch] = await Promise.all([
        tx.customer.findUnique({
          where: { userId },
          select: { id: true },
        }),
        tx.branch.findFirst({
          where: { id: dto.branchId, active: true },
          select: { id: true },
        }),
      ]);
      if (!customer) {
        throw new ConflictException({
          errorCode: 'CUSTOMER_PROFILE_NOT_FOUND',
          message:
            'Tài khoản CUSTOMER chưa được liên kết với hồ sơ khách hàng',
        });
      }
      if (!branch) {
        throw new BadRequestException({
          errorCode: 'CUSTOMER_BRANCH_NOT_AVAILABLE',
          message: 'Chi nhánh không tồn tại hoặc không còn hoạt động',
        });
      }

      const orderNumber = await this.allocateCustomerOrderNumber(tx);
      const order = await tx.order.create({
        data: {
          orderNumber,
          customerId: customer.id,
          branchId: branch.id,
          status: OrderStatus.DRAFT,
          totalAmount: 0,
          totalPackages: totals.totalPackages,
          totalWeightKg: totals.totalWeightKg,
          totalVolumeM3: totals.totalVolumeM3,
          notes: dto.notes,
          stops: {
            create: [
              {
                ...dto.pickup,
                type: StopType.PICKUP,
                sequence: 1,
              },
              {
                ...dto.delivery,
                type: StopType.DELIVERY,
                sequence: 2,
              },
            ],
          },
          items: {
            create: calculatedItems.map((item) => ({
              description: item.description,
              packageType: item.packageType || 'CARTON',
              quantity: item.quantity,
              weightKg: item.lineWeightKg,
              lengthCm: item.lengthCm,
              widthCm: item.widthCm,
              heightCm: item.heightCm,
              volumeM3: item.lineVolumeM3,
            })),
          },
        },
        select: { id: true },
      });
      const command = await tx.processedCommand.create({
        data: {
          actorUserId: userId,
          commandType: CREATE_CUSTOMER_ORDER_COMMAND,
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          status: 'COMPLETED',
          result: { orderId: order.id },
        },
        select: { id: true },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: 'ORDER_CREATED',
          toStatus: OrderStatus.DRAFT,
          actorUserId: userId,
          commandId: command.id,
          payload: { source: 'CUSTOMER_APP', branchId: branch.id },
        },
      });
      return order.id;
    });

    const created = await this.prisma.order.findFirst({
      where: { id: orderId, customer: { userId } },
      select: CREATED_CUSTOMER_ORDER_SELECT,
    });
    if (!created) {
      throw new ConflictException('Không thể đọc lại đơn vừa tạo');
    }
    return created;
  }

  async findAllForUser(userId: string, query: QueryCustomerOrdersDto) {
    const customerId = await this.resolveCustomerId(userId);
    const where: Prisma.OrderWhereInput = {
      customerId,
      ...(query.status ? { status: query.status } : {}),
    };
    const skip = (query.page - 1) * query.limit;

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        select: CUSTOMER_ORDER_SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: orders,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
    };
  }

  async findOneForUser(userId: string, orderId: string) {
    const customerId = await this.resolveCustomerId(userId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: CUSTOMER_ORDER_DETAIL_SELECT,
    });

    if (!order) {
      throw new NotFoundException('Không tìm thấy đơn vận chuyển');
    }

    return this.toCustomerOrderDetail(order);
  }

  private async resolveCustomerId(userId: string): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!customer) {
      throw new ConflictException({
        errorCode: 'CUSTOMER_PROFILE_NOT_FOUND',
        message: 'Tài khoản CUSTOMER chưa được liên kết với hồ sơ khách hàng',
      });
    }
    return customer.id;
  }

  private assertFinitePositiveTotal(value: number, label: string) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException(`${label} không hợp lệ hoặc vượt giới hạn`);
    }
  }

  private async allocateCustomerOrderNumber(tx: Prisma.TransactionClient) {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ORDER_NUMBER_LOCK_NAMESPACE}::int4, hashtext(${dateStr})::int4)`;
    const prefix = `ORD-CUS-${dateStr}-`;
    const rows = await tx.$queryRaw<Array<{ maxSequence: number | null }>>`
      SELECT MAX(CAST(split_part("orderNumber", '-', 4) AS integer)) AS "maxSequence"
      FROM "orders"
      WHERE "orderNumber" LIKE ${`${prefix}%`}
    `;
    const nextSequence = (rows[0]?.maxSequence ?? 0) + 1;
    return `${prefix}${String(nextSequence).padStart(4, '0')}`;
  }

  private toCustomerOrderDetail(order: CustomerOrderDetailRecord) {
    return {
      ...order,
      items: order.items.map((item) => ({
        id: item.id,
        description: item.description,
        packageType: item.packageType,
        quantity: item.quantity,
        lineWeightKg: item.weightKg,
        unitWeightKg:
          item.quantity > 0 ? item.weightKg / item.quantity : null,
        lengthCm: item.lengthCm,
        widthCm: item.widthCm,
        heightCm: item.heightCm,
        lineVolumeM3: item.volumeM3,
        unitVolumeM3:
          item.quantity > 0 ? item.volumeM3 / item.quantity : null,
      })),
    };
  }
}
