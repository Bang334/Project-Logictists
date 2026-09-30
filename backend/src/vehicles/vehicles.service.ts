import { Principal, branchFilter, assertPermission, tripFilter } from '../auth/access';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleStatus } from '@prisma/client';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Injectable()
export class VehiclesService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: Principal, branchId?: string, status?: VehicleStatus) {
    return this.prisma.vehicle.findMany({
      where: {
        homeBranchId: branchFilter(user, 'vehicles.read', branchId),
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

  async findOne(id: string, user: Principal) {
    const result = await this.prisma.vehicle.findFirst({
      where: { id, homeBranchId: branchFilter(user, 'vehicles.read') },
      include: {
        homeBranch: true,
        trips: {
          where: tripFilter(user),
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!result) throw new NotFoundException('Tài nguyên không tồn tại hoặc ngoài phạm vi được cấp');
    return result;
  }

  async getAvailable(user: Principal, branchId?: string) {
    return this.prisma.vehicle.findMany({
      where: {
        status: VehicleStatus.AVAILABLE,
        homeBranchId: branchFilter(user, 'vehicles.read', branchId),
      },
      include: {
        homeBranch: true,
      },
    });
  }

  async update(
    id: string,
    dto: UpdateVehicleDto,
    user: Principal,
  ) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
    });

    if (!vehicle) {
      throw new NotFoundException(`Không tìm thấy xe tải với ID ${id}`);
    }

    assertPermission(user, 'vehicles.manage');
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
