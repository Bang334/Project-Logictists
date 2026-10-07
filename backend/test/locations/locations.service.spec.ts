import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LocationsService } from '../../src/locations/locations.service';

describe('LocationsService', () => {
  const findMany = jest.fn();
  const service = new LocationsService({ location: { findMany } } as unknown as PrismaService);

  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
  });

  it('cho phép admin xem toàn bộ địa điểm đang hoạt động', async () => {
    await service.findMapLocations({ id: 'admin', role: Role.ADMIN });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { active: true },
    }));
  });

  it('giới hạn dispatcher theo chi nhánh được gán', async () => {
    await service.findMapLocations({
      id: 'dispatcher',
      role: Role.DISPATCHER,
      branchId: 'branch-1',
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { active: true, managingBranchId: 'branch-1' },
    }));
  });

  it('giới hạn staff theo địa điểm làm việc', async () => {
    await service.findMapLocations({
      id: 'staff',
      role: Role.STAFF,
      locationId: 'location-1',
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { active: true, id: 'location-1' },
    }));
  });

  it('từ chối tài khoản vận hành chưa được gán phạm vi', async () => {
    await expect(service.findMapLocations({ id: 'driver', role: Role.DRIVER }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
