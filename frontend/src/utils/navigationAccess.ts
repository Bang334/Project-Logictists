import { User } from '../types';
import { canReadAudit } from '../types/audit';
import { canManageAccounts } from '../types/accounts';

const branchPages: Record<string, readonly string[]> = {
  BRANCH_DISPATCH_LEAD: ['dashboard', 'orders', 'dispatch-manual', 'dispatch-auto', 'dispatch', 'trips', 'fleet'],
  RESOURCE_MANAGER: ['fleet'],
  TRANSPORT_DISPATCHER: ['dispatch-manual', 'dispatch', 'trips'],
  ORDER_SCHEDULER: ['orders', 'customers'],
};

export function canOpenTab(user: User | null, tab: string, can: (permission: string) => boolean, branchId?: string): boolean {
  if (!user) return false;
  if (user.role === 'CUSTOMER') return tab === 'customer-shop';
  if (!user.companyScope && !user.grants.some(grant =>
    grant.scopeType === 'BRANCH' && (!branchId || grant.branchId === branchId) &&
    branchPages[grant.role]?.includes(tab))) return false;
  if (tab === 'audit-logs') return canReadAudit(user);
  if (tab === 'branch-detail') return can('branches.read');
  if (tab === 'accounts') return canManageAccounts(user);
  if (tab === 'customers') return can('customers.read');
  if (tab === 'trips') return can('trips.read');
  if (tab === 'dashboard') return ['orders.read', 'trips.read', 'vehicles.read', 'drivers.read'].some(can);
  if (tab === 'fleet') return can('vehicles.read') || can('drivers.read');
  if (tab === 'dispatch' || tab === 'dispatch-manual') return can('trips.plan') || can('trips.publish');
  const tms: Record<string, string> = { orders: 'orders.read', 'dispatch-auto': 'trips.plan', 'tracking-demo': 'trips.plan' };
  if (tms[tab]) return can(tms[tab]);
  if (['catalog', 'inventory', 'sales-orders', 'order-processing', 'pickup-ops'].includes(tab)) return user.companyScope;
  if (tab === 'retail-analytics') return user.companyScope;
  return false;
}
export function defaultTab(user: User, can: (permission: string) => boolean, branchId?: string): string {
  return ['customer-shop', 'dashboard', 'dispatch-manual', 'fleet', 'orders', 'trips', 'accounts']
    .find(tab => canOpenTab(user, tab, can, branchId)) ?? '';
}
