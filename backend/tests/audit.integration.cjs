const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { auditApp } = require('./audit-app.cjs');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuditService } = require('../dist/src/audit-logs/audit.service');

test('Administrative audit: real PostgreSQL and HTTP', { timeout: 180000 }, async t => {
  const app = await auditApp(), db = app.get(PrismaService), base = await app.getUrl();
  const request = async (path, token, method = 'GET', body, key = randomUUID()) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
  };
  try {
    const login = async name => (await request('/auth/login', null, 'POST', { username: name, password: process.env.AUTH_DEMO_PASSWORD })).body.accessToken;
    const admin = await login('demo_auth_admin'), dispatcher = await login('demo_auth_a'); assert.ok(admin && dispatcher);
    const actor = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
    const adminUser = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_admin' } });
    const a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } }), b = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } });
    const entityId = randomUUID(), at = new Date('2032-01-02T00:00:00.123Z');
    const make = (data = {}) => db.auditLog.create({ data: { entityType: 'Customer', entityId, action: 'UPDATE', actorUserId: actor.id, performedBy: actor.id, timestamp: at, changeSummary: { fields: ['name'], auditBranchIds: [a.id] }, ...data } });
    const first = await make({ id: '10000000-0000-4000-8000-000000000001' .replace('10000000', randomUUID().slice(0,8)) });
    const second = await make(); const upper = await make({ timestamp: new Date('2032-01-03T00:00:00Z') });
    const query = extra => '/audit-logs?' + new URLSearchParams({ from: '2032-01-02T00:00:00Z', to: '2032-01-03T00:00:00Z', entityId, ...extra });
    await t.test('stable pagination, exact IDs, action/actor filters, [from,to), timezone and no-store', async () => {
      const r = await request(query({ pageSize: '1' }), admin); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.total, 2); assert.match(r.cache, /no-store/);
      const p2 = await request(query({ pageSize: '1', page: '2' }), admin);
      assert.deepEqual([r.body.items[0].id, p2.body.items[0].id], [first.id, second.id].sort().reverse());
      assert.equal((await request(query({ from: '2032-01-02T07:00:00+07:00', to: '2032-01-03T07:00:00+07:00' }), admin)).body.total, 2);
      assert.equal((await request(query({ from: at.toISOString(), to: '2032-01-02T00:00:00.124Z', actorUserId: actor.id, action: 'UPDATE', entityType: 'Customer' }), admin)).body.total, 2);
      assert.equal((await request(query({ to: at.toISOString() }), admin)).body.total, 0);
      assert.ok(!(await request(query({}), admin)).body.items.some(v => v.id === upper.id));
      assert.equal((await request(query({ actorUserId: randomUUID() }), admin)).body.total, 0);
    });
    await t.test('all list/detail access is ADMIN COMPANY, never role string alone', async () => {
      for (const path of [query({}), `/audit-logs/AUDIT_LOG/${first.id}`]) {
        assert.equal((await request(path, null)).status, 401); assert.equal((await request(path, dispatcher)).status, 403);
      }
      await assert.rejects(() => app.get(AuditService).list({ from: at.toISOString(), to: '2032-01-03T00:00:00Z', page: 1, pageSize: 20 }, { id: actor.id, role: 'ADMIN', grants: [{ role: 'ADMIN', scopeType: 'BRANCH', branchId: a.id, permissions: ['users.read'] }] }), /ADMIN/);
      const scope = await db.userRoleScope.findFirstOrThrow({ where: { userId: adminUser.id, scopeType: 'COMPANY', active: true } });
      try { await db.userRoleScope.update({ where: { id: scope.id }, data: { active: false } }); assert.equal((await request(query({}), admin)).status, 403); assert.equal((await request(`/audit-logs/AUDIT_LOG/${first.id}`, admin)).status, 403); }
      finally { await db.userRoleScope.update({ where: { id: scope.id }, data: { active: true } }); }
    });
    await t.test('unknown, multi-branch and cross-branch history remains company-only; no inference from current actor', async () => {
      const unknown = await make({ changeSummary: {} });
      await make({ changeSummary: { previousBranchIds: [a.id], branchIds: [b.id] } });
      await make({ changeSummary: { auditBranchIds: [b.id] } });
      await make({ changeSummary: { auditBranchIds: [a.id, {}] } });
      assert.equal((await request(query({ branchId: a.id }), admin)).body.total, 3);
      assert.equal((await request(query({ branchId: b.id }), admin)).body.total, 2);
      try {
        await db.user.update({ where: { id: actor.id }, data: { branchId: b.id, fullName: 'Audit renamed actor', active: false } });
        const r = await request(`/audit-logs/AUDIT_LOG/${first.id}`, admin); assert.equal(r.status, 200); assert.deepEqual(r.body.scope.branchIds, [a.id]); assert.equal(r.body.actorName, 'Audit renamed actor');
        assert.equal((await request(`/audit-logs/AUDIT_LOG/${unknown.id}`, admin)).body.scope.kind, 'UNKNOWN');
      } finally { await db.user.update({ where: { id: actor.id }, data: { branchId: actor.branchId, fullName: actor.fullName, active: actor.active } }); }
    });
    await t.test('allowlist excludes raw payload, secrets, POD; unknown actions show only safe facts', async () => {
      for (const action of ['UPDATE', 'UNRECOGNIZED']) {
        const log = await make({ action, details: 'SECRET-details', changeSummary: { fields: ['name','passwordHash','accessToken'], password: 'SECRET-password', before: { signedUrl: 'SECRET-url' }, pod: 'SECRET-pod' } });
        const r = await request(`/audit-logs/AUDIT_LOG/${log.id}`, admin); assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes('SECRET')); assert.ok(!JSON.stringify(r.body).includes('passwordHash'));
      }
      const log = await make({ entityType: 'User', action: 'PASSWORD_CHANGED', changeSummary: { password: 'SECRET', fields: ['fullName'], sessionsRevoked: true } });
      const r = await request(`/audit-logs/AUDIT_LOG/${log.id}`, admin); assert.deepEqual(r.body.changedFields, []); assert.deepEqual(r.body.changes, []); assert.ok(!JSON.stringify(r.body).includes('SECRET'));
      const excluded = await make({ entityType: 'PodFile', action: 'VIEW' }); assert.equal((await request(`/audit-logs/AUDIT_LOG/${excluded.id}`, admin)).status, 404);
      assert.equal((await request('/audit-logs/AUDIT_LOG/' + randomUUID(), admin)).status, 404);
    });
    await t.test('runtime query validation and limits', async () => {
      for (const p of [{ from: '2032-01-01' }, { page: '0' }, { pageSize: '101' }, { to: '2033-01-01T00:00:00Z' }, { to: '2031-01-01T00:00:00Z' }, { entityType: 'PodFile' }, { action: "' OR 1=1" }, { entityId: 'x'.repeat(101) }, { unexpected: 'yes' }]) assert.equal((await request(query(p), admin)).status, 400, JSON.stringify(p));
    });
    await t.test('audit access does not grant access to target objects', async () => {
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'ADMIN' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'customers.read' } });
      const grant = await db.rolePermission.findUniqueOrThrow({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
      try {
        await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
        const detail = await request(`/audit-logs/AUDIT_LOG/${first.id}`, admin); assert.equal(detail.status, 200); assert.equal(detail.body.objectUrl, null);
        assert.equal((await request('/customers/' + entityId, admin)).status, 403);
      } finally { await db.rolePermission.create({ data: grant }); }
    });
    await t.test('real customer mutation, retry and audit failure rollback are atomic', async () => {
      const key = randomUUID(), payload = { name: '[AUDIT TEST] ' + key, phone: '000', branchIds: [a.id,b.id] };
      const created = await request('/customers', admin, 'POST', payload, key); assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal((await request('/customers', admin, 'POST', payload, key)).body.id, created.body.id);
      assert.equal(await db.auditLog.count({ where: { entityType: 'Customer', entityId: created.body.id } }), 1);
      const q = '/audit-logs?' + new URLSearchParams({ from: new Date(Date.now()-60000).toISOString(), to: new Date(Date.now()+60000).toISOString(), entityId: created.body.id });
      const r = await request(q, admin); assert.equal(r.body.total, 1); assert.deepEqual(r.body.items[0].scope.branchIds.sort(), [a.id,b.id].sort()); assert.equal(r.body.items[0].objectUrl, '/customers?customer=' + created.body.id);
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityType" = 'Customer' AND NEW.action = 'CREATE' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER audit_test_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_test_fail()');
      const failName = '[AUDIT ROLLBACK] ' + randomUUID();
      try { const failed = await request('/customers', admin, 'POST', { ...payload, name: failName }); assert.equal(failed.status, 503); assert.equal(failed.body.code, 'SERVICE_UNAVAILABLE'); assert.equal(await db.customer.count({ where: { name: failName } }), 0); }
      finally { await db.$executeRawUnsafe('DROP TRIGGER audit_test_fail ON audit_logs'); await db.$executeRawUnsafe('DROP FUNCTION audit_test_fail()'); }
    });
    await t.test('order source keeps reasons and status, never internal full snapshot; retry does not duplicate', async () => {
      const customer = await db.customer.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-CUSTOMER-A' } });
      const payload = { branchId: a.id, customerId: customer.id, stops: ['PICKUP','DELIVERY'].map((type,i) => ({ type, address: '[AUDIT TEST]', latitude: 21+i/100, longitude: 105, contactName: 'Test', contactPhone: '000', windowStart: '2033-01-01T00:00:00Z', windowEnd: '2033-01-02T00:00:00Z', serviceDurationMinutes: 1 })), items: [{ description: 'test', packageType: 'CARTON', packages: [{ lengthMm: 400, widthMm: 300, heightMm: 200, weightG: '10000' }] }] };
      const created = await request('/orders', admin, 'POST', payload); assert.equal(created.status, 201, JSON.stringify(created.body));
      const key = randomUUID(), body = { version: 1, reason: '<script>window.auditInjected=true</script>' };
      assert.equal((await request('/orders/' + created.body.id + '/cancel', admin, 'POST', body, key)).status, 201);
      assert.equal((await request('/orders/' + created.body.id + '/cancel', admin, 'POST', body, key)).status, 201);
      const event = await db.orderEvent.findFirstOrThrow({ where: { orderId: created.body.id, eventType: 'CANCELLED' } });
      const r = await request('/audit-logs/ORDER_EVENT/' + event.id, admin); assert.equal(r.status, 200); assert.equal(r.body.reason, body.reason); assert.deepEqual(r.body.scope.branchIds, [a.id]); assert.equal(r.body.source, 'ORDER_EVENT');
      assert.equal(await db.orderEvent.count({ where: { orderId: created.body.id } }), 2);
    });
    await t.test('index migration preserves existing audit/event data', async () => {
      const fingerprint = () => db.$queryRawUnsafe(`SELECT 'audit' AS source, count(*)::text AS count, md5(string_agg(md5(row_to_json(a)::text), '' ORDER BY id)) AS hash FROM audit_logs a UNION ALL SELECT 'order',count(*)::text,md5(string_agg(md5(row_to_json(e)::text), '' ORDER BY id)) FROM order_status_events e`);
      const before = await fingerprint();
      const existing = await db.$queryRawUnsafe("SELECT indexname FROM pg_indexes WHERE indexname IN ('audit_logs_time_id_idx','order_events_time_id_idx')");
      const sql = fs.readFileSync('prisma/migrations/20261105100000_audit_lookup_indexes/migration.sql','utf8');
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) {
        const name = statement.match(/CREATE INDEX "([^"]+)"/)[1];
        if (!existing.some(i => i.indexname === name)) await db.$executeRawUnsafe(statement);
      }
      assert.deepEqual(await fingerprint(), before);
      const indexes = await db.$queryRawUnsafe("SELECT indexname FROM pg_indexes WHERE indexname IN ('audit_logs_time_id_idx','order_events_time_id_idx')"); assert.equal(indexes.length, 2);
    });
  } finally { await app.close(); }
});
