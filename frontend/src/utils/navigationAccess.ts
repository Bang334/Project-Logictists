import { User } from '../types';
import { canManageAccounts } from '../types/accounts';

export function canOpenTab(user: User | null, tab: string, can: (permission: string) => boolean): boolean {
  if (!user) return false;
  if (tab === 'accounts') return canManageAccounts(user);
  const tms: Record<string, string> = { dashboard: 'orders.read', orders: 'orders.read', fleet: 'vehicles.read', dispatch: 'trips.plan', 'dispatch-manual': 'trips.plan', 'dispatch-auto': 'trips.plan', 'tracking-demo': 'trips.plan' };
  if (tms[tab]) return can(tms[tab]);
  if (tab === 'delivery-appointments') return user.role === 'CUSTOMER';
  return false;
}
export function defaultTab(user: User): string {
  return user.role === 'CUSTOMER' ? 'delivery-appointments' : 'dashboard';
}
