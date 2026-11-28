import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LocationType, PackageStatus, StopType } from '@prisma/client';
import { branchFilter, Principal, requireBranch } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async listWarehouses(user: Principal, branchId?: string) {
    const managingBranchId = branchFilter(user, 'branches.read', branchId);
    const locations = await this.prisma.location.findMany({
      where: {
        type: LocationType.CENTRAL_WAREHOUSE,
        managingBranchId,
      },
      include: {
        managingBranch: { select: { id: true, code: true, name: true } },
        custodyPackages: {
          where: { status: PackageStatus.READY },
          orderBy: [{ returnedToHubAt: 'desc' }, { packageCode: 'asc' }],
          include: {
            orderItem: {
              select: {
                id: true,
                description: true,
                order: {
                  select: {
                    id: true,
                    orderNumber: true,
                    status: true,
                    customer: { select: { id: true, name: true, phone: true } },
                    stops: {
                      where: { type: StopType.DELIVERY },
                      select: {
                        id: true,
                        address: true,
                        latitude: true,
                        longitude: true,
                        windowStart: true,
                        windowEnd: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
    });

    return locations.map((loc) => {
      const custodyPackages = loc.custodyPackages.filter((pkg) => pkg.orderItem !== null);
      return {
        id: loc.id,
        code: loc.code,
        name: loc.name,
        address: loc.address,
        latitude: loc.latitude,
        longitude: loc.longitude,
        active: loc.active,
        type: loc.type,
        managingBranchId: loc.managingBranchId,
        managingBranch: loc.managingBranch,
        custodyPackageCount: custodyPackages.length,
        custodyTotalWeightKg: Number(
          (
            custodyPackages.reduce((sum, pkg) => sum + Number(pkg.weightG), 0) /
            1000
          ).toFixed(2),
        ),
        custodyPackages: custodyPackages.map((pkg) => ({
          id: pkg.id,
          packageCode: pkg.packageCode,
          weightKg: Number((Number(pkg.weightG) / 1000).toFixed(2)),
          lengthMm: pkg.lengthMm,
          widthMm: pkg.widthMm,
          heightMm: pkg.heightMm,
          cargoKind: pkg.cargoKind,
          returnedToHubAt: pkg.returnedToHubAt,
          deliveryAttemptCount: pkg.deliveryAttemptCount,
          description: pkg.orderItem!.description,
          orderId: pkg.orderItem!.order.id,
          orderNumber: pkg.orderItem!.order.orderNumber,
          orderStatus: pkg.orderItem!.order.status,
          customer: pkg.orderItem!.order.customer,
          deliveryStop: pkg.orderItem!.order.stops[0] ?? null,
        })),
      };
    });
  }

  async createWarehouse(user: Principal, dto: CreateWarehouseDto) {
    const branchId = requireBranch(user, 'branches.manage', dto.managingBranchId);
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true, code: true, name: true },
    });
    if (!branch) {
      throw new NotFoundException({
        code: 'BRANCH_NOT_FOUND',
        message: 'Không tìm thấy chi nhánh quản lý kho',
      });
    }

    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.location.findUnique({
      where: { code },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'WAREHOUSE_CODE_EXISTS',
        message: `Mã kho ${code} đã tồn tại`,
      });
    }

    const created = await this.prisma.location.create({
      data: {
        code,
        name: dto.name.trim(),
        type: LocationType.CENTRAL_WAREHOUSE,
        address: dto.address.trim(),
        latitude: dto.latitude,
        longitude: dto.longitude,
        managingBranchId: branch.id,
        active: dto.active ?? true,
      },
      include: {
        managingBranch: { select: { id: true, code: true, name: true } },
      },
    });

    return {
      ...created,
      custodyPackageCount: 0,
      custodyTotalWeightKg: 0,
      custodyPackages: [],
    };
  }

  async updateWarehouse(user: Principal, id: string, dto: UpdateWarehouseDto) {
    const existing = await this.prisma.location.findUnique({
      where: { id },
      include: {
        managingBranch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!existing || existing.type !== LocationType.CENTRAL_WAREHOUSE) {
      throw new NotFoundException({
        code: 'WAREHOUSE_NOT_FOUND',
        message: 'Không tìm thấy kho lưu chuyển',
      });
    }
    if (existing.managingBranchId) {
      requireBranch(user, 'branches.manage', existing.managingBranchId);
    }

    let nextBranchId = existing.managingBranchId;
    if (dto.managingBranchId && dto.managingBranchId !== existing.managingBranchId) {
      nextBranchId = requireBranch(user, 'branches.manage', dto.managingBranchId);
    }

    if (dto.active === false || (dto.managingBranchId && dto.managingBranchId !== existing.managingBranchId)) {
      const heldCount = await this.prisma.package.count({
        where: {
          custodyLocationId: id,
          status: { in: [PackageStatus.READY, PackageStatus.ALLOCATED, PackageStatus.LOADED] },
        },
      });
      if (heldCount > 0) {
        throw new ConflictException({
          code: 'WAREHOUSE_HAS_CUSTODY_CARGO',
          message: `Kho ${existing.name} đang giữ ${heldCount} kiện hàng chờ giao lại; chưa thể ngừng hoạt động hoặc chuyển chi nhánh.`,
        });
      }
    }

    const updated = await this.prisma.location.update({
      where: { id },
      data: {
        name: dto.name !== undefined ? dto.name.trim() : undefined,
        address: dto.address !== undefined ? dto.address.trim() : undefined,
        latitude: dto.latitude,
        longitude: dto.longitude,
        active: dto.active,
        managingBranchId: nextBranchId,
      },
      include: {
        managingBranch: { select: { id: true, code: true, name: true } },
      },
    });

    return updated;
  }
}
