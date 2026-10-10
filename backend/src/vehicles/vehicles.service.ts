import { Principal, branchFilter, assertPermission, tripFilter } from '../auth/access';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleStatus, LocationType } from '@prisma/client';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

const HOME_DEPOT_SUMMARY_SELECT = {
  id: true,
  code: true,
  name: true,
  address: true,
  latitude: true,
  longitude: true,
} as const;

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
        homeDepotLocation: { select: HOME_DEPOT_SUMMARY_SELECT },
      },
      orderBy: { plateNumber: 'asc' },
    });
  }

  async findOne(id: string, user: Principal) {
    const result = await this.prisma.vehicle.findFirst({
      where: { id, homeBranchId: branchFilter(user, 'vehicles.read') },
      include: {
        homeBranch: true,
        homeDepotLocation: { select: HOME_DEPOT_SUMMARY_SELECT },
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

    assertPermission(user, 'vehicles.manage', vehicle.homeBranchId);
    const targetDepotId = await this.resolveTargetHomeDepot(vehicle.homeDepotLocationId, vehicle.homeBranchId, dto.homeBranchId ?? vehicle.homeBranchId, dto.homeDepotLocationId);
    return this.prisma.vehicle.update({
      where: { id },
      data: {
        ...(dto.plateNumber ? { plateNumber: dto.plateNumber.trim() } : {}),
        ...(dto.model ? { model: dto.model.trim() } : {}),
        ...(dto.vehicleType ? { vehicleType: dto.vehicleType.trim() } : {}),
        ...(dto.homeBranchId ? { homeBranchId: dto.homeBranchId } : {}),
        homeDepotLocationId: targetDepotId,
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
        homeDepotLocation: { select: HOME_DEPOT_SUMMARY_SELECT },
      },
    });
  }

  /**
   * Kho đỗ phải là kho trung tâm đang hoạt động của chi nhánh gốc vì đây là
   * điểm xuất phát khi lập lịch. Đổi chi nhánh mà không chọn kho mới sẽ bị từ chối
   * để không giữ lại kho của chi nhánh cũ.
   */
  private async resolveTargetHomeDepot(
    currentDepotId: string | null,
    currentBranchId: string,
    targetBranchId: string,
    requestedDepotId: string | undefined,
  ): Promise<string | null> {
    if (requestedDepotId === undefined) {
      if (targetBranchId !== currentBranchId && currentDepotId) {
        throw new BadRequestException(
          'Khi điều chuyển xe sang chi nhánh khác phải chọn kho đỗ thuộc chi nhánh mới',
        );
      }
      return currentDepotId;
    }

    const depot = await this.prisma.location.findUnique({
      where: { id: requestedDepotId },
      select: { id: true, type: true, active: true, managingBranchId: true },
    });
    if (
      !depot ||
      !depot.active ||
      depot.type !== LocationType.CENTRAL_WAREHOUSE ||
      depot.managingBranchId !== targetBranchId
    ) {
      throw new BadRequestException(
        'Kho đỗ phải là kho trung tâm đang hoạt động thuộc chi nhánh gốc của xe',
      );
    }
    return depot.id;
  }
}
