import { Prisma } from '@prisma/client';
import { branchFilter, hasPermission, Principal } from './access';

export function customerFilter(user: Principal, branchId?: string): Prisma.CustomerWhereInput {
  const scope = branchFilter(user, 'customers.read', branchId);
  return Object.keys(scope).length ? { branches: { some: { branchId: scope, branch: { active: true } } } } : {};
}

export function canEditCustomer(user: Principal, branchIds: string[]): boolean {
  if (!hasPermission(user, 'customers.write')) return false;
  if (user.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.permissions.includes('customers.write'))) return true;
  return branchIds.length > 0 && branchIds.every(id => hasPermission(user, 'customers.write', id));
}
