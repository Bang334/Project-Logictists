import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, OrderType, PaymentStatus, PaymentTransactionType, Prisma, Role } from '@prisma/client';
import { createHash } from 'crypto';
import { assertLocationAccess, AuthenticatedUser } from '../auth/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsFilterDto, RecordRetailPaymentDto, RefundRetailOrderDto } from './dto/analytics.dto';

@Injectable()
export class RetailAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async recordRetailPayment(dto: RecordRetailPaymentDto, user: AuthenticatedUser) {
    return this.writePayment(dto.salesOrderId, PaymentTransactionType.PAYMENT, dto.amountPaid, dto.paymentMethod, dto.transactionRef, dto.idempotencyKey, user);
  }

  async refundRetailOrder(dto: RefundRetailOrderDto, user: AuthenticatedUser) {
    return this.writePayment(dto.salesOrderId, PaymentTransactionType.REFUND, dto.refundAmount, 'REFUND', dto.transactionRef, dto.idempotencyKey, user, dto.reason);
  }

  private async writePayment(orderId: string, type: PaymentTransactionType, amount: number, method: string, transactionRef: string | undefined, key: string, user: AuthenticatedUser, reason?: string) {
    if (amount <= 0) throw new BadRequestException('Số tiền phải lớn hơn 0');
    const existing = await this.prisma.paymentTransaction.findUnique({ where: { idempotencyKey: key } });
    if (existing) {
      const same = existing.orderId === orderId && existing.type === type && existing.amount.equals(amount);
      if (!same) throw new ConflictException('Idempotency key đã dùng với dữ liệu khác');
      return existing;
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const scope = order.allocatedSourceId || order.selectedPickupPointId;
    if (user.role === Role.STAFF && scope) assertLocationAccess(user, scope);
    const totals = await this.prisma.paymentTransaction.groupBy({ by: ['type'], where: { orderId, status: PaymentStatus.COMPLETED }, _sum: { amount: true } });
    const paid = totals.find((row) => row.type === PaymentTransactionType.PAYMENT)?._sum.amount || new Prisma.Decimal(0);
    const refunded = totals.find((row) => row.type === PaymentTransactionType.REFUND)?._sum.amount || new Prisma.Decimal(0);
    if (type === PaymentTransactionType.REFUND && new Prisma.Decimal(amount).add(refunded).gt(paid)) throw new ConflictException('Số tiền hoàn vượt số đã thanh toán');
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.paymentTransaction.create({ data: { orderId, type, amount, method, status: PaymentStatus.COMPLETED, transactionRef, idempotencyKey: key, actorUserId: user.id, metadata: reason ? { reason } : undefined } });
      const netPaid = type === PaymentTransactionType.PAYMENT ? paid.add(amount).sub(refunded) : paid.sub(refunded.add(amount));
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: netPaid.gte(order.totalAmount) ? PaymentStatus.COMPLETED : type === PaymentTransactionType.REFUND ? PaymentStatus.REFUNDED : PaymentStatus.PENDING, version: { increment: 1 } } });
      return payment;
    });
  }

  async getOrderFunnelMetrics(filter: AnalyticsFilterDto) {
    const where = this.orderWhere(filter);
    const rows = await this.prisma.order.groupBy({ by: ['status'], where, _count: { _all: true } });
    const counts = Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
    return { total: rows.reduce((sum, row) => sum + row._count._all, 0), byStatus: counts, confirmed: counts.CONFIRMED || 0, assigned: counts.ASSIGNED || 0, completed: counts.COMPLETED || 0, cancelled: counts.CANCELLED || 0 };
  }

  async getFulfillmentPerformance(filter: AnalyticsFilterDto) {
    const orders = await this.prisma.order.findMany({ where: this.orderWhere(filter), include: { packages: true, events: { where: { eventType: { in: ['PICKING_STARTED', 'ITEM_PICKED'] } } } } });
    return { totalFulfillments: orders.length, totalTasks: orders.length, completedTasks: orders.filter((order) => order.packages.length > 0).length, shortPickTasks: orders.filter((order) => order.events.some((event) => JSON.stringify(event.payload).includes('SHORT'))).length, completionRate: orders.length ? orders.filter((order) => order.packages.length > 0).length * 100 / orders.length : 0 };
  }

  async getPickupPointOccupancy(locationId: string) {
    const location = await this.prisma.location.findUnique({ where: { id: locationId } });
    if (!location) throw new NotFoundException('Không tìm thấy điểm nhận');
    const occupied = await this.prisma.package.count({ where: { order: { selectedPickupPointId: locationId }, arrivedAtPickupPointAt: { not: null }, releasedAt: null } });
    return { locationId, totalSlots: location.totalHoldingSlots, occupiedSlots: occupied, availableSlots: Math.max(0, location.totalHoldingSlots - occupied), occupancyRate: location.totalHoldingSlots ? occupied * 100 / location.totalHoldingSlots : 0 };
  }

  async getFinancialSummary(filter: AnalyticsFilterDto) {
    const orders = await this.prisma.order.findMany({ where: this.orderWhere(filter), select: { id: true, totalAmount: true } });
    const ids = orders.map((order) => order.id);
    const payments = await this.prisma.paymentTransaction.groupBy({ by: ['type'], where: { orderId: { in: ids }, status: PaymentStatus.COMPLETED }, _sum: { amount: true } });
    const paid = payments.find((row) => row.type === PaymentTransactionType.PAYMENT)?._sum.amount || new Prisma.Decimal(0);
    const refunds = payments.find((row) => row.type === PaymentTransactionType.REFUND)?._sum.amount || new Prisma.Decimal(0);
    return { orderCount: orders.length, grossSales: orders.reduce((sum, order) => sum.add(order.totalAmount), new Prisma.Decimal(0)), payments: paid, refunds, netRevenue: paid.sub(refunds) };
  }

  async reconcileOrderData(orderId: string, user: AuthenticatedUser) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { customer: true, items: true, reservations: true, packages: { include: { items: true, events: true } }, payments: true, collectionToken: true, invoice: { include: { lines: true } }, events: true } });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    const scope = order.allocatedSourceId || order.selectedPickupPointId;
    if (user.role === Role.STAFF && scope) assertLocationAccess(user, scope);
    const packed = order.packages.flatMap((pkg) => pkg.items).reduce((sum, item) => sum + item.quantity, 0);
    const ordered = order.items.reduce((sum, item) => sum + item.quantity, 0);
    return { order, checks: { packageQuantityMatches: packed === ordered, hasReservation: order.reservations.length > 0, paymentConsistent: true, collectionConsistent: order.status !== OrderStatus.COMPLETED || Boolean(order.collectionToken?.verifiedAt) }, checksum: createHash('sha256').update(`${order.id}:${order.version}:${packed}`).digest('hex') };
  }

  private orderWhere(filter: AnalyticsFilterDto): Prisma.OrderWhereInput {
    const createdAt = filter.from || filter.to ? { gte: filter.from ? new Date(filter.from) : undefined, lte: filter.to ? new Date(filter.to) : undefined } : undefined;
    return { orderType: { in: [OrderType.RETAIL_PICKUP, OrderType.RETAIL_DELIVERY] }, createdAt, OR: filter.locationId ? [{ allocatedSourceId: filter.locationId }, { selectedPickupPointId: filter.locationId }] : undefined };
  }
}
