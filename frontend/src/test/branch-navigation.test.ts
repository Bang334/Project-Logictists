import { describe, expect, it } from 'vitest';
import type { User } from '../types';
import { canOpenTab, defaultTab } from '../utils/navigationAccess';
import { branchRoleLabels } from '../types/accounts';

function user(role: string, permissions: string[]): User {
  return { id: 'u', username: 'u', fullName: 'User', role: 'DISPATCHER', companyScope: false, branches: [{ id: 'a', code: 'A', name: 'A' }], permissions,
    grants: [{ role, scopeType: 'BRANCH', branchId: 'a', permissions }] };
}
describe('role-based navigation', () => {
  it.each([
    ['BRANCH_DISPATCH_LEAD', ['trips.plan', 'trips.approve', 'orders.read', 'vehicles.read'], 'dispatch-manual', ['dispatch-manual', 'dispatch-auto', 'orders', 'fleet'], ['accounts', 'audit-logs']],
    ['RESOURCE_MANAGER', ['drivers.read', 'drivers.manage', 'vehicles.read', 'trips.read'], 'fleet', ['fleet', 'trips'], ['orders', 'dispatch-manual', 'dispatch-auto', 'accounts']],
    ['TRANSPORT_DISPATCHER', ['orders.read', 'orders.write', 'customers.read', 'trips.read', 'trips.publish'], 'orders', ['orders', 'customers', 'trips', 'dispatch-manual'], ['dispatch-auto', 'accounts', 'fleet']],
  ] as const)('%s opens its working page and rejects direct URLs outside its duties', (role, permissions, home, allowed, denied) => {
    const profile = user(role, [...permissions]); const can = (p: string) => profile.permissions.includes(p);
    expect(defaultTab(profile, can, 'a')).toBe(home);
    for (const page of allowed) expect(canOpenTab(profile, page, can, 'a')).toBe(true);
    for (const page of denied) expect(canOpenTab(profile, page, can, 'a')).toBe(false);
    expect(canOpenTab(profile, home, can, 'b')).toBe(false);
    expect(defaultTab(profile, () => false, 'a')).toBe('');
  });
  it('has three assignable branch roles and retires the scheduler from navigation', () => {
    expect(Object.keys(branchRoleLabels)).toHaveLength(3);
    const profile = user('ORDER_SCHEDULER', ['orders.read', 'orders.write']);
    expect(defaultTab(profile, () => true)).toBe('');
  });
  it('keeps CUSTOMER inbox and ADMIN account administration', () => {
    const customer = { ...user('CUSTOMER', []), role: 'CUSTOMER' as const };
    expect(defaultTab(customer, () => false)).toBe('delivery-appointments');
    const admin: User = { ...user('ADMIN', ['users.read']), role: 'ADMIN', companyScope: true, grants: [{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: ['users.read'] }] };
    expect(canOpenTab(admin, 'accounts', p => p === 'users.read')).toBe(true);
  });
});
