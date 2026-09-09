import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleStatus } from '@prisma/client';

@Injectable()
export class VehiclesService {
  constructor(private prisma: PrismaService) {}

  async findAll(branchId?: string, status?: VehicleStatus) {
    return this.prisma.vehicle.findMany({
      where: {
        ...(branchId ? { homeBranchId: branchId } : {}),
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

  async findOne(id: string) {
    return this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        homeBranch: true,
        trips: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  async getAvailable(branchId?: string) {
    return this.prisma.vehicle.findMany({
      where: {
        status: VehicleStatus.AVAILABLE,
        ...(branchId ? { homeBranchId: branchId } : {}),
      },
      include: {
        homeBranch: true,
      },
    });
  }
}
