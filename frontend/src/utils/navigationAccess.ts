import { User } from '../types';
import { canManageAccounts } from '../types/accounts';

export function canOpenTab(user: User | null, tab: string, can: (permission: string) => boolean): boolean {
  if (!user) return false;
  if (tab === 'accounts') return canManageAccounts(user);
  const tms: Record<string, string> = { dashboard: 'orders.read', orders: 'orders.read', fleet: 'vehicles.read', dispatch: 'trips.plan', 'dispatch-manual': 'trips.plan', 'dispatch-auto': 'trips.plan', 'tracking-demo': 'trips.plan' };
  if (tms[tab]) return can(tms[tab]);
  if (tab === 'customer-shop') return user.role === 'CUSTOMER';
  if (['catalog', 'inventory', 'sales-orders', 'order-processing', 'pickup-ops'].includes(tab)) return user.companyScope || user.role === 'STAFF';
  if (tab === 'retail-analytics') return user.companyScope;
  return false;
}
export function defaultTab(user: User): string {
  return user.role === 'CUSTOMER' ? 'customer-shop' : user.role === 'STAFF' && !user.grants.length ? 'sales-orders' : 'dashboard';
}
