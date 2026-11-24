import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, Prisma, Role, StopType } from '@prisma/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { MapboxService } from '../mapbox/mapbox.service';
import { assertBranchAccess, BranchScopedUser } from '../auth/branch-scope';
import { MAX_ORDER_VERSION } from './dto/confirm-customer-order.dto';
import { customerDraftOrigin, lockOrder, orderVersionConflict } from './order-write';

const orderDetail = {
  customer: true,
  stops: { orderBy: { sequence: 'asc' } },
  items: true,
} satisfies Prisma.OrderInclude;

function sameRows<T extends object>(stored: T[], requested: Partial<T>[]): boolean {
  if (stored.length !== requested.length) return false;
  const remaining = [...stored];
  for (const row of requested) {
    const keys = Object.keys(row) as (keyof T)[];
    const index = remaining.findIndex((candidate) =>
      keys.every((key) => candidate[key] === row[key]),
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
  ) {}

  async findAll(status?: OrderStatus, customerId?: string, branchId?: string) {
    return this.prisma.order.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(customerId ? { customerId } : {}),
        ...(branchId ? { branchId } : {}),
      },
      include: {
        customer: { select: { id: true, code: true, name: true, phone: true } },
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Không tìm thấy đơn hàng với ID ${id}`);
    }
    return order;
  }

  async findOneAuthorized(
    id: string,
    user: { branchId?: string | null; role: Role },
  ) {
    const order = await this.findOne(id);
    assertBranchAccess(user, order.branchId);
    return order;
  }

  async getAvailableForDispatch(branchId?: string) {
    return this.prisma.order.findMany({
      where: {
        status: OrderStatus.CONFIRMED,
        ...(branchId ? { branchId } : {}),
      },
      include: {
        customer: { select: { id: true, code: true, name: true } },
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(dto: CreateOrderDto, branchId?: string) {
    if (!branchId) {
      throw new ForbiddenException('Tài khoản chưa được gán chi nhánh để tạo đơn hàng');
    }
    // 1. Kiểm tra Stops (BR03: Ít nhất 1 pickup và 1 delivery)
    const hasPickup = dto.stops.some((s) => s.type === StopType.PICKUP);
    const hasDelivery = dto.stops.some((s) => s.type === StopType.DELIVERY);

    if (!hasPickup || !hasDelivery) {
      throw new BadRequestException('Đơn hàng bắt buộc phải có ít nhất 1 điểm lấy hàng (PICKUP) và 1 điểm giao hàng (DELIVERY)');
    }

    // 2. Geocode tự động nếu tọa độ chưa có hoặc = 0
    for (const stop of dto.stops) {
      if (!stop.latitude || !stop.longitude) {
        const geocoded = await this.mapboxService.geocode(stop.address);
        if (geocoded.length > 0) {
          stop.latitude = geocoded[0].latitude;
          stop.longitude = geocoded[0].longitude;
        } else {
          throw new BadRequestException(`Không thể định vị tọa độ Mapbox cho địa chỉ: "${stop.address}"`);
        }
      }
    }

    // 3. Tính toán tổng khối lượng, thể tích, số kiện
    let totalWeightKg = 0;
    let totalVolumeM3 = 0;
    let totalPackages = 0;

    for (const item of dto.items) {
      totalWeightKg += item.weightKg;
      totalVolumeM3 +=
        item.volumeM3 ||
        (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1000000;
      totalPackages += item.quantity;
    }

    // Tạo mã đơn hàng tự động dạng ORD-YYYYMMDD-XXXX
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const countToday = await this.prisma.order.count({
      where: {
        orderNumber: { startsWith: `ORD-${dateStr}` },
      },
    });
    const seq = String(countToday + 1).padStart(3, '0');
    const orderNumber = `ORD-${dateStr}-${seq}`;

    return this.prisma.order.create({
      data: {
        orderNumber,
        customerId: dto.customerId,
        branchId,
        status: OrderStatus.CONFIRMED,
        orderedAt: dto.orderedAt,
        totalAmount: dto.totalAmount ?? 0,
        totalWeightKg: Math.round(totalWeightKg * 10) / 10,
        totalVolumeM3: Math.round(totalVolumeM3 * 100) / 100,
        totalPackages,
        notes: dto.notes,
        stops: {
          create: dto.stops.map((s, idx) => ({
            type: s.type,
            sequence: s.sequence || idx + 1,
            address: s.address,
            latitude: s.latitude,
            longitude: s.longitude,
            contactName: s.contactName,
            contactPhone: s.contactPhone,
            serviceDurationMinutes: s.serviceDurationMinutes || 20,
          })),
        },
        items: {
          create: dto.items.map((i) => ({
            sku: i.sku,
            description: i.description,
            packageType: i.packageType || 'CARTON',
            quantity: i.quantity,
            weightKg: i.weightKg,
            lengthCm: i.lengthCm,
            widthCm: i.widthCm,
            heightCm: i.heightCm,
            volumeM3:
              i.volumeM3 ||
              (i.lengthCm * i.widthCm * i.heightCm * i.quantity) / 1000000,
          })),
        },
      },
      include: {
        customer: true,
        stops: true,
        items: true,
      },
    });
  }

  async update(
    id: string,
    dto: UpdateOrderDto,
    user: BranchScopedUser,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { branchId: true, status: true, version: true },
    });

    if (!order) {
      throw new NotFoundException(`Không tìm thấy đơn hàng với ID ${id}`);
    }

    assertBranchAccess(user, order.branchId);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== order.version) {
      throw orderVersionConflict();
    }

    if (order.status !== OrderStatus.CONFIRMED && order.status !== OrderStatus.DRAFT) {
      throw new BadRequestException(
        `Không thể chỉnh sửa đơn hàng đang ở trạng thái ${order.status} (đã gán vào chuyến xe hoặc đang vận chuyển).`,
      );
    }

    // Geocode các stop mới/thay đổi nếu thiếu tọa độ
    if (dto.stops) {
      const hasPickup = dto.stops.some((s) => s.type === StopType.PICKUP);
      const hasDelivery = dto.stops.some((s) => s.type === StopType.DELIVERY);
      if (!hasPickup || !hasDelivery) {
        throw new BadRequestException(
          'Đơn hàng bắt buộc phải có ít nhất 1 điểm lấy hàng (PICKUP) và 1 điểm giao hàng (DELIVERY)',
        );
      }

      for (const stop of dto.stops) {
        if (!stop.latitude || !stop.longitude) {
          const geocoded = await this.mapboxService.geocode(stop.address);
          if (geocoded.length > 0) {
            stop.latitude = geocoded[0].latitude;
            stop.longitude = geocoded[0].longitude;
          } else {
            throw new BadRequestException(
              `Không thể định vị tọa độ Mapbox cho địa chỉ: "${stop.address}"`,
            );
          }
        }
      }
    }

    const stops = dto.stops?.map((stop, index) => ({
      type: stop.type,
      sequence: stop.sequence || index + 1,
      address: stop.address,
      latitude: stop.latitude,
      longitude: stop.longitude,
      contactName: stop.contactName,
      contactPhone: stop.contactPhone,
      serviceDurationMinutes: stop.serviceDurationMinutes || 20,
    }));
    const items = dto.items?.map((item) => ({
      sku: item.sku ?? null,
      description: item.description,
      packageType: item.packageType || 'CARTON',
      quantity: item.quantity,
      weightKg: item.weightKg,
      lengthCm: item.lengthCm,
      widthCm: item.widthCm,
      heightCm: item.heightCm,
      volumeM3:
        item.volumeM3 ||
        (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000,
    }));

    return this.prisma.$transaction(async (tx) => {
      // Geocoding stays outside the transaction. Confirm and PATCH serialize here.
      await lockOrder(tx, id);
      const current = await tx.order.findUniqueOrThrow({
        where: { id },
        include: orderDetail,
      });
      assertBranchAccess(user, current.branchId);
      if (current.version !== order.version || current.status !== order.status) {
        throw orderVersionConflict();
      }

      const data: Prisma.OrderUncheckedUpdateInput = {};
      if (dto.customerId && current.customerId !== dto.customerId) {
        data.customerId = dto.customerId;
      }
      if (dto.notes !== undefined && current.notes !== dto.notes) {
        data.notes = dto.notes;
      }
      if (dto.orderedAt && current.orderedAt.getTime() !== dto.orderedAt.getTime()) {
        data.orderedAt = dto.orderedAt;
      }
      if (dto.totalAmount !== undefined) {
        const amount = new Prisma.Decimal(dto.totalAmount).toDecimalPlaces(4);
        if (!current.totalAmount.equals(amount)) {
          data.totalAmount = amount;
        }
      }

      const stopsChanged = stops !== undefined && !sameRows(current.stops, stops);
      const itemsChanged = items !== undefined && !sameRows(current.items, items);
      if (!stopsChanged && !itemsChanged && Object.keys(data).length === 0) {
        return current;
      }
      if (current.version === MAX_ORDER_VERSION) {
        throw orderVersionConflict();
      }

      if (stopsChanged) {
        await tx.orderStop.deleteMany({ where: { orderId: id } });
        await tx.orderStop.createMany({
          data: stops.map((stop) => ({ ...stop, orderId: id })),
        });
      }
      if (itemsChanged) {
        const totalWeightKg = items.reduce((total, item) => total + item.weightKg, 0);
        const totalVolumeM3 = items.reduce((total, item) => total + item.volumeM3, 0);
        const customerDraft =
          current.status === OrderStatus.DRAFT &&
          (await tx.orderEvent.findFirst({
            where: { orderId: id, ...customerDraftOrigin },
            select: { id: true },
          }));

        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.createMany({
          data: items.map((item) => ({ ...item, orderId: id })),
        });
        // Customer confirmation validates exact item totals. Keep legacy Web rounding elsewhere.
        data.totalWeightKg = customerDraft
          ? totalWeightKg
          : Math.round(totalWeightKg * 10) / 10;
        data.totalVolumeM3 = customerDraft
          ? totalVolumeM3
          : Math.round(totalVolumeM3 * 100) / 100;
        data.totalPackages = items.reduce((total, item) => total + item.quantity, 0);
      }

      return tx.order.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
        include: orderDetail,
      });
    });
  }
}
