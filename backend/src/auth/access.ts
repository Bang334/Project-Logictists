import { BadRequestException, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

export const PERMISSIONS = [
  'branches.read', 'branches.manage', 'vehicles.read', 'vehicles.manage',
  'drivers.read', 'drivers.manage', 'customers.read', 'orders.read',
  'orders.write', 'trips.read', 'trips.plan', 'trips.publish',
  'users.read', 'users.create', 'users.lock',
] as const;
export const DRIVER_PERMISSIONS = ['driver.profile.read', 'driver.assignments.read', 'driver.assignments.respond', 'driver.trips.execute'] as const;
export type PermissionCode = typeof PERMISSIONS[number] | typeof DRIVER_PERMISSIONS[number];
export const DISPATCHER_PERMISSIONS = PERMISSIONS.filter(p => !p.endsWith('.manage') && !p.startsWith('users.'));
export const RequirePermission = (permission: PermissionCode | 'authenticated') => SetMetadata('permission', permission);
export const Public = () => SetMetadata('public', true);
export interface AccessGrant {
  role: string;
  scopeType: 'COMPANY' | 'BRANCH' | 'LOCATION';
  branchId: string | null;
  permissions: string[];
}
export interface Principal {
  id: string;
  username: string;
  fullName: string;
  sessionId: string;
  role?: Role;
  branchId?: string | null;
  locationId?: string | null;
  phone?: string | null;
  email?: string | null;
  grants: AccessGrant[];
  selectedBranchId?: string;
}
export interface AuthRequest {
  user: Principal;
  headers: Record<string, string | string[] | undefined>;
}
export function hasPermission(user: Principal, permission: PermissionCode, branchId?: string | null): boolean {
  if (permission.startsWith('driver.')) return user.grants.some(g => g.role === 'DRIVER' && g.scopeType === 'BRANCH' && !!g.branchId && (!branchId || g.branchId === branchId) && g.permissions.includes(permission));
  // Account administration is a closed capability, even if a dispatcher is accidentally granted it.
  // Principal.username and grants are loaded from PostgreSQL by SessionGuard on every request.
  if (permission.startsWith('users.')) return user.username === 'demo_auth_admin' && user.grants.some(g =>
    g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.branchId === null && g.permissions.includes(permission));
  return user.grants.some(g => g.permissions.includes(permission) && (
    (g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.branchId === null) ||
    (g.role === 'DISPATCHER' && !permission.endsWith('.manage') && g.scopeType === 'BRANCH' && !!g.branchId && (!branchId || g.branchId === branchId))
  ));
}
export function assertPermission(user: Principal, permission: PermissionCode, branchId?: string | null) {
  if (!hasPermission(user, permission, branchId)) {
    throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: 'Bạn không có quyền thực hiện thao tác trong phạm vi này' });
  }
}
export function branchFilter(user: Principal, permission: PermissionCode, requested?: string): Prisma.StringFilter {
  assertPermission(user, permission);
  const selected = requested && requested !== 'ALL' ? requested : user.selectedBranchId;
  if (selected) {
    assertPermission(user, permission, selected);
    return { equals: selected };
  }
  if (user.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.permissions.includes(permission))) return {};
  return { in: [...new Set(user.grants.filter(g => g.role === 'DISPATCHER' && g.scopeType === 'BRANCH' && g.permissions.includes(permission)).flatMap(g => g.branchId ? [g.branchId] : []))] };
}
export function requireBranch(user: Principal, permission: PermissionCode, requested?: string): string {
  const filter = branchFilter(user, permission, requested);
  if (typeof filter.equals === 'string') return filter.equals;
  if (Array.isArray(filter.in) && filter.in.length === 1) return filter.in[0];
  throw new BadRequestException({ code: 'BRANCH_REQUIRED', message: 'Hãy chọn chi nhánh để tiếp tục' });
}
// All included relations are constrained too: an old mixed-branch Trip must not leak its manifest.
export function tripFilter(user: Principal, permission: PermissionCode = 'trips.read', requested?: string): Prisma.TripWhereInput {
  const scope = branchFilter(user, permission, requested);
  if (Object.keys(scope).length === 0) return {};
  const resources = branchFilter({ ...user, selectedBranchId: undefined }, permission);
  return {
    managingBranchId: scope,
    vehicle: { homeBranchId: resources },
    assignments: { every: { driver: { homeBranchId: resources } } },
    allocations: { every: { orderItem: { order: { branchId: resources } } } },
    stops: { every: { tasks: { every: { OR: [{ allocation: { orderItem: { order: { branchId: resources } } } }, { allocationId: null, order: { branchId: resources } }] } } } },
  };
}
