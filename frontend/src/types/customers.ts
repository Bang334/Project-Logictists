export interface CustomerChoice { id: string; code: string; name: string }
export interface Customer extends CustomerChoice {
  phone: string; email: string | null; address: string | null; contactPerson: string | null; taxCode: string | null;
  version: number; createdAt: string; updatedAt: string;
  branches: Array<{ id: string; code: string; name: string; active: boolean }>;
  canEdit: boolean; canManageScope: boolean;
}
export interface CustomerInput { name: string; phone: string; email?: string | null; address?: string | null; contactPerson?: string | null; taxCode?: string | null; branchIds?: string[] }
export interface CustomerQuery { branchId?: string; search?: string; page?: number; pageSize?: number }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface CustomerOrder { id: string; orderNumber: string; status: string; createdAt: string; branch: { id: string; name: string } }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseChoice(v: unknown): CustomerChoice {
  if (!record(v) || typeof v.id !== 'string' || typeof v.code !== 'string' || typeof v.name !== 'string') throw new Error('Phản hồi khách hàng không hợp lệ');
  return { id: v.id, code: v.code, name: v.name };
}
export function parseCustomer(v: unknown): Customer {
  const valid = (v: unknown): v is Customer => record(v) && typeof v.id === 'string' && typeof v.code === 'string' && typeof v.name === 'string'
    && typeof v.phone === 'string' && ['email','address','contactPerson','taxCode'].every(k => v[k] === null || typeof v[k] === 'string')
    && typeof v.version === 'number' && Number.isInteger(v.version) && v.version > 0 && typeof v.createdAt === 'string' && typeof v.updatedAt === 'string'
    && typeof v.canEdit === 'boolean' && typeof v.canManageScope === 'boolean' && Array.isArray(v.branches)
    && v.branches.every(b => record(b) && typeof b.id === 'string' && typeof b.code === 'string' && typeof b.name === 'string' && typeof b.active === 'boolean');
  if (!valid(v)) throw new Error('Phản hồi hồ sơ khách hàng không hợp lệ');
  return v;
}
export function parsePage<T>(v: unknown, parse: (v: unknown) => T): Page<T> {
  if (!record(v) || !Array.isArray(v.items) || typeof v.total !== 'number' || !Number.isInteger(v.total) || v.total < 0
    || typeof v.page !== 'number' || !Number.isInteger(v.page) || v.page < 1 || typeof v.pageSize !== 'number' || !Number.isInteger(v.pageSize) || v.pageSize < 1) throw new Error('Phân trang không hợp lệ');
  return { items: v.items.map(parse), total: v.total, page: v.page, pageSize: v.pageSize };
}
export function parseCustomerOrder(v: unknown): CustomerOrder {
  if (!record(v) || typeof v.id !== 'string' || typeof v.orderNumber !== 'string' || typeof v.status !== 'string' || typeof v.createdAt !== 'string'
    || !record(v.branch) || typeof v.branch.id !== 'string' || typeof v.branch.name !== 'string') throw new Error('Phản hồi đơn của khách không hợp lệ');
  return { id: v.id, orderNumber: v.orderNumber, status: v.status, createdAt: v.createdAt, branch: { id: v.branch.id, name: v.branch.name } };
}
