import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverStatus, Role } from '@prisma/client';
import { UpdateDriverDto } from './dto/update-driver.dto';

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService) {}

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
    user?: { role: Role; branchId?: string },
  ) {
    const driver = await this.prisma.driver.findUnique({
      where: { id },
    });

    if (!driver) {
      throw new NotFoundException(`Không tìm thấy tài xế với ID ${id}`);
    }

    if (
      user &&
      user.role !== Role.ADMIN &&
      user.branchId &&
      driver.homeBranchId !== user.branchId
    ) {
      throw new ForbiddenException(
        'Bạn không có quyền chỉnh sửa tài xế thuộc chi nhánh khác',
      );
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

