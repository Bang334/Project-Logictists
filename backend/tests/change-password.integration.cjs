const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { seedAuth } = require('../dist/prisma/seed-auth');

test('Password changes revoke real PostgreSQL sessions atomically', { timeout: 90000 }, async t => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/tms_auth_test');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService), base = await app.getUrl();
  const original = 'Password-test-original-2026!', replacement = 'Password-test-replacement-2026!';
  const request = async (path, token, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    await seedAuth(db);
    const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
    const branch = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const user = await db.user.create({ data: { username: `password_test_${randomUUID()}`, fullName: '[TEST] Password', role: 'DISPATCHER', password: await bcrypt.hash(original, 12), roleScopes: { create: { roleId: role.id, branchId: branch.id, scopeType: 'BRANCH' } } } });
    const login = password => request('/auth/login', null, { username: user.username, password });
    const first = await login(original), second = await login(original);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    await t.test('wrong password and extraneous fields cannot change credentials', async () => {
      assert.equal((await request('/auth/change-password', first.body.accessToken, { currentPassword: 'incorrect', newPassword: replacement })).status, 403);
      assert.equal((await request('/auth/change-password', first.body.accessToken, { currentPassword: original, newPassword: replacement, userId: user.id })).status, 400);
      assert.equal((await request('/auth/change-password', first.body.accessToken, { currentPassword: original, newPassword: 'short' })).status, 400);
      assert.equal((await request('/auth/change-password', first.body.accessToken, { currentPassword: original, newPassword: original })).status, 400);
      assert.equal(await db.auditLog.count({ where: { entityId: user.id } }), 0);
    });
    await t.test('concurrent changes allow one writer; all prior sessions are revoked', async () => {
      const results = await Promise.all([first, second].map(session => request('/auth/change-password', session.body.accessToken, { currentPassword: original, newPassword: replacement })));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
      for (const session of [first, second]) assert.equal((await request('/auth/profile', session.body.accessToken)).status, 401);
      assert.equal(await db.authSession.count({ where: { userId: user.id, revokedAt: null } }), 0);
      assert.equal((await login(original)).status, 401);
      assert.equal((await login(replacement)).status, 200);
      const audits = await db.auditLog.findMany({ where: { entityId: user.id } });
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, 'PASSWORD_CHANGED');
      assert.ok(!JSON.stringify(audits).includes(original) && !JSON.stringify(audits).includes(replacement));
    });
    await t.test('login that read the old hash cannot create a session after password replacement', async () => {
      const signed = await login(replacement); assert.equal(signed.status, 200);
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const observed = new Promise(resolve => { entered = resolve; });
      const find = db.user.findUnique.bind(db.user);
      let pause = true;
      // Scheduling barrier only: the row and password still come from real PostgreSQL.
      db.user.findUnique = async args => {
        const result = await find(args);
        if (pause && args.where.username === user.username) { pause = false; entered(); await gate; }
        return result;
      };
      let pending;
      try {
        pending = login(replacement);
        await observed;
        const changed = await request('/auth/change-password', signed.body.accessToken, { currentPassword: replacement, newPassword: 'Password-test-third-value-2026!' });
        assert.equal(changed.status, 200);
        release();
        assert.equal((await pending).status, 401);
        assert.equal(await db.authSession.count({ where: { userId: user.id, revokedAt: null } }), 0);
      } finally { release(); db.user.findUnique = find; if (pending) await pending; }
    });
  } finally { await app.close(); }
});
