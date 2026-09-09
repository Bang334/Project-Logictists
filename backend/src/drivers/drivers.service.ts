import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DriverStatus } from '@prisma/client';

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
}
