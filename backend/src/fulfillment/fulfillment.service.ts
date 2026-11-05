import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FulfillmentGroupStatus,
  OrderStatus,
  OrderType,
  PackageEventType,
  PackageStatus,
  Prisma,
  Role,
  TransportRequestStatus,
} from '@prisma/client';
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
import { PackAndMeasureGroupDto } from './dto/pack-group.dto';

@Injectable()
export class OrderProcessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly inventory: InventoryService,
  ) {}

  // ================= LEGACY SINGLE-SOURCE PREPARATION =================
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
    if (!order.allocatedSourceId) {
      throw new ConflictException('Đơn thiếu nguồn xuất hàng');
    }
    if (!order.selectedPickupPointId && order.orderType === OrderType.RETAIL_PICKUP) {
      throw new ConflictException('Đơn nhận tại điểm thiếu điểm nhận');
    }
    const fgCount = await this.prisma.fulfillmentGroup.count({ where: { orderId: order.id } });
    if (fgCount > 0) {
      throw new ConflictException('Đơn hàng đa nguồn được chuẩn bị và đóng kiện theo từng nhóm cửa hàng qua API /order-processing/groups');
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

  // ================= MULTI-SOURCE FULFILLMENT GROUPS =================
  async getGroupPreparationQueue(locationId: string, user: AuthenticatedUser) {
    if (user.role === Role.STAFF) assertLocationAccess(user, locationId);
    return this.prisma.fulfillmentGroup.findMany({
      where: {
        sourceLocationId: locationId,
        status: { in: [FulfillmentGroupStatus.PENDING, FulfillmentGroupStatus.PREPARING, FulfillmentGroupStatus.PACKED] },
      },
      include: {
        order: {
          include: {
            customer: true,
            stops: true,
          },
        },
        lines: {
          include: {
            sku: true,
          },
        },
        packages: {
          include: {
            items: true,
            measuredByUser: { select: { id: true, fullName: true } },
          },
        },
        sourceLocation: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getGroupDetail(groupId: string, user: AuthenticatedUser) {
    const group = await this.prisma.fulfillmentGroup.findUnique({
      where: { id: groupId },
      include: {
        order: {
          include: {
            customer: true,
            stops: true,
          },
        },
        lines: {
          include: {
            sku: true,
          },
        },
        packages: {
          include: {
            items: true,
            measuredByUser: { select: { id: true, fullName: true } },
          },
        },
        sourceLocation: true,
        transportRequests: {
          include: {
            packages: true,
          },
        },
      },
    });

    if (!group) throw new NotFoundException('Không tìm thấy nhóm chuẩn bị hàng');
    if (user.role === Role.STAFF) assertLocationAccess(user, group.sourceLocationId);
    return group;
  }

  async startGroupPreparation(groupId: string, user: AuthenticatedUser) {
    const group = await this.prisma.fulfillmentGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Không tìm thấy nhóm hàng');
    if (user.role === Role.STAFF) assertLocationAccess(user, group.sourceLocationId);

    const updated = await this.prisma.fulfillmentGroup.update({
      where: { id: groupId },
      data: {
        status: FulfillmentGroupStatus.PREPARING,
        version: { increment: 1 },
      },
    });

    await this.prisma.orderEvent.create({
      data: {
        orderId: group.orderId,
        eventType: 'GROUP_PREPARATION_STARTED',
        actorUserId: user.id,
        payload: { groupId: group.id, groupNumber: group.groupNumber },
      },
    });

    return updated;
  }

  async packAndMeasureGroup(dto: PackAndMeasureGroupDto, user: AuthenticatedUser) {
    const group = await this.prisma.fulfillmentGroup.findUnique({
      where: { id: dto.groupId },
      include: {
        lines: true,
        pickupStop: true,
        order: { include: { stops: true } },
      },
    });

    if (!group) throw new NotFoundException('Không tìm thấy nhóm chuẩn bị hàng');
    if (user.role === Role.STAFF) assertLocationAccess(user, group.sourceLocationId);

    // 1. Kiểm tra bảo toàn số lượng (MN09 & Bất biến 4, 6)
    const lineQtyPackedMap = new Map<string, number>();
    for (const pkg of dto.packages) {
      if (pkg.lengthMm <= 0 || pkg.widthMm <= 0 || pkg.heightMm <= 0 || pkg.weightG <= 0) {
        throw new BadRequestException('Kích thước mm và khối lượng g của kiện hàng phải lớn hơn 0');
      }
      for (const item of pkg.items) {
        const current = lineQtyPackedMap.get(item.fulfillmentLineId) || 0;
        lineQtyPackedMap.set(item.fulfillmentLineId, current + item.quantity);
      }
    }

    for (const line of group.lines) {
      const packedQty = lineQtyPackedMap.get(line.id) || 0;
      if (packedQty !== line.requestedQuantity) {
        throw new BadRequestException(
          `Số lượng đóng gói cho SKU ${line.skuId} không khớp: Phân bổ ${line.requestedQuantity}, đã đóng trong kiện ${packedQty}`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // 2. Tạo các kiện Package thực tế
      const createdPackages: any[] = [];

      for (let i = 0; i < dto.packages.length; i++) {
        const pkgData = dto.packages[i];
        const pkgCode = pkgData.packageCode || `PKG-${group.groupNumber}-${i + 1}`;

        // Map items sang PackageItem gắn với OrderItem
        const packageItemsCreate = pkgData.items.map((item) => {
          const line = group.lines.find((l) => l.id === item.fulfillmentLineId)!;
          return {
            orderItemId: line.orderItemId,
            quantity: item.quantity,
          };
        });

        const createdPkg = await tx.package.create({
          data: {
            packageCode: pkgCode,
            orderId: group.orderId,
            fulfillmentGroupId: group.id,
            lengthMm: pkgData.lengthMm,
            widthMm: pkgData.widthMm,
            heightMm: pkgData.heightMm,
            weightG: BigInt(pkgData.weightG),
            measurementSource: 'PHYSICAL_MEASURED',
            measuredAt: new Date(),
            measuredByUserId: user.id,
            status: PackageStatus.READY,
            allowedOrientations: ['DEFAULT'],
            items: {
              create: packageItemsCreate,
            },
            events: {
              create: {
                eventType: PackageEventType.PACKED,
                actorUserId: user.id,
                locationId: group.sourceLocationId,
              },
            },
          },
          include: { items: true },
        });

        createdPackages.push(createdPkg);
      }

      // 3. Tạo TransportRequest liên kết với các kiện (Mục 8 & 9)
      // Liên kết Group với đúng OrderStop bằng ID ổn định (Fix Issue 3)
      let pickupStopId = group.pickupStopId;
      if (!pickupStopId) {
        const sourceLoc = tx.location?.findUnique
          ? await tx.location.findUnique({ where: { id: group.sourceLocationId } })
          : null;
        const matched = group.order.stops.find(
          (s) =>
            s.type === 'PICKUP' &&
            sourceLoc &&
            (s.contactName === sourceLoc.name ||
              s.address === sourceLoc.address ||
              (Math.abs(s.latitude - sourceLoc.latitude) < 0.001 &&
                Math.abs(s.longitude - sourceLoc.longitude) < 0.001)),
        );
        pickupStopId =
          matched?.id ||
          group.order.stops.find((s) => s.type === 'PICKUP')?.id ||
          null;
      }
      const deliveryStop = group.order.stops.find((s) => s.type === 'DELIVERY');

      const transportRequest = await tx.transportRequest.create({
        data: {
          requestNumber: `TR-${group.groupNumber}`,
          orderId: group.orderId,
          fulfillmentGroupId: group.id,
          sourceLocationId: group.sourceLocationId,
          pickupStopId: pickupStopId || null,
          deliveryStopId: deliveryStop?.id || null,
          status: TransportRequestStatus.READY_FOR_ROUTING,
          packages: {
            create: createdPackages.map((p) => ({
              packageId: p.id,
            })),
          },
        },
      });

      // 4. Cập nhật FulfillmentGroup và các lines
      const updatedGroup = await tx.fulfillmentGroup.update({
        where: { id: group.id },
        data: {
          status: FulfillmentGroupStatus.PACKED,
          packedAt: new Date(),
          readyAt: new Date(),
          version: { increment: 1 },
        },
        include: {
          packages: { include: { items: true } },
          lines: true,
          transportRequests: true,
        },
      });

      for (const line of group.lines) {
        await tx.fulfillmentLine.update({
          where: { id: line.id },
          data: {
            packedQuantity: line.requestedQuantity,
          },
        });
      }

      // 5. Cập nhật Order tổng số kiện
      await tx.order.update({
        where: { id: group.orderId },
        data: {
          totalPackages: { increment: createdPackages.length },
          version: { increment: 1 },
        },
      });

      // 6. Ghi Outbox
      await this.outbox.enqueue(
        {
          aggregateType: 'FulfillmentGroup',
          aggregateId: group.id,
          aggregateVersion: updatedGroup.version,
          eventType: 'GROUP_PACKED_AND_MEASURED',
          payload: {
            groupId: group.id,
            orderId: group.orderId,
            transportRequestId: transportRequest.id,
            packageCount: createdPackages.length,
          },
        },
        tx,
      );

      return updatedGroup;
    });
  }

  // ================= HANDOVER =================
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
