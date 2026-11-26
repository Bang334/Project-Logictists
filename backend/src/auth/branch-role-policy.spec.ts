import { branchFilter, BRANCH_ROLE_PERMISSIONS, hasPermission, PERMISSIONS, Principal } from './access';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserDto } from '../users/users.dto';

function principal(role: string): Principal {
  return { id: 'user', username: 'user', fullName: 'User', sessionId: 'session',
    grants: [{ role, scopeType: 'BRANCH', branchId: 'branch-a', permissions: [...PERMISSIONS] }] };
}
describe('three branch roles', () => {
  it('keeps planning/approval with the lead, order processing/publishing with transport, resource writes with the manager', () => {
    const lead = principal('BRANCH_DISPATCH_LEAD'), transport = principal('TRANSPORT_DISPATCHER'), resource = principal('RESOURCE_MANAGER');
    for (const permission of ['trips.plan', 'trips.approve'] as const) {
      expect(hasPermission(lead, permission, 'branch-a')).toBe(true);
      expect(hasPermission(transport, permission, 'branch-a')).toBe(false);
      expect(hasPermission(resource, permission, 'branch-a')).toBe(false);
    }
    expect(hasPermission(transport, 'orders.write', 'branch-a')).toBe(true);
    expect(hasPermission(transport, 'trips.publish', 'branch-a')).toBe(true);
    expect(hasPermission(lead, 'orders.write', 'branch-a')).toBe(false);
    expect(hasPermission(lead, 'trips.publish', 'branch-a')).toBe(false);
    for (const permission of ['drivers.manage', 'vehicles.manage'] as const) {
      expect(hasPermission(resource, permission, 'branch-a')).toBe(true);
      expect(hasPermission(lead, permission, 'branch-a')).toBe(false);
      expect(hasPermission(transport, permission, 'branch-a')).toBe(false);
    }
  });
  it.each(Object.keys(BRANCH_ROLE_PERMISSIONS))('rejects injected admin capabilities and branch escapes for %s', role => {
    const user = principal(role);
    for (const permission of ['users.create', 'branches.manage', 'settings.manage'] as const) expect(hasPermission(user, permission)).toBe(false);
    expect(hasPermission(user, 'branches.read', 'branch-b')).toBe(false);
    expect(() => branchFilter(user, 'branches.read', 'branch-b')).toThrow();
    expect(branchFilter(user, 'branches.read')).toEqual({ in: ['branch-a'] });
    expect(hasPermission({ ...user, selectedBranchId: 'branch-b' }, 'branches.read', 'branch-a')).toBe(false);
    expect(hasPermission({ ...user, grants: user.grants.map(g => ({ ...g, permissions: [] })) }, 'branches.read')).toBe(false);
  });
  it('rejects retired scheduler even if its stored grant still contains every permission', () => {
    for (const permission of PERMISSIONS) expect(hasPermission(principal('ORDER_SCHEDULER'), permission)).toBe(false);
  });
  it('preserves explicit DRIVER capabilities and does not turn CUSTOMER into a web operator', () => {
    const driver = { ...principal('DRIVER'), grants: [{ role: 'DRIVER', scopeType: 'BRANCH' as const, branchId: 'branch-a', permissions: ['driver.profile.read', 'driver.trips.execute', ...PERMISSIONS] }] };
    expect(hasPermission(driver, 'driver.profile.read', 'branch-a')).toBe(true);
    expect(hasPermission(driver, 'driver.trips.execute', 'branch-a')).toBe(true);
    expect(hasPermission(driver, 'driver.profile.read', 'branch-b')).toBe(false);
    expect(hasPermission(driver, 'orders.write')).toBe(false);
    expect(hasPermission(principal('CUSTOMER'), 'orders.read')).toBe(false);
  });
  it('allows only three operational roles and DRIVER when creating an account', async () => {
    const input = { username: 'user', fullName: 'User', password: 'test-password-12345', branchIds: ['00000000-0000-4000-8000-000000000001'] };
    for (const roleCode of [...Object.keys(BRANCH_ROLE_PERMISSIONS), 'DRIVER']) expect(await validate(plainToInstance(CreateUserDto, { ...input, roleCode }))).toHaveLength(0);
    for (const roleCode of ['ORDER_SCHEDULER', 'DISPATCHER', 'ADMIN']) expect((await validate(plainToInstance(CreateUserDto, { ...input, roleCode }))).some(e => e.property === 'roleCode')).toBe(true);
  });
});
