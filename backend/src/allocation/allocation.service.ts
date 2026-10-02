import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LocationType, OrderStatus, Role } from '@prisma/client';
import { assertLocationAccess, AuthenticatedUser } from '../auth/branch-scope';
import { IdempotencyService } from '../common/services/idempotency.service';
import { OutboxService } from '../common/services/outbox.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { AllocateOrderDto } from './dto/allocate-order.dto';
import { QueryPickupPointsDto } from './dto/query-pickup-points.dto';

type AllocationActor = AuthenticatedUser | string | undefined;

@Injectable()
export class AllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotencyService: IdempotencyService,
    private readonly outboxService: OutboxService,
    private readonly inventoryService: InventoryService,
  ) {}

  calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
    const toRad = (value: number) => value * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async findValidPickupPoints(query: QueryPickupPointsDto) {
    const points = await this.prisma.location.findMany({
      where: { type: LocationType.PICKUP_POINT, active: true, availableHoldingSlots: { gt: 0 } },
    });
    return points
      .map((point) => ({
        ...point,
        pickupCapacity: {
          totalSlots: point.totalHoldingSlots,
          availableSlots: point.availableHoldingSlots,
        },
        distanceKm: query.latitude !== undefined && query.longitude !== undefined
          ? this.calculateHaversineDistance(query.latitude, query.longitude, point.latitude, point.longitude)
          : null,
      }))
      .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
  }

  async allocateSourceForOrder(dto: AllocateOrderDto, actor?: AllocationActor) {
    const user = typeof actor === 'object' ? actor : undefined;
    const actorId = typeof actor === 'string' ? actor : actor?.id;
    if (!actorId) throw new BadRequestException('Thiếu người thực hiện');

    const idempotency = await this.idempotencyService.checkOrStartCommand(
      actorId,
      'ORDER_SOURCE_ALLOCATION',
      dto.idempotencyKey,
      dto,
    );
    if (idempotency.isProcessed) return idempotency.result;

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: dto.salesOrderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
      if (
        order.status === OrderStatus.CANCELLED
        || order.status === OrderStatus.COMPLETED
        || order.status === OrderStatus.IN_TRANSIT
      ) {
        throw new ConflictException('Đơn không còn cho phép chọn nguồn');
      }
      if (order.items.some((item) => !item.skuId)) {
        throw new BadRequestException('Chỉ đơn bán hàng có SKU mới được chọn nguồn tồn kho');
      }

      const candidateIds = dto.overrideSourceId
        ? [dto.overrideSourceId]
        : (await this.prisma.location.findMany({
            where: {
              type: { in: [LocationType.STORE, LocationType.CENTRAL_WAREHOUSE] },
              active: true,
            },
            select: { id: true },
          })).map((item) => item.id);
      if (user?.role === Role.STAFF && dto.overrideSourceId) {
        assertLocationAccess(user, dto.overrideSourceId);
      }

      let selectedSourceId: string | undefined;
      for (const locationId of candidateIds) {
        const balances = await this.prisma.stockBalance.findMany({
          where: { locationId, skuId: { in: order.items.map((item) => item.skuId!) } },
        });
        const bySku = new Map(balances.map((balance) => [balance.skuId, balance]));
        const hasEnoughStock = order.items.every((item) => {
          const balance = bySku.get(item.skuId!);
          return balance !== undefined
            && balance.onHand - balance.reserved - balance.safetyBuffer >= item.quantity;
        });
        if (hasEnoughStock) {
          selectedSourceId = locationId;
          break;
        }
      }
      if (!selectedSourceId) throw new ConflictException('Không có địa điểm đủ tồn kho khả dụng');

      const selected = selectedSourceId;
      const result = await this.prisma.$transaction(async (tx) => {
        await this.inventoryService.moveOrderReservationsInTransaction(
          tx,
          order.id,
          selected,
          order.items.map((item) => ({ skuId: item.skuId!, quantity: item.quantity })),
          actorId,
        );

        const changed = await tx.order.updateMany({
          where: { id: order.id, version: order.version },
          data: {
            allocatedSourceId: selected,
            status: OrderStatus.ASSIGNED,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('Đơn vừa thay đổi, hãy tải lại trước khi chọn nguồn');
        }
        const updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: 'SOURCE_ALLOCATED',
            fromStatus: order.status,
            toStatus: OrderStatus.ASSIGNED,
            actorUserId: actorId,
            commandId: dto.idempotencyKey,
            payload: { sourceLocationId: selected, overrideReason: dto.overrideReason },
          },
        });
        await this.outboxService.enqueue({
          aggregateType: 'Order',
          aggregateId: order.id,
          aggregateVersion: updated.version,
          eventType: 'ORDER_SOURCE_ALLOCATED',
          payload: { orderId: order.id, sourceLocationId: selected },
        }, tx);
        const response = {
          id: dto.idempotencyKey,
          salesOrderId: order.id,
          selectedSourceId: selected,
          status: 'SUCCESS',
          order: updated,
        };
        await this.idempotencyService.completeCommand(idempotency.commandRecordId, response, tx);
        return response;
      });
      return result;
    } catch (error) {
      await this.idempotencyService.failCommand(
        idempotency.commandRecordId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async getAttemptsForOrder(orderId: string, user: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    if (user.role === Role.STAFF && order.allocatedSourceId) {
      assertLocationAccess(user, order.allocatedSourceId);
    }
    return this.prisma.orderEvent.findMany({
      where: { orderId, eventType: 'SOURCE_ALLOCATED' },
      orderBy: { occurredAt: 'desc' },
    });
  }
}
