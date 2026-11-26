import { BadRequestException, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

export const PERMISSIONS = [
  'branches.read', 'branches.manage', 'vehicles.read', 'vehicles.manage',
  'drivers.read', 'drivers.manage', 'customers.read', 'customers.write', 'customers.manage', 'orders.read',
  'orders.write', 'trips.read', 'trips.plan', 'trips.approve', 'trips.publish',
  'users.read', 'users.create', 'users.lock',
  'settings.read', 'settings.manage',
] as const;
export const DRIVER_PERMISSIONS = ['driver.profile.read', 'driver.assignments.read', 'driver.assignments.respond', 'driver.trips.execute'] as const;
export const BRANCH_WEB_ROLES = ['BRANCH_DISPATCH_LEAD', 'RESOURCE_MANAGER', 'TRANSPORT_DISPATCHER'] as const;
export function isBranchWebRole(role: string): role is typeof BRANCH_WEB_ROLES[number] {
  return BRANCH_WEB_ROLES.some(code => code === role);
}
export type PermissionCode = typeof PERMISSIONS[number] | typeof DRIVER_PERMISSIONS[number];
export const DISPATCHER_PERMISSIONS = PERMISSIONS.filter(p => !p.endsWith('.manage') && !p.startsWith('users.') && p !== 'trips.approve');
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
// Database grants can remove capabilities. They cannot exceed the approved role policy.
export const BRANCH_ROLE_PERMISSIONS: Record<typeof BRANCH_WEB_ROLES[number], readonly PermissionCode[]> = {
  BRANCH_DISPATCH_LEAD: ['branches.read', 'vehicles.read', 'drivers.read', 'customers.read', 'orders.read', 'trips.read', 'trips.plan', 'trips.approve', 'settings.read'],
  RESOURCE_MANAGER: ['branches.read', 'vehicles.read', 'vehicles.manage', 'drivers.read', 'drivers.manage', 'trips.read'],
  TRANSPORT_DISPATCHER: ['branches.read', 'vehicles.read', 'drivers.read', 'customers.read', 'orders.read', 'orders.write', 'trips.read', 'trips.publish'],
};
export function grantAllows(grant: AccessGrant, permission: string): boolean {
  if (!grant.permissions.includes(permission)) return false;
  if (grant.role === 'ADMIN') return grant.scopeType === 'COMPANY' && grant.branchId === null && !permission.startsWith('driver.') && permission !== 'trips.approve' && permission !== 'trips.publish';
  if (grant.role === 'DRIVER') return grant.scopeType === 'BRANCH' && !!grant.branchId && DRIVER_PERMISSIONS.some(code => code === permission);
  return isBranchWebRole(grant.role) && grant.scopeType === 'BRANCH' && !!grant.branchId &&
    BRANCH_ROLE_PERMISSIONS[grant.role].some(code => code === permission);
}
export function hasPermission(user: Principal, permission: PermissionCode, branchId?: string | null): boolean {
  if (branchId && user.selectedBranchId && branchId !== user.selectedBranchId) return false;
  return user.grants.some(g => grantAllows(g, permission) &&
    (g.scopeType === 'COMPANY' || (!branchId || g.branchId === branchId)));
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
  return { in: [...new Set(user.grants.filter(g => isBranchWebRole(g.role) && g.branchId && hasPermission({ ...user, grants: [g] }, permission, g.branchId)).flatMap(g => g.branchId ? [g.branchId] : []))] };
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
