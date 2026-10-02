import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { LateDeliveryPenaltyMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Injectable()
export class BranchesService {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
  ) {}

  async findAll() {
    return this.prisma.branch.findMany({
      where: { active: true },
      include: {
        _count: {
          select: { vehicles: true, drivers: true },
        },
      },
      orderBy: { code: 'asc' },
    });
  }

  async findOne(id: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
      include: {
        vehicles: true,
        drivers: true,
      },
    });

    if (!branch) {
      throw new NotFoundException(`Không tìm thấy chi nhánh với ID ${id}`);
    }

    return branch;
  }

  async update(id: string, dto: UpdateBranchDto) {
    const branch = await this.prisma.branch.findUnique({
      where: { id },
    });

    if (!branch) {
      throw new NotFoundException(`Không tìm thấy chi nhánh với ID ${id}`);
    }

    const penaltyMode = dto.lateDeliveryPenaltyMode ?? branch.lateDeliveryPenaltyMode;
    const penaltyValue = dto.lateDeliveryPenaltyValue ?? Number(branch.lateDeliveryPenaltyValue);
    if (
      penaltyMode === LateDeliveryPenaltyMode.PERCENT_ORDER_VALUE_PER_DAY &&
      penaltyValue > 100
    ) {
      throw new BadRequestException('Mức phạt phần trăm không được vượt quá 100% giá trị đơn mỗi ngày');
    }

    let latitude = dto.latitude;
    let longitude = dto.longitude;

    // Nếu có cập nhật địa chỉ nhưng chưa có tọa độ GPS, tự động giải mã qua Mapbox
    if (dto.address && (latitude === undefined || longitude === undefined || latitude === 0 || longitude === 0)) {
      const geoResults = await this.mapboxService.geocode(dto.address);
      if (geoResults.length > 0) {
        latitude = geoResults[0].latitude;
        longitude = geoResults[0].longitude;
      } else {
        throw new BadRequestException(`Không thể định vị tọa độ Mapbox cho địa chỉ chi nhánh: "${dto.address}"`);
      }
    }

    return this.prisma.branch.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.address ? { address: dto.address } : {}),
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(dto.deliveryGraceDays !== undefined
          ? { deliveryGraceDays: dto.deliveryGraceDays }
          : {}),
        ...(dto.lateDeliveryPenaltyMode !== undefined
          ? { lateDeliveryPenaltyMode: dto.lateDeliveryPenaltyMode }
          : {}),
        ...(dto.lateDeliveryPenaltyValue !== undefined
          ? { lateDeliveryPenaltyValue: dto.lateDeliveryPenaltyValue }
          : {}),
      },
      include: {
        _count: {
          select: { vehicles: true, drivers: true },
        },
      },
    });
  }
}
