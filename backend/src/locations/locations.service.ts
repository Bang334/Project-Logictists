import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Principal, branchFilter } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findMapLocations(user: Principal) {
    const scope = this.resolveScope(user);
    return this.prisma.location.findMany({
      where: { active: true, ...scope },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        managingBranchId: true,
        address: true,
        latitude: true,
        longitude: true,
        capabilities: true,
        totalHoldingSlots: true,
        availableHoldingSlots: true,
      },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
    });
  }

  private resolveScope(user: Principal): Prisma.LocationWhereInput {
    const scope = branchFilter(user, 'branches.read');
    return Object.keys(scope).length ? { managingBranchId: scope } : {};
  }
}
