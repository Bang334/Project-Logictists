import { Principal, branchFilter, assertPermission, tripFilter } from '../auth/access';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleStatus, LocationType, Prisma } from '@prisma/client';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { flattenVehicleType } from './vehicle-capabilities';
import { assertProfileVersion, assertStatusChangeAllowed, lockResourceProfile, nextProfileTimestamp } from './resource-profile';

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
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        homeBranchId: branchFilter(user, 'vehicles.read', branchId),
        ...(status ? { status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
        homeDepotLocation: { select: HOME_DEPOT_SUMMARY_SELECT },
        vehicleTypeRecord: true,
      },
      orderBy: { plateNumber: 'asc' },
    });
    return vehicles.map(flattenVehicleType);
  }

  async findOne(id: string, user: Principal) {
    const result = await this.prisma.vehicle.findFirst({
      where: { id, homeBranchId: branchFilter(user, 'vehicles.read') },
      include: {
        homeBranch: true,
        homeDepotLocation: { select: HOME_DEPOT_SUMMARY_SELECT },
        vehicleTypeRecord: true,
        trips: {
          where: tripFilter(user),
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!result) throw new NotFoundException('Tài nguyên không tồn tại hoặc ngoài phạm vi được cấp');
    return flattenVehicleType(result);
  }

  async getAvailable(user: Principal, branchId?: string) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        status: VehicleStatus.AVAILABLE,
        homeBranchId: branchFilter(user, 'vehicles.read', branchId),
      },
      include: {
        homeBranch: true,
        vehicleTypeRecord: true,
      },
    });
    return vehicles.map(flattenVehicleType);
  }

  async findTypes() {
    return this.prisma.vehicleType.findMany({
      where: { active: true },
      orderBy: [{ payloadCapacityKg: 'asc' }, { name: 'asc' }],
    });
  }

  async update(
    id: string,
    dto: UpdateVehicleDto,
    user: Principal,
  ) {
    assertPermission(user, 'vehicles.manage');
    return this.prisma.$transaction(async tx => {
      await lockResourceProfile(tx, 'vehicle', id);
      const vehicle = await tx.vehicle.findUnique({
        where: { id },
      });

      if (!vehicle) {
        throw new NotFoundException(`Không tìm thấy xe tải với ID ${id}`);
      }

      assertPermission(user, 'vehicles.manage', vehicle.homeBranchId);
      assertProfileVersion(vehicle.updatedAt, dto.expectedUpdatedAt);
      if (dto.homeBranchId !== undefined) {
        if (dto.homeBranchId !== vehicle.homeBranchId) await assertStatusChangeAllowed(tx, 'vehicle', id);
        assertPermission(user, 'vehicles.manage', dto.homeBranchId);
        if (!await tx.branch.findFirst({ where: { id: dto.homeBranchId, active: true } })) throw new BadRequestException('Chi nhánh không tồn tại hoặc đã ngừng hoạt động');
      }
      if (dto.status !== undefined && dto.status !== vehicle.status) await assertStatusChangeAllowed(tx, 'vehicle', id);
      if (dto.vehicleTypeId !== undefined) {
        const type = await tx.vehicleType.findFirst({
          where: { id: dto.vehicleTypeId, active: true },
        });
        if (!type || ![type.payloadCapacityKg, type.lengthCm, type.widthCm, type.heightCm, type.volumeCapacityM3].every(n => Number.isFinite(n) && n > 0)) {
          throw new BadRequestException('Loại xe không tồn tại hoặc đã ngừng sử dụng');
        }
      }
      const targetDepotId = await this.resolveTargetHomeDepot(vehicle.homeDepotLocationId, vehicle.homeBranchId, dto.homeBranchId ?? vehicle.homeBranchId, dto.homeDepotLocationId, tx);
      const updated = await tx.vehicle.update({
        where: { id },
        data: {
          updatedAt: nextProfileTimestamp(vehicle.updatedAt),
          ...(dto.plateNumber ? { plateNumber: dto.plateNumber.trim().toUpperCase() } : {}),
          ...(dto.model ? { model: dto.model.trim() } : {}),
          ...(dto.vehicleTypeId ? { vehicleTypeId: dto.vehicleTypeId } : {}),
          ...(dto.homeBranchId ? { homeBranchId: dto.homeBranchId } : {}),
          homeDepotLocationId: targetDepotId,
          ...(dto.status ? { status: dto.status } : {}),
        },
        include: {
          homeBranch: {
            select: { id: true, code: true, name: true },
          },
          homeDepotLocation: { select: HOME_DEPOT_SUMMARY_SELECT },
          vehicleTypeRecord: true,
        },
      });
      await tx.auditLog.create({ data: { entityType: 'Vehicle', entityId: id, action: 'UPDATE', performedBy: user.id, actorUserId: user.id,
        changeSummary: { fields: Object.keys(dto).filter(key => key !== 'expectedUpdatedAt'), fromVersion: vehicle.updatedAt.toISOString(), toVersion: updated.updatedAt.toISOString() } } });
      return flattenVehicleType(updated);
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
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    if (requestedDepotId === undefined) {
      if (targetBranchId !== currentBranchId && currentDepotId) {
        throw new BadRequestException(
          'Khi điều chuyển xe sang chi nhánh khác phải chọn kho đỗ thuộc chi nhánh mới',
        );
      }
      return currentDepotId;
    }

    const depot = await tx.location.findUnique({
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
