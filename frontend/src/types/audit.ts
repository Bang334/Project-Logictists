import { User } from './index';
export const canReadAudit = (user: User | null) => !!user?.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY' && g.branchId === null);
export interface AuditEntry {
  id: string; source: string; entityType: string; entityId: string; entityLabel: string;
  action: string; actionLabel: string; actorUserId: string | null; actorName: string | null;
  occurredAt: string; scope: { kind: string; branchIds: string[] };
  changedFields: Array<{ key: string; label: string }>;
  changes: Array<{ label: string; before: string | null; after: string | null }>;
  reason: string | null; resourceId: string | null; objectUrl: string | null;
}
export interface AuditPage { items: AuditEntry[]; total: number; page: number; pageSize: number }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Nhật ký không hợp lệ'); return v as Record<string, unknown>; }
function str(v: unknown): string { if (typeof v !== 'string') throw new Error('Nhật ký không hợp lệ'); return v; }
function nullable(v: unknown): string | null { return v === null ? null : str(v); }
function array(v: unknown): unknown[] { if (!Array.isArray(v)) throw new Error('Nhật ký không hợp lệ'); return v; }
function integer(v: unknown): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Phân trang không hợp lệ'); return v; }
export function parseAudit(v: unknown): AuditEntry {
  const r = object(v), scope = object(r.scope);
  const objectUrl = nullable(r.objectUrl);
  if (objectUrl && !/^\/(orders|customers|fleet|accounts|branch-detail)\?/.test(objectUrl)) throw new Error('Liên kết không hợp lệ');
  const occurredAt = str(r.occurredAt); if (!Number.isFinite(Date.parse(occurredAt))) throw new Error('Thời gian không hợp lệ');
  return { id: str(r.id), source: str(r.source), entityType: str(r.entityType), entityId: str(r.entityId), entityLabel: str(r.entityLabel), action: str(r.action), actionLabel: str(r.actionLabel), actorUserId: nullable(r.actorUserId), actorName: nullable(r.actorName), occurredAt,
    scope: { kind: str(scope.kind), branchIds: array(scope.branchIds).map(str) },
    changedFields: array(r.changedFields).map(v => { const f = object(v); return { key: str(f.key), label: str(f.label) }; }),
    changes: array(r.changes).map(v => { const c = object(v); return { label: str(c.label), before: nullable(c.before), after: nullable(c.after) }; }),
    reason: nullable(r.reason), resourceId: nullable(r.resourceId), objectUrl };
}
export function parseAuditPage(v: unknown): AuditPage { const r = object(v); return { items: array(r.items).map(parseAudit), total: integer(r.total), page: integer(r.page), pageSize: integer(r.pageSize) }; }
