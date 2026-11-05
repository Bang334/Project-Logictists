import { AuditSourceRow, projectAudit } from './audit-projection';

const row = (overrides: Partial<AuditSourceRow> = {}): AuditSourceRow => ({
  source: 'AUDIT_LOG', id: 'event-1', entityType: 'Customer', entityId: 'customer-1', action: 'UPDATE',
  actorUserId: 'actor-1', timestamp: new Date('2026-11-05T00:00:00.123Z'), summary: {}, ...overrides,
});
describe('administrative audit projection', () => {
  it('returns only allowed field names, never the internal values or nested credentials', () => {
    const result = projectAudit(row({ summary: { fields: ['name', 'password', 'token', 'name', 'unknown'], name: 'PRIVATE', password: 'SECRET', before: { passwordHash: 'HASH' }, after: { signedUrl: 'URL' } } }));
    expect(result.changedFields).toEqual([{ key: 'name', label: 'Tên' }]);
    expect(result.changes).toEqual([]);
    for (const secret of ['PRIVATE', 'SECRET', 'HASH', 'URL']) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('does not read metadata for unknown actions or entities', () => {
    for (const overrides of [{ action: 'NEW_ACTION' }, { entityType: '__proto__' }, { entityType: 'PodFile' }]) {
      const result = projectAudit(row({ ...overrides, summary: { fields: ['name'], reason: 'SECRET', auditBranchIds: ['branch-a'] } }));
      expect(result.action).toBe('UNKNOWN'); expect(result.reason).toBeNull();
      expect(result.scope).toEqual({ kind: 'UNKNOWN', branchIds: [] });
      expect(result.changedFields).toEqual([]);
    }
  });
  it('limits password events to the event fact and identity/time', () => {
    const result = projectAudit(row({ entityType: 'User', action: 'PASSWORD_CHANGED', summary: { password: 'SECRET', fields: ['fullName'], reason: 'SECRET', sessionsRevoked: true } }));
    expect(result.actionLabel).toBe('Đã đổi mật khẩu'); expect(result.changedFields).toEqual([]);
    expect(result.reason).toBeNull(); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('uses recorded old and new branches for customer scope, not actor metadata', () => {
    const result = projectAudit(row({ summary: { previousBranchIds: ['branch-a'], branchIds: ['branch-b'], actorBranchId: 'branch-c' } }));
    expect(result.scope.branchIds).toEqual(['branch-a', 'branch-b']);
    expect(projectAudit(row()).scope.kind).toBe('UNKNOWN');
    expect(result.changedFields).toContainEqual({ key: 'branchIds', label: 'Phạm vi chi nhánh' });
  });
  it('retains source/time precision and recorded order status without copying old order payload', () => {
    const result = projectAudit(row({ source: 'ORDER_EVENT', entityType: 'Order', action: 'CANCELLED', fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', summary: { reason: '<script>alert(1)</script>', before: { phone: 'PRIVATE' } } }));
    expect(result.source).toBe('ORDER_EVENT'); expect(result.occurredAt).toBe('2026-11-05T00:00:00.123Z');
    expect(result.changes).toEqual([{ label: 'Trạng thái đơn', before: 'CONFIRMED', after: 'CANCELLED' }]);
    expect(result.reason).toBe('<script>alert(1)</script>'); // Consumer must render text, never innerHTML.
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('projects recorded schedule times without exposing other previous values', () => {
    const result = projectAudit(row({ entityType: 'DriverShift', summary: {
      resourceId: 'driver-1', startsAt: '2026-11-05T08:00:00+07:00', endsAt: 'not-a-date',
      previous: { startsAt: '2026-11-05T07:00:00+07:00', secret: 'SECRET' },
    } }));
    expect(result.resourceId).toBe('driver-1');
    expect(result.changes).toEqual([{ label: 'Bắt đầu lịch', before: '2026-11-05T00:00:00.000Z', after: '2026-11-05T01:00:00.000Z' }]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('handles null/malformed legacy summaries without manufacturing history', () => {
    for (const summary of [null, [], 'payload', { fields: [null, {}], branchIds: ['branch-a', {}] }]) {
      const result = projectAudit(row({ summary })); expect(result.changedFields).toEqual([]);
      expect(result.scope.kind).toBe('UNKNOWN'); expect(result.changes).toEqual([]);
    }
  });
});
