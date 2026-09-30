import { Principal, branchFilter, assertPermission, tripFilter } from '../auth/access';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverStatus } from '@prisma/client';
import { UpdateDriverDto } from './dto/update-driver.dto';

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
      },
      orderBy: { fullName: 'asc' },
    });
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

