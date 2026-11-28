import { Principal, branchFilter, assertPermission, tripFilter } from '../auth/access';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverStatus, LocationType } from '@prisma/client';
import { UpdateDriverDto } from './dto/update-driver.dto';

const DRIVER_HOME_LOCATION_SELECT = {
  id: true,
  code: true,
  name: true,
  provinceCode: true,
  provinceName: true,
  warehouseRole: true,
} as const;

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: Principal, branchId?: string, status?: DriverStatus) {
    return this.prisma.driver.findMany({
      where: {
        homeBranchId: branchFilter(user, 'drivers.read', branchId),
        ...(status ? { status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
        homeLocation: { select: DRIVER_HOME_LOCATION_SELECT },
      },
      orderBy: { fullName: 'asc' },
    });
  }

  async findOne(id: string, user: Principal) {
    const result = await this.prisma.driver.findFirst({
      where: { id, homeBranchId: branchFilter(user, 'drivers.read') },
      include: {
        homeBranch: true,
        homeLocation: { select: DRIVER_HOME_LOCATION_SELECT },
        assignments: {
          where: { trip: tripFilter(user) },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { trip: true },
        },
      },
    });
    if (!result) throw new NotFoundException('Tài nguyên không tồn tại hoặc ngoài phạm vi được cấp');
    return result;
  }

  async getAvailable(user: Principal, branchId?: string) {
    return this.prisma.driver.findMany({
      where: {
        status: DriverStatus.AVAILABLE,
        licenseExpiry: { gt: new Date() }, // Bằng lái còn hạn
        homeBranchId: branchFilter(user, 'drivers.read', branchId),
      },
      include: {
        homeBranch: true,
        homeLocation: { select: DRIVER_HOME_LOCATION_SELECT },
      },
    });
  }

  async update(
    id: string,
    dto: UpdateDriverDto,
    user: Principal,
  ) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
    });

    if (!driver) {
      throw new NotFoundException(`Không tìm thấy tài xế với ID ${id}`);
    }

    assertPermission(user, 'drivers.manage');
    let resolvedHomeProvince =
      dto.homeProvinceCode !== undefined
        ? dto.homeProvinceCode?.trim().toUpperCase() || null
        : undefined;
    if (dto.homeLocationId !== undefined && dto.homeLocationId !== null) {
      const homeLoc = await this.prisma.location.findUnique({
        where: { id: dto.homeLocationId },
        select: { id: true, type: true, active: true, provinceCode: true },
      });
      if (!homeLoc || !homeLoc.active || homeLoc.type !== LocationType.CENTRAL_WAREHOUSE) {
        throw new BadRequestException(
          'Kho đỗ gốc của tài xế phải là kho trung tâm đang hoạt động',
        );
      }
      if (resolvedHomeProvince === undefined && homeLoc.provinceCode) {
        resolvedHomeProvince = homeLoc.provinceCode.trim().toUpperCase();
      }
    }
    return this.prisma.driver.update({
      where: { id },
      data: {
        ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}),
        ...(dto.phone ? { phone: dto.phone.trim() } : {}),
        ...(dto.citizenId ? { citizenId: dto.citizenId.trim() } : {}),
        ...(dto.licenseNumber ? { licenseNumber: dto.licenseNumber.trim() } : {}),
        ...(dto.licenseClass ? { licenseClass: dto.licenseClass.trim() } : {}),
        ...(dto.licenseExpiry ? { licenseExpiry: new Date(dto.licenseExpiry) } : {}),
        ...(dto.homeBranchId ? { homeBranchId: dto.homeBranchId } : {}),
        ...(dto.homeLocationId !== undefined ? { homeLocationId: dto.homeLocationId } : {}),
        ...(resolvedHomeProvince !== undefined ? { homeProvinceCode: resolvedHomeProvince } : {}),
        ...(dto.strictHomeLocation !== undefined
          ? { strictHomeLocation: dto.strictHomeLocation }
          : {}),
        ...(dto.fixedSalaryMonthly !== undefined
          ? { fixedSalaryMonthly: dto.fixedSalaryMonthly }
          : {}),
        ...(dto.tripBasePay !== undefined
          ? { tripBasePay: dto.tripBasePay }
          : {}),
        ...(dto.perKmPay !== undefined
          ? { perKmPay: dto.perKmPay }
          : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
        homeLocation: { select: DRIVER_HOME_LOCATION_SELECT },
      },
    });
  }
}

