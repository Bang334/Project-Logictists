import { describe, expect, it } from 'vitest';
import { parseAudit, parseAuditPage, canReadAudit } from '../types/audit';

const entry = {
  id: 'event', source: 'AUDIT_LOG', entityType: 'Customer', entityId: 'customer', entityLabel: 'Khách hàng', action: 'UPDATE', actionLabel: 'Cập nhật',
  actorUserId: null, actorName: null, occurredAt: '2026-11-05T00:00:00Z', scope: { kind: 'UNKNOWN', branchIds: [] }, changedFields: [], changes: [], reason: null, resourceId: null, objectUrl: '/customers?customer=customer',
};
describe('audit response boundary', () => {
  it('accepts missing historical actor and scope without replacing them with current data', () => {
    const result = parseAudit(entry); expect(result.actorUserId).toBeNull(); expect(result.scope.branchIds).toEqual([]);
    expect(parseAuditPage({ items: [entry], total: 1, page: 1, pageSize: 20 }).items).toHaveLength(1);
  });
  it('rejects malformed fields and unsafe destination URLs', () => {
    for (const patch of [{ objectUrl: 'https://external.example' }, { objectUrl: 'javascript:alert(1)' }, { objectUrl: '//external.example' }, { occurredAt: 'invalid' }, { scope: { kind: 'UNKNOWN', branchIds: [1] } }, { changes: [{ label: 'x', before: {}, after: null }] }]) expect(() => parseAudit({ ...entry, ...patch })).toThrow();
    expect(() => parseAuditPage({ items: [entry], total: -1, page: 1, pageSize: 20 })).toThrow();
  });
  it('does not preserve unexpected server payload fields', () => {
    expect(JSON.stringify(parseAudit({ ...entry, passwordHash: 'SECRET', payload: { token: 'SECRET' } }))).not.toContain('SECRET');
    expect(canReadAudit(null)).toBe(false);
  });
});
