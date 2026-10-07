import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PackageEventType, PackageStatus, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { assertLocationAccess, AuthenticatedUser } from '../auth/branch-scope';
import { OutboxService } from '../common/services/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import {
  CreateHandoverDto,
  PackOrderDto,
  QueryOrderPreparationDto,
  RecordPreparedItemDto,
} from './dto/fulfillment.dto';

@Injectable()
export class OrderProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly inventory: InventoryService,
  ) {}

  async getPreparationQueue(query: QueryOrderPreparationDto) {
    return this.prisma.order.findMany({
      where: {
        allocatedSourceId: query.locationId,
        status: { in: [OrderStatus.ASSIGNED, OrderStatus.CONFIRMED] },
      },
      include: this.include(),
      orderBy: { createdAt: 'asc' },
    });
  }

  async getOrderDetail(id: string, user?: AuthenticatedUser) {
    const order = await this.getOrder(id);
    if (user?.role === Role.STAFF && order.allocatedSourceId) {
      assertLocationAccess(user, order.allocatedSourceId);
    }
    return order;
  }

  async startPreparation(id: string, user: AuthenticatedUser) {
    const order = await this.getOrder(id);
    this.assertSourceAccess(order.allocatedSourceId, user);
    await this.prisma.orderEvent.create({
      data: { orderId: id, eventType: 'PREPARATION_STARTED', actorUserId: user.id },
    });
    return this.getOrder(id);
  }

  async recordPreparedItem(dto: RecordPreparedItemDto, user: AuthenticatedUser) {
    const order = await this.getOrder(dto.orderId);
    this.assertSourceAccess(order.allocatedSourceId, user);
    const item = order.items.find((line) => line.skuId === dto.skuId);
    if (!item || !item.skuRef) throw new NotFoundException('SKU không thuộc đơn hàng');
    if (item.skuRef.barcode && item.skuRef.barcode !== dto.barcode) {
      throw new BadRequestException('Barcode không khớp SKU');
    }
    if (dto.preparedQty > item.quantity) {
      throw new BadRequestException('Số lượng chuẩn bị vượt số lượng đặt');
    }
    await this.prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: 'ITEM_PREPARED',
        actorUserId: user.id,
        payload: {
          orderItemId: item.id,
          skuId: item.skuId,
          requestedQty: item.quantity,
          preparedQty: dto.preparedQty,
          shortageReason: dto.shortageReason,
        },
      },
    });
    return {
      orderItemId: item.id,
      skuId: item.skuId,
      requestedQty: item.quantity,
      preparedQty: dto.preparedQty,
      status: dto.preparedQty === item.quantity ? 'PREPARED' : 'SHORT',
    };
  }

  async packOrder(dto: PackOrderDto, user: AuthenticatedUser) {
    const order = await this.getOrder(dto.orderId);
    if (!order.allocatedSourceId || !order.selectedPickupPointId) {
      throw new ConflictException('Đơn thiếu nguồn hoặc điểm nhận');
    }
    this.assertSourceAccess(order.allocatedSourceId, user);
    if (order.orderType === 'B2B_TRANSPORT') throw new BadRequestException('Kiện vận tải được quản lý tại màn hình đơn hàng');
    if (!dto.dimensionCm && order.items.some(item => item.lengthCm === null || item.widthCm === null || item.heightCm === null)) throw new BadRequestException('Cần nhập kích thước kiện');
    const dimensions = dto.dimensionCm?.split('x').map(Number) ?? [];
    if (dimensions.length > 0 && (dimensions.length !== 3 || dimensions.some((value) => !Number.isFinite(value) || value <= 0))) {
      throw new BadRequestException('Kích thước phải có dạng dài x rộng x cao và lớn hơn 0');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${order.id}))`;
      const existing = await tx.package.findFirst({
        where: { orderId: order.id, status: { not: PackageStatus.CANCELLED } },
        include: { items: true },
      });
      if (existing) return existing;
      await this.inventory.settleOrderReservationsInTransaction(
        tx,
        order.id,
        order.allocatedSourceId!,
        new Map(order.items.filter((item) => item.skuId).map((item) => [item.skuId!, item.quantity])),
        user.id,
        `package:${order.id}`,
      );
      const pkg = await tx.package.create({
        data: {
          orderId: order.id,
          packageCode: `PKG-${randomUUID().slice(0, 10).toUpperCase()}`,
          lengthMm: dimensions[0]
            ? Math.round(dimensions[0] * 10)
            : Math.max(...order.items.map((item) => requireDimension(item.lengthCm) * 10), 1),
          widthMm: dimensions[1]
            ? Math.round(dimensions[1] * 10)
            : Math.max(...order.items.map((item) => requireDimension(item.widthCm) * 10), 1),
          heightMm: dimensions[2]
            ? Math.round(dimensions[2] * 10)
            : Math.max(...order.items.map((item) => requireDimension(item.heightCm) * 10), 1),
          weightG: BigInt(Math.round((dto.weightKg ?? order.totalWeightKg) * 1000)),
          allowedOrientations: ['DEFAULT'],
          measurementSource: dto.dimensionCm ? 'MANUAL' : 'ORDER_ITEM',
          status: PackageStatus.READY,
          items: {
            create: order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity })),
          },
          events: {
            create: {
              eventType: PackageEventType.PACKED,
              actorUserId: user.id,
              locationId: order.allocatedSourceId,
            },
          },
        },
        include: { items: true },
      });
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: { totalPackages: { increment: 1 }, version: { increment: 1 } },
      });
      await this.outbox.enqueue({
        aggregateType: 'Package',
        aggregateId: pkg.id,
        aggregateVersion: pkg.version,
        eventType: 'PACKAGE_PACKED',
        payload: { packageId: pkg.id, orderId: order.id },
      }, tx);
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          eventType: 'PACKAGE_CREATED',
          actorUserId: user.id,
          payload: { packageId: pkg.id, orderVersion: updatedOrder.version },
        },
      });
      return pkg;
    });
  }

  async createHandover(dto: CreateHandoverDto, user: AuthenticatedUser) {
    if (user.role === Role.STAFF) assertLocationAccess(user, dto.sourceLocationId);
    const packages = await this.prisma.package.findMany({
      where: {
        packageCode: { in: dto.packageCodes },
        order: { allocatedSourceId: dto.sourceLocationId },
      },
    });
    if (packages.length !== new Set(dto.packageCodes).size) {
      throw new BadRequestException('Có kiện không tồn tại hoặc không thuộc nguồn bàn giao');
    }
    const handoverCode = `HO-${randomUUID().slice(0, 8).toUpperCase()}`;
    await this.prisma.$transaction(async (tx) => {
      for (const pkg of packages) {
        await tx.packageEvent.create({
          data: {
            packageId: pkg.id,
            eventType: PackageEventType.HANDED_OVER,
            locationId: dto.sourceLocationId,
            actorUserId: user.id,
            notes: dto.notes,
            metadata: { handoverCode, driverUserId: dto.driverUserId, tripId: dto.tripId },
          },
        });
      }
    });
    return { handoverCode, packageCodes: dto.packageCodes, createdAt: new Date() };
  }

  async getHandovers(sourceLocationId: string) {
    return this.prisma.packageEvent.findMany({
      where: { locationId: sourceLocationId, eventType: PackageEventType.HANDED_OVER },
      include: { package: true, actorUser: { select: { id: true, fullName: true } } },
      orderBy: { occurredAt: 'desc' },
    });
  }

  private include() {
    return {
      customer: true,
      selectedPickupPoint: true,
      allocatedSource: true,
      items: { include: { skuRef: { include: { product: true } } } },
      packages: { include: { items: true, events: true } },
      events: { orderBy: { occurredAt: 'asc' as const } },
    } satisfies Prisma.OrderInclude;
  }

  private async getOrder(id: string) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: this.include() });
    if (!order) throw new NotFoundException('Không tìm thấy đơn chuẩn bị hàng');
    return order;
  }

  private assertSourceAccess(sourceId: string | null, user: AuthenticatedUser) {
    if (!sourceId) throw new ConflictException('Đơn chưa có nguồn hàng');
    if (user.role === Role.STAFF) assertLocationAccess(user, sourceId);
  }
}

function requireDimension(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) throw new BadRequestException("Missing package dimension");
  return value;
}
