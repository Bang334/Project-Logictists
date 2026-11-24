import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverStatus, Role } from '@prisma/client';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { assertBranchAccess } from '../auth/branch-scope';
import { driverTripDateRange } from '../trips/dto/driver-trip-date-range';
import { driverActivityQuery, type DriverActivityRow } from './driver-activity.query';
import type { QueryDriverActivityDto } from './dto/query-driver-activity.dto';

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService) {}

  async getActivitySummary(userId: string, query: QueryDriverActivityDto) {
    const { start, end } = driverTripDateRange(query.from, query.to, 93);
    const driver = await this.prisma.driver.findUnique({
      where: { userId }, select: { homeBranch: { select: { timezone: true } } },
    });
    if (!driver) {
      throw new ConflictException({
        errorCode: 'DRIVER_PROFILE_NOT_FOUND',
        message: 'Tài khoản DRIVER chưa được liên kết với hồ sơ tài xế',
      });
    }
    let timeZone = driver.homeBranch.timezone;
    try { new Intl.DateTimeFormat('vi-VN', { timeZone }); }
    catch { timeZone = 'Asia/Ho_Chi_Minh'; }

    const [row] = await this.prisma.$queryRaw<DriverActivityRow[]>(driverActivityQuery(userId, start, end));
    const hasData = row.completedTripCount + row.processedStopCount + row.depotStopCount > 0;
    const status = row.hasEvidenceGap ? 'PARTIAL' : hasData ? 'COMPLETE' : 'NO_DATA';
    return {
      range: { from: start.toISOString(), to: end.toISOString() },
      timeZone,
      asOf: row.asOf,
      completedTripCount: status === 'NO_DATA' ? null : row.completedTripCount,
      processedStopCount: status === 'NO_DATA' ? null : row.processedStopCount,
      depotStopCount: status === 'NO_DATA' ? null : row.depotStopCount,
      deliveries: status === 'NO_DATA' ? null : {
        success: row.success, partial: row.partial, failed: row.failed, unclassified: row.unclassified,
      },
      coverage: { status },
    };
  }

  async getSelfProfile(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      select: {
        id: true,
        fullName: true,
        phone: true,
        status: true,
        homeBranch: { select: { id: true, code: true, name: true, timezone: true } },
        licenses: {
          take: 2,
          select: { category: true, validUntil: true, verificationStatus: true },
        },
      },
    });
    if (!driver) {
      throw new ConflictException({
        errorCode: 'DRIVER_PROFILE_NOT_FOUND',
        message: 'Tài khoản DRIVER chưa được liên kết với hồ sơ tài xế',
      });
    }

    const { phone, licenses, ...profile } = driver;
    // A single record is unambiguous. Legacy fields carry no verification status.
    const license = licenses.length === 1 ? licenses[0] : null;
    return {
      ...profile,
      operationalPhone: phone?.trim() || null,
      license: license && {
        ...license,
        validUntil: license.validUntil.toISOString().slice(0, 10),
      },
    };
  }

  async findAll(branchId?: string, status?: DriverStatus) {
    return this.prisma.driver.findMany({
      where: {
        ...(branchId ? { homeBranchId: branchId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.driver.findUnique({
      where: { id },
      include: {
        homeBranch: true,
        assignments: {
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { trip: true },
        },
      },
    });
  }

  async findOneAuthorized(
    id: string,
    user: { role: Role; branchId?: string | null },
  ) {
    const driver = await this.findOne(id);
    if (!driver) {
      throw new NotFoundException(`Không tìm thấy tài xế với ID ${id}`);
    }
    assertBranchAccess(user, driver.homeBranchId);
    return driver;
  }

  async getAvailable(branchId?: string) {
    return this.prisma.driver.findMany({
      where: {
        status: DriverStatus.AVAILABLE,
        licenseExpiry: { gt: new Date() }, // Bằng lái còn hạn
        ...(branchId ? { homeBranchId: branchId } : {}),
      },
      include: {
        homeBranch: true,
      },
    });
  }

  async update(
    id: string,
    dto: UpdateDriverDto,
    user?: { role: Role; branchId?: string | null },
  ) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
    });

    if (!driver) {
      throw new NotFoundException(`Không tìm thấy tài xế với ID ${id}`);
    }

    if (user) {
      assertBranchAccess(user, driver.homeBranchId);
    }

    if (
      dto.homeBranchId &&
      dto.homeBranchId !== driver.homeBranchId &&
      user?.role !== Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Chỉ Quản trị viên (ADMIN) mới có quyền điều chuyển tài xế sang chi nhánh khác',
      );
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
      },
    });
  }
}

