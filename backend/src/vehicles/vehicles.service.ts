import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, VehicleStatus } from '@prisma/client';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(private prisma: PrismaService) {}

  async findAll(branchId?: string, status?: VehicleStatus) {
    return this.prisma.vehicle.findMany({
      where: {
        ...(branchId ? { homeBranchId: branchId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
      },
      orderBy: { plateNumber: 'asc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        homeBranch: true,
        trips: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  async getAvailable(branchId?: string) {
    return this.prisma.vehicle.findMany({
      where: {
        status: VehicleStatus.AVAILABLE,
        ...(branchId ? { homeBranchId: branchId } : {}),
      },
      include: {
        homeBranch: true,
      },
    });
  }

  async update(
    id: string,
    dto: UpdateVehicleDto,
    user?: { role: Role; branchId?: string },
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
    });

    if (!vehicle) {
      throw new NotFoundException(`Không tìm thấy xe tải với ID ${id}`);
    }

    if (
      user &&
      user.role !== Role.ADMIN &&
      user.branchId &&
      vehicle.homeBranchId !== user.branchId
    ) {
      throw new ForbiddenException(
        'Bạn không có quyền chỉnh sửa xe thuộc chi nhánh khác',
      );
    }

    if (
      dto.homeBranchId &&
      dto.homeBranchId !== vehicle.homeBranchId &&
      user?.role !== Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Chỉ Quản trị viên (ADMIN) mới có quyền điều chuyển xe sang chi nhánh khác',
      );
    }

    return this.prisma.vehicle.update({
      where: { id },
      data: {
        ...(dto.plateNumber ? { plateNumber: dto.plateNumber.trim() } : {}),
        ...(dto.model ? { model: dto.model.trim() } : {}),
        ...(dto.vehicleType ? { vehicleType: dto.vehicleType.trim() } : {}),
        ...(dto.homeBranchId ? { homeBranchId: dto.homeBranchId } : {}),
        ...(dto.payloadCapacityKg !== undefined
          ? { payloadCapacityKg: dto.payloadCapacityKg }
          : {}),
        ...(dto.volumeCapacityM3 !== undefined
          ? { volumeCapacityM3: dto.volumeCapacityM3 }
          : {}),
        ...(dto.lengthCm !== undefined ? { lengthCm: dto.lengthCm } : {}),
        ...(dto.widthCm !== undefined ? { widthCm: dto.widthCm } : {}),
        ...(dto.heightCm !== undefined ? { heightCm: dto.heightCm } : {}),
        ...(dto.fuelConsumptionLitersPer100Km !== undefined
          ? { fuelConsumptionLitersPer100Km: dto.fuelConsumptionLitersPer100Km }
          : {}),
        ...(dto.fixedOperatingCostPerTrip !== undefined
          ? { fixedOperatingCostPerTrip: dto.fixedOperatingCostPerTrip }
          : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
      },
    });
  }
}
