import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { AuthenticatedUser } from '../auth/branch-scope';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findMapLocations(user: AuthenticatedUser) {
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

  private resolveScope(user: AuthenticatedUser): Prisma.LocationWhereInput {
    // Session principals carry live grants; a legacy branch column cannot widen TMS scope.
    if (user.grants && user.role !== Role.STAFF) {
      const grants = user.grants.filter(grant => grant.permissions.includes('branches.read'));
      if (grants.some(grant => grant.scopeType === 'COMPANY')) return {};
      const ids = grants.flatMap(grant => grant.scopeType === 'BRANCH' && grant.branchId ? [grant.branchId] : []);
      if (!ids.length) throw new ForbiddenException('No active location branch scope');
      return { managingBranchId: { in: ids } };
    }
    if (user.role === Role.ADMIN) return {};
    if (user.role === Role.STAFF && user.locationId) return { id: user.locationId };
    if ((user.role === Role.DISPATCHER || user.role === Role.DRIVER) && user.branchId) {
      return { managingBranchId: user.branchId };
    }
    throw new ForbiddenException('Tài khoản chưa được gán phạm vi địa điểm');
  }
}
