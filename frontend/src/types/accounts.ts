import { User } from './index';

export function canManageAccounts(user: User | null, permission = 'users.read'): boolean {
  return !!user && user.grants.some(g =>
    g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.branchId === null && g.permissions.includes(permission));
}
export interface Account {
  id: string;
  username: string;
  fullName: string;
  role: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  roleScopes: Array<{ scopeType: 'BRANCH' | 'COMPANY' | 'LOCATION'; role: { code: string; name: string }; branch: { id: string; code: string; name: string } | null }>;
}
export interface AccountList { items: Account[]; total: number; page: number; pageSize: number }
export interface AccountDetail extends Account { scopeHistory: Array<Account['roleScopes'][number] & { active: boolean; role: { code: string; name: string; active: boolean }; branch: { id: string; code: string; name: string; active: boolean } | null }> }
export function parseAccountDetail(value: unknown): AccountDetail {
  const account = parseAccount(value);
  if (!record(value) || !Array.isArray(value.scopeHistory)) throw new Error('Chi tiết phạm vi không hợp lệ');
  const scopeHistory = value.scopeHistory.map((scope): AccountDetail['scopeHistory'][number] => {
    parseAccount({ ...account, roleScopes: [scope] });
    if (!record(scope) || typeof scope.active !== 'boolean' || !record(scope.role) || typeof scope.role.active !== 'boolean' || typeof scope.role.code !== 'string' || typeof scope.role.name !== 'string'
      || (scope.scopeType !== 'BRANCH' && scope.scopeType !== 'COMPANY' && scope.scopeType !== 'LOCATION')) throw new Error('Chi tiết phạm vi không hợp lệ');
    let branch: AccountDetail['scopeHistory'][number]['branch'] = null;
    if (scope.branch !== null) {
      const source = scope.branch;
      if (!record(source) || typeof source.active !== 'boolean' || typeof source.id !== 'string' || typeof source.code !== 'string' || typeof source.name !== 'string') throw new Error('Chi tiết chi nhánh không hợp lệ');
      branch = { id: source.id, code: source.code, name: source.name, active: source.active };
    }
    return { scopeType: scope.scopeType, active: scope.active, role: { code: scope.role.code, name: scope.role.name, active: scope.role.active }, branch };
  });
  return { ...account, scopeHistory };
}
export interface AccountQuery { page: number; pageSize: number; search?: string; status?: 'active' | 'locked'; branchId?: string }
export interface CreateAccount { username: string; fullName: string; password: string; roleCode: 'DISPATCHER' | 'DRIVER'; branchIds: string[]; driverId?: string }
export interface AvailableDriver { id: string; fullName: string; homeBranchId: string }
export function parseAvailableDrivers(value: unknown): AvailableDriver[] {
  if (!record(value) || !Array.isArray(value.items)) throw new Error('Phản hồi tài xế không hợp lệ');
  return value.items.map(item => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.fullName !== 'string' || typeof item.homeBranchId !== 'string') throw new Error('Hồ sơ tài xế không hợp lệ');
    return { id: item.id, fullName: item.fullName, homeBranchId: item.homeBranchId };
  });
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }
export function parseAccount(value: unknown): Account {
  const isAccount = (value: unknown): value is Account => {
    if (!record(value) || typeof value.id !== 'string' || typeof value.username !== 'string' || typeof value.fullName !== 'string' || typeof value.role !== 'string'
      || typeof value.active !== 'boolean' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || !Array.isArray(value.roleScopes) || !value.roleScopes.every(s => record(s) && ['BRANCH', 'COMPANY', 'LOCATION'].includes(String(s.scopeType))
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
