import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, OrderType, PaymentStatus, Prisma, Role } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { AuthenticatedUser, assertLocationAccess } from '../auth/branch-scope';
import { OutboxService } from '../common/services/outbox.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { ShoppingService } from '../shopping/shopping.service';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CheckoutOrderDto } from './dto/checkout-order.dto';
import { CheckoutMultiSourceDto } from './dto/checkout-multi-source.dto';
import { QuerySalesOrdersDto } from './dto/query-sales-orders.dto';

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly inventoryService: InventoryService,
    private readonly shoppingService: ShoppingService,
  ) {}

  // ================= 1. CHECKOUT ORDER (LEGACY / SINGLE-SOURCE) =================
  async checkoutOrder(dto: CheckoutOrderDto, user: AuthenticatedUser) {
    if (!dto.items.length) throw new BadRequestException('Đơn hàng phải có ít nhất một mặt hàng');
    const requestHash = createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    const existing = await this.prisma.processedCommand.findUnique({
      where: { actorUserId_commandType_idempotencyKey: { actorUserId: user.id, commandType: 'RETAIL_CHECKOUT', idempotencyKey: dto.idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ConflictException('Idempotency key đã được dùng với dữ liệu khác');
      if (existing.result && typeof existing.result === 'object' && !Array.isArray(existing.result) && 'orderId' in existing.result) {
        return this.findSalesOrderById(String(existing.result.orderId), user);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const isDirectDelivery = Boolean(dto.deliveryAddress?.trim());
      let point: any = null;

      if (!isDirectDelivery) {
        if (!dto.selectedPickupPointId) {
          throw new BadRequestException('Vui lòng cung cấp địa chỉ giao hàng tận nơi hoặc điểm nhận');
        }
        point = await tx.location.findFirst({ where: { id: dto.selectedPickupPointId, active: true, type: 'PICKUP_POINT' } });
        if (!point) throw new NotFoundException('Điểm nhận không tồn tại hoặc đã ngừng hoạt động');
      }

      let sourceId = dto.fulfillmentSourceId || user.locationId;
      if (!sourceId) {
        const defaultSource = await tx.location.findFirst({
          where: { active: true, type: { in: ['STORE', 'CENTRAL_WAREHOUSE'] } },
          orderBy: { createdAt: 'asc' },
        });
        sourceId = defaultSource?.id;
      }
      if (!sourceId) throw new BadRequestException('Thiếu địa điểm xuất hàng');
      if (user.role === Role.STAFF) assertLocationAccess(user, sourceId);
      const source = await tx.location.findFirst({ where: { id: sourceId, active: true } });
      if (!source) throw new NotFoundException('Địa điểm xuất hàng không hợp lệ');

      const skus = await tx.sku.findMany({ where: { id: { in: dto.items.map((item) => item.skuId) }, isSellable: true } });
      if (skus.length !== new Set(dto.items.map((item) => item.skuId)).size) throw new BadRequestException('Có SKU không tồn tại hoặc không được bán');
      const skuById = new Map(skus.map((sku) => [sku.id, sku]));

      const customer = await tx.customer.upsert({
        where: { phone: dto.customerPhone },
        update: { name: dto.customerName, userId: user.role === Role.CUSTOMER ? user.id : undefined },
        create: { code: `CUS-${randomUUID().slice(0, 8).toUpperCase()}`, name: dto.customerName, phone: dto.customerPhone, userId: user.role === Role.CUSTOMER ? user.id : undefined },
      });

      const deliveryLat = dto.deliveryLatitude || 21.0285;
      const deliveryLng = dto.deliveryLongitude || 105.8542;

      if (isDirectDelivery) {
        await tx.customerAddress.create({
          data: {
            customerId: customer.id,
            label: 'Địa chỉ công trình / giao hàng tận nơi',
            recipientName: dto.deliveryContactName || dto.customerName,
            phone: dto.deliveryContactPhone || dto.customerPhone,
            address: dto.deliveryAddress!.trim(),
            latitude: deliveryLat,
            longitude: deliveryLng,
            isDefault: true,
          },
        });
      }

      const branchId = source.managingBranchId || user.branchId;
      if (!branchId) throw new BadRequestException('Địa điểm xuất hàng chưa thuộc chi nhánh');

      let subtotal = new Prisma.Decimal(0);
      const lines = dto.items.map((item) => {
        const sku = skuById.get(item.skuId)!;
        const lineTotal = sku.salePrice.mul(item.quantity);
        subtotal = subtotal.add(lineTotal);
        return {
          skuId: sku.id,
          sku: sku.skuCode,
          description: sku.name,
          quantity: item.quantity,
          unitPrice: sku.salePrice,
          lineTotal,
          weightKg: (sku.weightGrams * item.quantity) / 1000,
          lengthCm: sku.lengthMm / 10,
          widthCm: sku.widthMm / 10,
          heightCm: sku.heightMm / 10,
          volumeM3: Number(sku.volumeMm3) * item.quantity / 1_000_000_000,
        };
      });

      const totalWeightKg = lines.reduce((sum, line) => sum + line.weightKg, 0);
      const totalVolumeM3 = lines.reduce((sum, line) => sum + line.volumeM3, 0);

      const order = await tx.order.create({
        data: {
          orderNumber: `SO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6).toUpperCase()}`,
          orderType: isDirectDelivery ? OrderType.RETAIL_DELIVERY : OrderType.RETAIL_PICKUP,
          customerId: customer.id,
          branchId,
          selectedPickupPointId: point ? point.id : null,
          allocatedSourceId: source.id,
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethod: dto.paymentMethod || 'MANUAL_PENDING',
          subtotal,
          totalAmount: subtotal,
          totalWeightKg,
          totalVolumeM3,
          totalPackages: lines.reduce((sum, l) => sum + l.quantity, 0),
          notes: dto.notes,
          items: { create: lines },
          events: { create: { eventType: 'ORDER_CHECKED_OUT', toStatus: OrderStatus.CONFIRMED, actorUserId: user.id } },
          stops: isDirectDelivery ? {
            create: [
              {
                type: 'PICKUP',
                sequence: 1,
                address: source.address || 'Kho nguồn xuất hàng VLXD',
                latitude: source.latitude || 21.0345,
                longitude: source.longitude || 105.9082,
                contactName: source.name,
                contactPhone: '0901234567',
                serviceDurationMinutes: 30,
              },
              {
                type: 'DELIVERY',
                sequence: 2,
                address: dto.deliveryAddress!.trim(),
                latitude: deliveryLat,
                longitude: deliveryLng,
                contactName: dto.deliveryContactName || dto.customerName,
                contactPhone: dto.deliveryContactPhone || dto.customerPhone,
                serviceDurationMinutes: 30,
              },
            ],
          } : undefined,
        },
        include: {
          items: { include: { skuRef: { include: { product: true } } } },
          selectedPickupPoint: true,
          allocatedSource: true,
          customer: true,
          stops: true,
        },
      });

      await tx.processedCommand.create({ data: { actorUserId: user.id, commandType: 'RETAIL_CHECKOUT', idempotencyKey: dto.idempotencyKey, requestHash, status: 'COMPLETED', result: { orderId: order.id } } });
      await this.outbox.enqueue({ aggregateType: 'Order', aggregateId: order.id, aggregateVersion: order.version, eventType: 'RETAIL_ORDER_CREATED', payload: { orderId: order.id } }, tx);
      return order;
    });
  }

  // ================= 2. CHECKOUT MULTI-SOURCE ORDER (NEW ATOMIC FLOW) =================
  async checkoutMultiSourceOrder(dto: CheckoutMultiSourceDto, user: AuthenticatedUser) {
    if (!dto.acceptedConditions) {
      throw new BadRequestException('Khách hàng cần chấp thuận các điều kiện giao hàng và quy trình chuẩn bị');
    }

    const quote = await this.shoppingService.getQuoteById(dto.quoteId);
    if (!quote) {
      throw new NotFoundException('Báo giá không tồn tại hoặc đã hết hạn. Vui lòng lấy lại báo giá mới.');
    }
    if (new Date(quote.expiresAt).getTime() < Date.now()) {
      throw new BadRequestException('Báo giá đã hết hạn 15 phút. Vui lòng tạo lại báo giá mới.');
    }

    // Kiểm tra version cấu hình vùng phục vụ (MN28)
    if (quote.serviceZoneId) {
      const zone = await this.prisma.serviceZone.findUnique({
        where: { id: quote.serviceZoneId },
      });
      if (zone && zone.version !== (quote.serviceZoneVersion ?? 1)) {
        throw new ConflictException(
          'Cấu hình vùng phục vụ đã thay đổi kể từ khi tạo báo giá. Vui lòng lấy lại báo giá mới.',
        );
      }
    }

    const requestHash = createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    const existing = await this.prisma.processedCommand.findUnique({
      where: {
        actorUserId_commandType_idempotencyKey: {
          actorUserId: user.id,
          commandType: 'RETAIL_MULTI_SOURCE_CHECKOUT',
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException('Idempotency key đã được dùng với dữ liệu khác');
      }
      if (existing.result && typeof existing.result === 'object' && 'orderId' in existing.result) {
        return this.findSalesOrderById(String((existing.result as any).orderId), user);
      }
    }

    const createdOrderId = await this.prisma.$transaction(async (tx) => {
      // 1. Thu thập và gộp tất cả các cặp (locationId, skuId) cần khóa (cộng dồn quantity - Fix Issue 6)
      const lockPairsMap = new Map<string, { locationId: string; skuId: string; quantity: number }>();
      for (const item of quote.items) {
        for (const alloc of item.sourceAllocations) {
          const key = `${alloc.locationId}::${item.skuId}`;
          const existing = lockPairsMap.get(key);
          if (existing) {
            existing.quantity += alloc.quantity;
          } else {
            lockPairsMap.set(key, {
              locationId: alloc.locationId,
              skuId: item.skuId,
              quantity: alloc.quantity,
            });
          }
        }
      }
      const lockPairs = Array.from(lockPairsMap.values());

      // Sắp xếp thứ tự ổn định toàn cục (locationId asc, skuId asc) để tránh deadlock
      lockPairs.sort((a, b) => {
        const locComp = a.locationId.localeCompare(b.locationId);
        if (locComp !== 0) return locComp;
        return a.skuId.localeCompare(b.skuId);
      });

      // 2. Khóa và kiểm tra tồn khả dụng tại từng nguồn (chống oversell)
      for (const pair of lockPairs) {
        await tx.$queryRaw`
          SELECT "id"
          FROM "stock_balances"
          WHERE "locationId" = ${pair.locationId}
            AND "skuId" = ${pair.skuId}
          FOR UPDATE
        `;

        const balance = await tx.stockBalance.findUnique({
          where: {
            skuId_locationId: {
              skuId: pair.skuId,
              locationId: pair.locationId,
            },
          },
        });

        if (!balance) {
          throw new ConflictException(
            `Không tìm thấy tồn kho cho SKU ${pair.skuId} tại địa điểm ${pair.locationId}`,
          );
        }

        const sellable = Math.max(0, balance.onHand - balance.reserved - balance.safetyBuffer);
        if (sellable < pair.quantity) {
          throw new ConflictException(
            `Cửa hàng ${pair.locationId} không đủ tồn cho SKU ${pair.skuId}: Cần ${pair.quantity}, còn khả dụng ${sellable}`,
          );
        }
      }

      // 3. Upsert khách hàng
      const customer = await tx.customer.upsert({
        where: { phone: dto.customerPhone },
        update: {
          name: dto.customerName,
          userId: user.role === Role.CUSTOMER ? user.id : undefined,
        },
        create: {
          code: `CUS-${randomUUID().slice(0, 8).toUpperCase()}`,
          name: dto.customerName,
          phone: dto.customerPhone,
          userId: user.role === Role.CUSTOMER ? user.id : undefined,
        },
      });

      // 4. Lưu địa chỉ công trình / giao hàng
      await tx.customerAddress.create({
        data: {
          customerId: customer.id,
          label: 'Địa chỉ giao hàng tận nơi (đa nguồn)',
          recipientName: dto.customerName,
          phone: dto.customerPhone,
          address: quote.deliveryAddress,
          latitude: quote.deliveryLatitude,
          longitude: quote.deliveryLongitude,
          isDefault: true,
        },
      });

      // 5. Xác định chi nhánh điều phối chủ trì (lấy từ cửa hàng nguồn đầu tiên)
      const firstSource = await tx.location.findUnique({
        where: { id: quote.sourceStores[0].id },
      });
      const managingBranchId = firstSource?.managingBranchId || user.branchId;
      if (!managingBranchId) {
        throw new BadRequestException('Cửa hàng xuất hàng chưa được gán chi nhánh quản lý');
      }

      // 6. Tạo danh sách OrderItem và tính tổng
      const orderItemsData = quote.items.map((item) => {
        return {
          skuId: item.skuId,
          sku: item.skuCode,
          description: item.name,
          quantity: item.quantity,
          unitPrice: new Prisma.Decimal(item.unitPrice),
          lineTotal: new Prisma.Decimal(item.lineTotal),
          weightKg: 0,
          volumeM3: 0,
        };
      });

      // 7. Tạo Order
      const order = await tx.order.create({
        data: {
          orderNumber: `SO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 6).toUpperCase()}`,
          orderType: OrderType.RETAIL_DELIVERY,
          customerId: customer.id,
          branchId: managingBranchId,
          allocatedSourceId: firstSource?.id,
          status: OrderStatus.CONFIRMED,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethod: dto.paymentMethod || 'MANUAL_PENDING',
          subtotal: new Prisma.Decimal(quote.subtotal),
          shippingFee: new Prisma.Decimal(quote.shippingFee),
          totalAmount: new Prisma.Decimal(quote.totalAmount),
          maxSourcesAllowed: quote.sourceStores.length,
          maxDistanceBetweenSourcesKm: quote.maxDistanceBetweenSourcesKm,
          serviceZoneSnapshotId: quote.provinceCode,
          notes: dto.notes,
          items: { create: orderItemsData },
          events: {
            create: {
              eventType: 'ORDER_CHECKED_OUT_MULTI_SOURCE',
              toStatus: OrderStatus.CONFIRMED,
              actorUserId: user.id,
              payload: {
                quoteId: quote.quoteId,
                sourceCount: quote.sourceStores.length,
              },
            },
          },
        },
        include: {
          items: true,
        },
      });

      // 8. Tạo OrderStops (các điểm PICKUP tại từng STORE và 1 điểm DELIVERY tại khách)
      let sequence = 1;
      const storePickupStopMap = new Map<string, string>();
      for (const store of quote.sourceStores) {
        const storeEntity = await tx.location.findUnique({ where: { id: store.id } });
        const pickupStop = await tx.orderStop.create({
          data: {
            orderId: order.id,
            type: 'PICKUP',
            sequence: sequence++,
            address: store.address,
            latitude: storeEntity?.latitude ?? 21.0,
            longitude: storeEntity?.longitude ?? 105.8,
            contactName: store.name,
            contactPhone: '0901234567',
            serviceDurationMinutes: 30,
          },
        });
        storePickupStopMap.set(store.id, pickupStop.id);
      }

      await tx.orderStop.create({
        data: {
          orderId: order.id,
          type: 'DELIVERY',
          sequence: sequence,
          address: quote.deliveryAddress,
          latitude: quote.deliveryLatitude,
          longitude: quote.deliveryLongitude,
          contactName: dto.customerName,
          contactPhone: dto.customerPhone,
          windowStart: quote.deliveryWindowStart ? new Date(quote.deliveryWindowStart) : undefined,
          windowEnd: quote.deliveryWindowEnd ? new Date(quote.deliveryWindowEnd) : undefined,
          serviceDurationMinutes: 30,
        },
      });

      // 9. Tạo FulfillmentGroup và FulfillmentLine cho từng STORE
      const createdItemMap = new Map(order.items.map((i) => [i.skuId!, i.id]));

      for (const store of quote.sourceStores) {
        const storeEntity = await tx.location.findUnique({ where: { id: store.id } });
        const pickupStopId = storePickupStopMap.get(store.id);
        const group = await tx.fulfillmentGroup.create({
          data: {
            groupNumber: `FG-${order.orderNumber}-${storeEntity?.code || randomUUID().slice(0, 4)}`,
            orderId: order.id,
            sourceLocationId: store.id,
            sourceBranchId: storeEntity?.managingBranchId,
            pickupStopId,
            status: 'PENDING',
          },
        });

        // Tạo FulfillmentLine và InventoryReservation cho các SKU lấy tại STORE này
        for (const item of quote.items) {
          const alloc = item.sourceAllocations.find((a) => a.locationId === store.id);
          if (alloc && alloc.quantity > 0) {
            const orderItemId = createdItemMap.get(item.skuId)!;
            const line = await tx.fulfillmentLine.create({
              data: {
                fulfillmentGroupId: group.id,
                orderItemId,
                skuId: item.skuId,
                requestedQuantity: alloc.quantity,
                reservedQuantity: alloc.quantity,
              },
            });

            // Tạo InventoryReservation
            await tx.inventoryReservation.create({
              data: {
                reservationNumber: `RES-${randomUUID()}`,
                orderId: order.id,
                fulfillmentLineId: line.id,
                skuId: item.skuId,
                locationId: store.id,
                quantity: alloc.quantity,
                status: 'ACTIVE',
                expiresAt: new Date(quote.expiresAt),
                createdById: user.id,
              },
            });

            // Tăng reserved trên StockBalance
            await tx.stockBalance.update({
              where: {
                skuId_locationId: {
                  skuId: item.skuId,
                  locationId: store.id,
                },
              },
              data: {
                reserved: { increment: alloc.quantity },
                version: { increment: 1 },
              },
            });
          }
        }
      }

      // 10. Ghi nhận ProcessedCommand và Outbox
      await tx.processedCommand.create({
        data: {
          actorUserId: user.id,
          commandType: 'RETAIL_MULTI_SOURCE_CHECKOUT',
          idempotencyKey: dto.idempotencyKey,
          requestHash,
          status: 'COMPLETED',
          result: { orderId: order.id },
        },
      });

      await this.outbox.enqueue(
        {
          aggregateType: 'Order',
          aggregateId: order.id,
          aggregateVersion: order.version,
          eventType: 'RETAIL_MULTI_SOURCE_ORDER_CREATED',
          payload: { orderId: order.id, quoteId: quote.quoteId },
        },
        tx,
      );

      return order.id;
    });

    return this.findSalesOrderById(createdOrderId, user);
  }

  // ================= 3. CANCEL ORDER =================
  async cancelOrder(id: string, dto: CancelOrderDto, user: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { customer: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    this.assertOrderAccess(order, user);
    if (order.status === OrderStatus.IN_TRANSIT || order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELLED) throw new ConflictException('Trạng thái hiện tại không cho phép hủy đơn');
    return this.prisma.$transaction(async (tx) => {
      const reservations = await tx.inventoryReservation.findMany({
        where: { orderId: id, status: { in: ['ACTIVE', 'HELD'] } },
        select: { id: true },
      });
      for (const reservation of reservations) {
        await this.inventoryService.releaseReservationInTransaction(tx, reservation.id);
      }
      const updated = await tx.order.update({ where: { id }, data: { status: OrderStatus.CANCELLED, notes: dto.reason, version: { increment: 1 } } });
      await tx.orderEvent.create({ data: { orderId: id, eventType: 'ORDER_CANCELLED', fromStatus: order.status, toStatus: OrderStatus.CANCELLED, actorUserId: user.id, payload: { reason: dto.reason } } });
      await this.outbox.enqueue({ aggregateType: 'Order', aggregateId: id, aggregateVersion: updated.version, eventType: 'RETAIL_ORDER_CANCELLED', payload: { orderId: id } }, tx);
      return updated;
    });
  }

  // ================= 4. FIND SALES ORDER BY ID =================
  async findSalesOrderById(id: string, user: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { skuRef: { include: { product: true } } } },
        selectedPickupPoint: true,
        allocatedSource: true,
        packages: { include: { items: true } },
        fulfillmentGroups: {
          include: {
            sourceLocation: true,
            lines: { include: { sku: true } },
            packages: true,
          },
        },
        events: { orderBy: { occurredAt: 'asc' } },
        payments: true,
        collectionToken: true,
        stops: true,
      },
    });
    if (!order || order.orderType === OrderType.B2B_TRANSPORT) throw new NotFoundException('Không tìm thấy đơn bán hàng');
    this.assertOrderAccess(order, user);
    return order;
  }

  // ================= 5. QUERY SALES ORDERS =================
  async querySalesOrders(query: QuerySalesOrdersDto, user: AuthenticatedUser) {
    const where: Prisma.OrderWhereInput = { orderType: { in: [OrderType.RETAIL_PICKUP, OrderType.RETAIL_DELIVERY] } };
    if (query.status) where.status = query.status;
    if (query.pickupPointId) where.selectedPickupPointId = query.pickupPointId;
    if (query.customerPhone) where.customer = { phone: query.customerPhone };
    if (query.search) where.OR = [{ orderNumber: { contains: query.search, mode: 'insensitive' } }, { customer: { name: { contains: query.search, mode: 'insensitive' } } }];
    if (user.role === Role.CUSTOMER) where.customer = { userId: user.id };
    else if (user.role === Role.STAFF) {
      const staffLocationId = user.locationId;
      if (staffLocationId) {
        where.OR = [
          { allocatedSourceId: staffLocationId },
          { selectedPickupPointId: staffLocationId },
          { fulfillmentGroups: { some: { sourceLocationId: staffLocationId } } },
        ];
      }
    }
    const page = query.page || 1, limit = Math.min(query.limit || 20, 100);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          customer: true,
          items: { include: { skuRef: { include: { product: true } } } },
          selectedPickupPoint: true,
          allocatedSource: true,
          fulfillmentGroups: {
            include: {
              sourceLocation: true,
              lines: true,
            },
          },
          packages: true,
          stops: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  private assertOrderAccess(
    order: {
      customer: { userId: string | null };
      allocatedSourceId: string | null;
      selectedPickupPointId: string | null;
      fulfillmentGroups?: Array<{ sourceLocationId: string }>;
    },
    user: AuthenticatedUser,
  ) {
    if (user.role === Role.ADMIN) return;
    if (user.role === Role.CUSTOMER && order.customer.userId !== user.id) {
      throw new ForbiddenException('Không có quyền truy cập đơn hàng này');
    }
    if (user.role === Role.STAFF) {
      const allowedLocations = [
        order.allocatedSourceId,
        order.selectedPickupPointId,
        ...(order.fulfillmentGroups?.map((g) => g.sourceLocationId) || []),
      ];
      if (!allowedLocations.includes(user.locationId || null)) {
        throw new ForbiddenException('Đơn hàng ngoài phạm vi địa điểm');
      }
    }
  }
}
