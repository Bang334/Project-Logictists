import { Principal, branchFilter, assertPermission, tripFilter, hasPermission } from '../auth/access';
import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverStatus } from '@prisma/client';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { minimumLicenseDate } from '../fleet/availability';
import { assertProfileVersion, assertStatusChangeAllowed, lockResourceProfile, nextProfileTimestamp } from '../vehicles/resource-profile';
function listDriver<T extends { citizenId: string; licenseNumber: string; userId: string | null }>(row: T) {
  const { citizenId: _citizen, licenseNumber: _license, userId: _user, ...summary } = row;
  return { ...summary, eligibilityChecked: false };
}

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: Principal, branchId?: string, status?: DriverStatus) {
    const rows = await this.prisma.driver.findMany({
      where: {
        homeBranchId: branchFilter(user, 'drivers.read', branchId),
        ...(status ? { status } : {}),
      },
      include: {
        homeBranch: {
          select: { id: true, code: true, name: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });
    return rows.map(listDriver);
  }

  async findOne(id: string, user: Principal) {
    const result = await this.prisma.driver.findFirst({
      where: { id, homeBranchId: branchFilter(user, 'drivers.read') },
      include: {
        homeBranch: true,
        assignments: {
          where: { trip: tripFilter(user) },
          take: 5,
          orderBy: { createdAt: 'desc' },
          include: { trip: true },
        },
      },
    });
    if (!result) throw new NotFoundException('Tài nguyên không tồn tại hoặc ngoài phạm vi được cấp');
    return hasPermission(user, 'drivers.manage', result.homeBranchId) ? result : listDriver(result);
  }

  async getAvailable(user: Principal, branchId?: string) {
    const rows = await this.prisma.driver.findMany({
      where: {
        status: DriverStatus.AVAILABLE,
        licenseExpiry: { gte: minimumLicenseDate(new Date()) },
        homeBranchId: branchFilter(user, 'drivers.read', branchId),
      },
      include: {
        homeBranch: true,
      },
    });
    return rows.map(listDriver);
  }

  async update(
    id: string,
    dto: UpdateDriverDto,
    user: Principal,
  ) {
    assertPermission(user, 'drivers.manage');
    return this.prisma.$transaction(async tx => {
      await lockResourceProfile(tx, 'driver', id);
      const driver = await tx.driver.findUnique({
        where: { id },
      });

      if (!driver) {
        throw new NotFoundException(`Không tìm thấy tài xế với ID ${id}`);
      }

      assertPermission(user, 'drivers.manage', driver.homeBranchId);
      assertProfileVersion(driver.updatedAt, dto.expectedUpdatedAt);
      if (dto.homeBranchId !== undefined) {
        if (dto.homeBranchId !== driver.homeBranchId) await assertStatusChangeAllowed(tx, 'driver', id);
        assertPermission(user, 'drivers.manage', dto.homeBranchId);
        if (!await tx.branch.findFirst({ where: { id: dto.homeBranchId, active: true } })) throw new NotFoundException('Chi nhánh không tồn tại hoặc đã ngừng hoạt động');
      }
      if (dto.status !== undefined && dto.status !== driver.status) await assertStatusChangeAllowed(tx, 'driver', id);
      if (driver.employeeId && [dto.fullName, dto.phone, dto.citizenId, dto.homeBranchId].some(value => value !== undefined)) {
        await tx.$queryRaw`SELECT id FROM employees WHERE id = ${driver.employeeId} FOR UPDATE`;
        const employee = await tx.employee.findUniqueOrThrow({ where: { id: driver.employeeId } });
        if ((dto.fullName !== undefined && employee.fullName !== driver.fullName) ||
            (dto.phone !== undefined && employee.phone !== driver.phone) ||
            (dto.citizenId !== undefined && employee.citizenId !== driver.citizenId) ||
            (dto.homeBranchId !== undefined && employee.branchId !== driver.homeBranchId)) {
          throw new ConflictException({ code: 'EMPLOYEE_PROFILE_CONFLICT', message: 'Hồ sơ nhân viên và tài xế chưa đồng nhất. Cần đối chiếu Employee trước khi sửa.' });
        }
        await tx.employee.update({ where: { id: driver.employeeId }, data: {
          ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.phone ? { phone: dto.phone.trim() } : {}),
          ...(dto.citizenId ? { citizenId: dto.citizenId.trim() } : {}),
          ...(dto.homeBranchId ? { branchId: dto.homeBranchId } : {}),
          version: { increment: 1 },
        } });
      }
      const updated = await tx.driver.update({
        where: { id },
        data: {
          updatedAt: nextProfileTimestamp(driver.updatedAt),
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
      await tx.auditLog.create({ data: { entityType: 'Driver', entityId: id, action: 'UPDATE', performedBy: user.id, actorUserId: user.id,
        changeSummary: { fields: Object.keys(dto).filter(key => key !== 'expectedUpdatedAt'), fromVersion: driver.updatedAt.toISOString(), toVersion: updated.updatedAt.toISOString() } } });
      return updated;
    });
  }
}

