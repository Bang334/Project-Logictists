import { Principal, requireBranch } from './access';
export function resolveBranchScope(user: Principal, requestedBranchId?: string): string {
  return requireBranch(user, 'trips.plan', requestedBranchId);
}
