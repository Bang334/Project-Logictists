import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, StopType } from '@prisma/client';
import { CreateOrderDto } from './dto/create-order.dto';
import { MapboxService } from '../mapbox/mapbox.service';

@Injectable()
export class OrdersService {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
  ) {}

  async findAll(status?: OrderStatus, customerId?: string) {
    return this.prisma.order.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(customerId ? { customerId } : {}),
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

  async getAvailableForDispatch() {
    return this.prisma.order.findMany({
      where: {
        status: OrderStatus.CONFIRMED,
      },
      include: {
        customer: { select: { id: true, code: true, name: true } },
        stops: { orderBy: { sequence: 'asc' } },
        items: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(dto: CreateOrderDto) {
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
      totalVolumeM3 += item.volumeM3 || (item.lengthCm * item.widthCm * item.heightCm) / 1000000;
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
        status: OrderStatus.CONFIRMED,
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
            windowStart: s.windowStart ? new Date(s.windowStart) : null,
            windowEnd: s.windowEnd ? new Date(s.windowEnd) : null,
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
            volumeM3: i.volumeM3 || (i.lengthCm * i.widthCm * i.heightCm) / 1000000,
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
}
