import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PackageEventType, PackageStatus, Role } from '@prisma/client';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { assertLocationAccess, AuthenticatedUser } from '../auth/branch-scope';
import { OutboxService } from '../common/services/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransferShipmentDto, InboundScanDto, QueryHoldingsDto, VerifyCollectionDto } from './dto/pickup.dto';

@Injectable()
export class PickupService {
  constructor(private readonly prisma: PrismaService, private readonly outbox: OutboxService) {}

  async createTransferShipment(dto: CreateTransferShipmentDto, user?: AuthenticatedUser) {
    const pkg = await this.prisma.package.findUnique({ where: { id: dto.packageId }, include: { order: true, transferShipment: true } });
    if (!pkg) throw new NotFoundException('Không tìm thấy kiện hàng');
    if (!pkg.order.allocatedSourceId || !pkg.order.selectedPickupPointId) throw new ConflictException('Đơn thiếu nguồn hoặc điểm nhận');
    if (user?.role === Role.STAFF) assertLocationAccess(user, pkg.order.allocatedSourceId);
    return this.prisma.$transaction(async (tx) => {
      const shipment = pkg.transferShipment || await tx.transferShipment.create({ data: { shipmentNumber: `TRF-${randomUUID().slice(0, 8).toUpperCase()}`, packageId: pkg.id, sourceLocationId: pkg.order.allocatedSourceId!, destinationPickupPointId: pkg.order.selectedPickupPointId! } });
      if (dto.tripId) {
        const trip = await tx.trip.findUnique({ where: { id: dto.tripId }, select: { id: true } });
        if (!trip) throw new NotFoundException('Không tìm thấy chuyến');
        const active = await tx.tripTransferShipment.findFirst({ where: { transferShipmentId: shipment.id, releasedAt: null } });
        if (active && active.tripId !== dto.tripId) throw new ConflictException('Kiện đang được gắn với chuyến khác');
        if (!active) await tx.tripTransferShipment.create({ data: { tripId: dto.tripId, transferShipmentId: shipment.id } });
        await tx.transferShipment.update({ where: { id: shipment.id }, data: { status: 'ASSIGNED_TO_TRIP' } });
      }
      await this.outbox.enqueue({ aggregateType: 'TransferShipment', aggregateId: shipment.id, eventType: 'RETAIL_TRANSFER_SHIPMENT_CREATED', payload: { transferShipmentId: shipment.id, packageId: pkg.id } }, tx);
      return shipment;
    });
  }

  async inboundScanAtPickupPoint(dto: InboundScanDto, user: AuthenticatedUser) {
    const pkg = await this.prisma.package.findUnique({ where: { packageCode: dto.packageCode }, include: { order: true } });
    if (!pkg) throw new NotFoundException('Không tìm thấy kiện hàng');
    const locationId = pkg.order.selectedPickupPointId;
    if (!locationId) throw new ConflictException('Kiện không có điểm nhận');
    if (user.role === Role.STAFF) assertLocationAccess(user, locationId);
    if (pkg.arrivedAtPickupPointAt) return { holding: pkg, orderStatus: pkg.order.status };
    return this.prisma.$transaction(async (tx) => {
      const reservedSlot = await tx.location.updateMany({ where: { id: locationId, availableHoldingSlots: { gt: 0 } }, data: { availableHoldingSlots: { decrement: 1 } } });
      if (reservedSlot.count !== 1) throw new ConflictException('Điểm nhận đã hết chỗ lưu kiện');
      const now = new Date();
      const updated = await tx.package.update({ where: { id: pkg.id }, data: { holdingSlot: dto.holdingSlot, arrivedAtPickupPointAt: now, status: PackageStatus.DELIVERED, version: { increment: 1 } } });
      await tx.packageEvent.create({ data: { packageId: pkg.id, eventType: PackageEventType.ARRIVED_PICKUP_POINT, locationId, actorUserId: user.id, metadata: { holdingSlot: dto.holdingSlot } } });
      const outstanding = await tx.package.count({ where: { orderId: pkg.orderId, arrivedAtPickupPointAt: null, status: { not: PackageStatus.CANCELLED } } });
      let orderStatus = pkg.order.status;
      if (outstanding === 0) {
        const otp = String(randomInt(100000, 1000000));
        const qr = randomUUID();
        await tx.collectionToken.upsert({ where: { orderId: pkg.orderId }, update: { otpCode: this.hash(otp), qrToken: this.hash(qr), status: 'ACTIVE', expiresAt: new Date(Date.now() + 72 * 3600_000), attemptCount: 0 }, create: { orderId: pkg.orderId, otpCode: this.hash(otp), qrToken: this.hash(qr), expiresAt: new Date(Date.now() + 72 * 3600_000) } });
        await tx.orderEvent.create({ data: { orderId: pkg.orderId, eventType: 'READY_FOR_COLLECTION', actorUserId: user.id } });
        orderStatus = OrderStatus.ASSIGNED;
        await this.outbox.enqueue({ aggregateType: 'Order', aggregateId: pkg.orderId, eventType: 'RETAIL_READY_FOR_COLLECTION', payload: { orderId: pkg.orderId } }, tx);
      }
      return { holding: updated, orderStatus };
    });
  }

