import { User } from './index';

export function canManageAccounts(user: User | null, permission = 'users.read'): boolean {
  return !!user && user.username === 'demo_auth_admin' && user.grants.some(g =>
    g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.branchId === null && g.permissions.includes(permission));
}
export interface Account {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  createdAt: string;
  roleScopes: Array<{ scopeType: 'BRANCH' | 'COMPANY'; role: { code: string; name: string }; branch: { id: string; code: string; name: string } | null }>;
}
export interface AccountList { items: Account[]; total: number; page: number; pageSize: number }
export interface AccountQuery { page: number; pageSize: number; search?: string; status?: 'active' | 'locked'; branchId?: string }
export interface CreateAccount { username: string; fullName: string; password: string; roleCode: 'DISPATCHER'; branchIds: string[] }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }
export function parseAccount(value: unknown): Account {
  const isAccount = (value: unknown): value is Account => {
    if (!record(value) || typeof value.id !== 'string' || typeof value.username !== 'string' || typeof value.fullName !== 'string'
      || typeof value.active !== 'boolean' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || !Array.isArray(value.roleScopes) || !value.roleScopes.every(s => record(s) && ['BRANCH', 'COMPANY'].includes(String(s.scopeType))
        && record(s.role) && typeof s.role.code === 'string' && typeof s.role.name === 'string'
        && (s.branch === null || (record(s.branch) && typeof s.branch.id === 'string' && typeof s.branch.code === 'string' && typeof s.branch.name === 'string')))) {
      return false;
    }
    return true;
  };
  if (!isAccount(value)) throw new Error('Phản hồi tài khoản không hợp lệ');
  return value;
}
export function parseAccountList(value: unknown): AccountList {
  if (!record(value) || !Array.isArray(value.items) || typeof value.total !== 'number' || !Number.isInteger(value.total) || value.total < 0
    || typeof value.page !== 'number' || !Number.isInteger(value.page) || value.page < 1
    || typeof value.pageSize !== 'number' || !Number.isInteger(value.pageSize) || value.pageSize < 1) throw new Error('Phản hồi danh sách không hợp lệ');
  return { items: value.items.map(parseAccount), total: value.total, page: value.page, pageSize: value.pageSize };
}
