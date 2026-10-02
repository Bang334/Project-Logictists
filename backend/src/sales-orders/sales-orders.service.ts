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
import { CancelOrderDto } from './dto/cancel-order.dto';
import { CheckoutOrderDto } from './dto/checkout-order.dto';
import { QuerySalesOrdersDto } from './dto/query-sales-orders.dto';

@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly inventoryService: InventoryService,
  ) {}

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
      let isDirectDelivery = Boolean(dto.deliveryAddress?.trim());
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

      let customerAddressId: string | null = null;
      let deliveryLat = dto.deliveryLatitude || 21.0285;
      let deliveryLng = dto.deliveryLongitude || 105.8542;

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

      // Tạo Packages vật lý tương ứng với các mặt hàng để thuật toán xếp thùng xe OR-Tools Floor Packing có thể lập kế hoạch
      let packageIdx = 1;
      for (const line of order.items) {
        const sku = line.skuId ? skuById.get(line.skuId) : undefined;
        const lMm = sku?.lengthMm || 600;
        const wMm = sku?.widthMm || 400;
        const hMm = sku?.heightMm || 300;
        const wG = BigInt(sku?.weightGrams || 10000);

        for (let q = 1; q <= line.quantity; q++) {
          const pkg = await tx.package.create({
            data: {
              orderId: order.id,
              packageCode: `PKG-${order.orderNumber.slice(-6)}-${String(packageIdx++).padStart(3, '0')}`,
              lengthMm: lMm,
              widthMm: wMm,
              heightMm: hMm,
              weightG: wG,
              allowedOrientations: ['DEFAULT', 'ROTATE_YAW'],
              measurementSource: 'AUTO_ORDER',
              status: 'READY',
              items: {
                create: {
                  orderItemId: line.id,
                  quantity: 1,
                },
              },
              events: {
                create: {
                  eventType: 'PACKED',
                  locationId: source.id,
                },
              },
            },
          });
        }
      }

      await tx.processedCommand.create({ data: { actorUserId: user.id, commandType: 'RETAIL_CHECKOUT', idempotencyKey: dto.idempotencyKey, requestHash, status: 'COMPLETED', result: { orderId: order.id } } });
      await this.outbox.enqueue({ aggregateType: 'Order', aggregateId: order.id, aggregateVersion: order.version, eventType: 'RETAIL_ORDER_CREATED', payload: { orderId: order.id } }, tx);
      return order;
    });
  }

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

  async findSalesOrderById(id: string, user: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        items: { include: { skuRef: { include: { product: true } } } },
        selectedPickupPoint: true,
        allocatedSource: true,
        packages: { include: { items: true } },
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

  async querySalesOrders(query: QuerySalesOrdersDto, user: AuthenticatedUser) {
    const where: Prisma.OrderWhereInput = { orderType: { in: [OrderType.RETAIL_PICKUP, OrderType.RETAIL_DELIVERY] } };
    if (query.status) where.status = query.status;
    if (query.pickupPointId) where.selectedPickupPointId = query.pickupPointId;
    if (query.customerPhone) where.customer = { phone: query.customerPhone };
    if (query.search) where.OR = [{ orderNumber: { contains: query.search, mode: 'insensitive' } }, { customer: { name: { contains: query.search, mode: 'insensitive' } } }];
    if (user.role === Role.CUSTOMER) where.customer = { userId: user.id };
    else if (user.role === Role.STAFF) where.OR = [{ allocatedSourceId: user.locationId }, { selectedPickupPointId: user.locationId }];
    const page = query.page || 1, limit = Math.min(query.limit || 20, 100);
    const [data, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          customer: true,
          items: { include: { skuRef: { include: { product: true } } } },
          selectedPickupPoint: true,
          allocatedSource: true,
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

  private assertOrderAccess(order: { customer: { userId: string | null }; allocatedSourceId: string | null; selectedPickupPointId: string | null }, user: AuthenticatedUser) {
    if (user.role === Role.ADMIN) return;
    if (user.role === Role.CUSTOMER && order.customer.userId !== user.id) throw new ForbiddenException('Không có quyền truy cập đơn hàng này');
    if (user.role === Role.STAFF && ![order.allocatedSourceId, order.selectedPickupPointId].includes(user.locationId || null)) throw new ForbiddenException('Đơn hàng ngoài phạm vi địa điểm');
  }
}
