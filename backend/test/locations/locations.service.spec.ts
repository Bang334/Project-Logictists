import { LocationsService } from '../../src/locations/locations.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { Principal } from '../../src/auth/access';

describe('LocationsService live branch grants', () => {
  const db = { location: { findMany: jest.fn().mockResolvedValue([]) } };
  const service = new LocationsService(db as unknown as PrismaService);
  const principal = (grants: Principal['grants'], overrides: Partial<Principal> = {}): Principal => ({ id: 'user', username: 'user', fullName: 'User', sessionId: 'session', grants, ...overrides });
  beforeEach(() => jest.clearAllMocks());
  it('uses COMPANY ADMIN grant rather than account type or username', async () => {
    await service.findMapLocations(principal([{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: ['branches.read'] }]));
    expect(db.location.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true } }));
    await expect(service.findMapLocations(principal([], { role: 'ADMIN' }))).rejects.toThrow();
  });
  it.each(['DISPATCHER', 'STAFF'] as const)('uses operational branch grants for legacy account type %s', async role => {
    const user = principal([{ role: 'TRANSPORT_DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-a', permissions: ['branches.read'] }], { role, branchId: 'foreign', locationId: 'foreign-location' });
    await service.findMapLocations(user);
    expect(db.location.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { active: true, managingBranchId: { in: ['branch-a'] } } }));
    expect(db.location.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ latitude: true, longitude: true }) }));
    db.location.findMany.mockClear();
    await expect(service.findMapLocations({ ...user, selectedBranchId: 'branch-b' })).rejects.toThrow();
    expect(db.location.findMany).not.toHaveBeenCalled();
  });
  it('does not allow DRIVER or a retired role to obtain map locations using a legacy branch column', async () => {
    for (const role of ['DRIVER', 'ORDER_SCHEDULER']) {
      await expect(service.findMapLocations(principal([{ role, scopeType: 'BRANCH', branchId: 'branch-a', permissions: ['branches.read'] }], { branchId: 'branch-a' }))).rejects.toThrow();
    }
    expect(db.location.findMany).not.toHaveBeenCalled();
  });
});