  async verifyAndCollect(dto: VerifyCollectionDto, user: AuthenticatedUser) {
    if (!dto.otpCode && !dto.qrToken) throw new BadRequestException('Cần OTP hoặc QR token');
    const token = await this.prisma.collectionToken.findUnique({ where: { orderId: dto.salesOrderId }, include: { order: { include: { packages: true } } } });
    if (!token) throw new NotFoundException('Không tìm thấy mã nhận hàng');
    if (token.order.selectedPickupPointId !== dto.pickupPointId) throw new ForbiddenException('Mã không thuộc điểm nhận này');
    if (user.role === Role.STAFF) assertLocationAccess(user, dto.pickupPointId);
    if (token.status !== 'ACTIVE' || token.expiresAt <= new Date()) throw new ConflictException('Mã nhận hàng không còn hiệu lực');
    const supplied = dto.otpCode || dto.qrToken!;
    const expected = dto.otpCode ? token.otpCode : token.qrToken;
    if (!this.matches(supplied, expected)) {
      await this.prisma.collectionToken.update({ where: { id: token.id }, data: { attemptCount: { increment: 1 }, status: token.attemptCount + 1 >= 5 ? 'REVOKED' : 'ACTIVE' } });
      throw new BadRequestException('Mã nhận hàng không chính xác');
    }
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.collectionToken.update({ where: { id: token.id }, data: { status: 'VERIFIED', verifiedAt: now, verifiedById: user.id } });
      for (const pkg of token.order.packages) {
        await tx.package.update({ where: { id: pkg.id }, data: { releasedAt: now, status: PackageStatus.DELIVERED, holdingSlot: null, version: { increment: 1 } } });
        await tx.packageEvent.create({ data: { packageId: pkg.id, eventType: PackageEventType.COLLECTED, locationId: dto.pickupPointId, actorUserId: user.id, notes: dto.notes } });
      }
      await tx.location.update({ where: { id: dto.pickupPointId }, data: { availableHoldingSlots: { increment: token.order.packages.filter((pkg) => pkg.arrivedAtPickupPointAt && !pkg.releasedAt).length } } });
      const order = await tx.order.update({ where: { id: token.orderId }, data: { status: OrderStatus.COMPLETED, version: { increment: 1 } } });
      await tx.orderEvent.create({ data: { orderId: order.id, eventType: 'CUSTOMER_COLLECTED', actorUserId: user.id } });
      await this.outbox.enqueue({ aggregateType: 'Order', aggregateId: order.id, aggregateVersion: order.version, eventType: 'RETAIL_CUSTOMER_COLLECTED', payload: { orderId: order.id } }, tx);
      return { salesOrder: order, collectionTokenId: token.id };
    });
  }

  async getHoldings(query: QueryHoldingsDto) {
    return this.prisma.package.findMany({ where: { order: { selectedPickupPointId: query.locationId }, arrivedAtPickupPointAt: { not: null }, releasedAt: query.status === 'RELEASED_TO_CUSTOMER' ? { not: null } : null }, include: { order: { include: { customer: true } } }, orderBy: { arrivedAtPickupPointAt: 'asc' } });
  }

  async getCustomerCollectionToken(orderId: string, user: AuthenticatedUser) {
    const token = await this.prisma.collectionToken.findUnique({ where: { orderId }, include: { order: { include: { customer: true } } } });
    if (!token) throw new NotFoundException('Chưa có mã nhận hàng');
    if (user.role === Role.CUSTOMER && token.order.customer.userId !== user.id) throw new ForbiddenException('Không có quyền xem mã nhận hàng này');
    return { id: token.id, orderId, status: token.status, expiresAt: token.expiresAt, verifiedAt: token.verifiedAt };
  }

  private hash(value: string) { return createHmac('sha256', this.secret()).update(value).digest('hex'); }
  private matches(value: string, expected: string) { const actual = Buffer.from(this.hash(value)); const stored = Buffer.from(expected); return actual.length === stored.length && timingSafeEqual(actual, stored); }
  private secret() { const value = process.env.COLLECTION_TOKEN_SECRET; if (!value || value.length < 32) throw new Error('COLLECTION_TOKEN_SECRET phải có ít nhất 32 ký tự'); return value; }
}
