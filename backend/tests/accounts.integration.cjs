// HTTP, database constraints/transactions and real Socket.IO on isolated PostgreSQL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { io } = require('../../frontend/node_modules/socket.io-client');
const { AppModule } = require('../dist/src/app.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { EventsGateway } = require('../dist/src/events/events.gateway');
const { seedAuth } = require('../dist/prisma/seed-auth');

test('Account management on real PostgreSQL', { timeout: 120000 }, async t => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && ['/tms_auth_test', '/tms_merge_test_20261005'].includes(target.pathname), 'Refusing non-test database');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService), base = await app.getUrl();
  const prefix = 'accounts_test_' + randomUUID().replaceAll('-', '') + '_';
  const sockets = [];
  const request = async (path, token, method = 'GET', body, extraHeaders = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const login = username => request('/auth/login', null, 'POST', { username, password: process.env.AUTH_DEMO_PASSWORD });
  const connect = token => {
    const s = io(base, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s);
    return new Promise((resolve, reject) => { s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
  };
  const ack = (s, event, data) => new Promise((resolve, reject) => s.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const safe = value => {
    const walk = v => { if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) { assert.ok(!/password|hash|session|token/i.test(k), 'Sensitive response key: ' + k); walk(child); } };
    walk(value);
  };
  try {
    await seedAuth(db);
    await db.authLoginLimit.deleteMany();
    const a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const b = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } });
    const adminUser = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_admin' } });
    const adminRole = await db.accessRole.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const dispatcherRole = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
    const admin = (await login(adminUser.username)).body.accessToken;
    const dispatcher = (await login('demo_auth_a')).body.accessToken;
    assert.ok(admin && dispatcher);
    const payload = (suffix, branchIds = [a.id]) => ({ username: prefix + suffix, fullName: '[TEST ACCOUNTS] ' + suffix, password: process.env.AUTH_DEMO_PASSWORD, roleCode: 'DISPATCHER', branchIds });
    const create = (suffix, branchIds) => request('/users', admin, 'POST', payload(suffix, branchIds));
    let one, multi;

    await t.test('admin lists safe paginated records; unauthenticated receives 401', async () => {
      assert.equal((await request('/users')).status, 401);
      const res = await request('/users?pageSize=2', admin);
      assert.equal(res.status, 200); assert.equal(res.body.items.length, 2); assert.ok(res.body.total >= 5); safe(res.body);
      assert.equal((await request('/users?pageSize=101', admin)).status, 400);
    });
    await t.test('dispatcher cannot list/create/lock even with spoofed identity', async () => {
      const headers = { username: 'demo_auth_admin', userId: adminUser.id, role: 'ADMIN', permission: 'users.create', 'X-Branch-Id': a.id };
      for (const [path, method, body] of [['/users', 'GET'], ['/users', 'POST', { ...payload('forged'), username: 'demo_auth_admin', userId: adminUser.id, role: 'ADMIN', permissions: ['users.create'] }], ['/users/' + adminUser.id + '/lock', 'PATCH', { userId: adminUser.id }]]) {
        assert.equal((await request(path, dispatcher, method, body, headers)).status, 403);
      }
    });
    await t.test('other COMPANY ADMIN and live DB username change are rejected', async () => {
      const other = await db.user.create({ data: { username: prefix + 'other_admin', fullName: '[TEST ACCOUNTS] Admin', password: adminUser.password, roleScopes: { create: { roleId: adminRole.id, scopeType: 'COMPANY' } } } });
      const otherToken = (await login(other.username)).body.accessToken;
      for (const [path, method, body] of [['/users','GET'], ['/users','POST',payload('other_denied')], ['/users/' + other.id + '/lock','PATCH']]) assert.equal((await request(path, otherToken, method, body)).status, 403);
      await db.user.update({ where: { id: adminUser.id }, data: { username: prefix + 'renamed_admin' } });
      try { assert.equal((await request('/users', admin)).status, 403); }
      finally { await db.user.update({ where: { id: adminUser.id }, data: { username: adminUser.username } }); }
    });
    await t.test('accidental dispatcher users permission still cannot bypass capability', async () => {
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'users.read' } });
      await db.rolePermission.create({ data: { roleId: dispatcherRole.id, permissionId: permission.id } });
      try { assert.equal((await request('/users', dispatcher)).status, 403); }
      finally { await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: dispatcherRole.id, permissionId: permission.id } } }); }
    });
    await t.test('create with one branch persists trimmed name, bcrypt and BRANCH scope', async () => {
      const res = await request('/users', admin, 'POST', { ...payload('one'), username: ' ' + prefix + 'one ', fullName: ' Name one ' });
      assert.equal(res.status, 201); one = res.body; safe(one);
      assert.equal(one.username, prefix + 'one'); assert.equal(one.fullName, 'Name one');
      const stored = await db.user.findUniqueOrThrow({ where: { id: one.id }, include: { roleScopes: true } });
      assert.ok(stored.password.startsWith('$2')); assert.ok(stored.password !== process.env.AUTH_DEMO_PASSWORD);
      assert.equal(stored.branchId, null); assert.equal(stored.roleScopes.length, 1); assert.equal(stored.roleScopes[0].scopeType, 'BRANCH'); assert.equal(stored.roleScopes[0].branchId, a.id);
    });
    await t.test('create multiple scopes in one transaction', async () => {
      const res = await create('multi', [a.id, b.id]); assert.equal(res.status, 201); multi = res.body; safe(multi);
      assert.deepEqual(multi.roleScopes.map(s => s.branch.id).sort(), [a.id, b.id].sort());
    });
    await t.test('runtime DTO rejects missing role/branches, ADMIN, duplicates and arbitrary fields', async () => {
      for (const changes of [{ roleCode: undefined }, { roleCode: 'ADMIN' }, { branchIds: undefined }, { branchIds: [] }, { branchIds: [a.id, a.id] }, { branchIds: ['bad'] }, { branchIds: [null] }, { permissions: ['users.read'] }, { userId: adminUser.id }, { username: ' ' }, { fullName: ' ' }]) {
        assert.equal((await request('/users', admin, 'POST', { ...payload('invalid'), ...changes })).status, 400);
      }
      assert.equal(await db.user.count({ where: { username: prefix + 'invalid' } }), 0);
    });
    await t.test('password validates UTF-8 bytes, including 12/72 byte boundaries', async () => {
      for (const password of [undefined, '', 'a'.repeat(11), 'a'.repeat(73), '🔐'.repeat(19)]) assert.equal((await request('/users', admin, 'POST', { ...payload('bad_pass'), password })).status, 400);
      for (const [i, password] of ['🔐'.repeat(3), '🔐'.repeat(18)].entries()) assert.equal((await request('/users', admin, 'POST', { ...payload('bytes' + i), password })).status, 201);
    });
    await t.test('inactive/missing role or branch cannot create a partial user', async () => {
      assert.equal((await create('missing_branch', [randomUUID()])).body.code, 'BRANCH_UNAVAILABLE');
      await db.branch.update({ where: { id: b.id }, data: { active: false } });
      try { assert.equal((await create('inactive_branch', [a.id, b.id])).body.code, 'BRANCH_UNAVAILABLE'); }
      finally { await db.branch.update({ where: { id: b.id }, data: { active: b.active } }); }
      await db.accessRole.update({ where: { id: dispatcherRole.id }, data: { active: false } });
      try { assert.equal((await create('inactive_role')).body.code, 'ROLE_UNAVAILABLE'); }
      finally { await db.accessRole.update({ where: { id: dispatcherRole.id }, data: { active: true } }); }
      await db.accessRole.update({ where: { id: dispatcherRole.id }, data: { code: prefix + 'role' } });
      try { assert.equal((await create('missing_role')).body.code, 'ROLE_UNAVAILABLE'); }
      finally { await db.accessRole.update({ where: { id: dispatcherRole.id }, data: { code: 'DISPATCHER' } }); }
      assert.equal(await db.user.count({ where: { username: { in: ['missing_branch', 'inactive_branch', 'inactive_role', 'missing_role'].map(s => prefix + s) } } }), 0);
    });
    await t.test('duplicate username returns 409, including simultaneous requests', async () => {
      const duplicate = await create('one'); assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'USERNAME_EXISTS');
      const concurrent = await Promise.all([create('concurrent'), create('concurrent')]);
      assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409]);
      assert.equal(await db.userRoleScope.count({ where: { user: { username: prefix + 'concurrent' } } }), 1);
    });
    await t.test('database scope failure rolls back the user and every scope', async () => {
      // A real database trigger rejects only this test account, after the user insert.
      await db.$executeRawUnsafe(`CREATE FUNCTION accounts_test_reject_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM users WHERE id = NEW."userId" AND username = '${prefix}rollback') THEN RAISE EXCEPTION 'test scope failure'; END IF; RETURN NEW; END $$`);
      try {
        await db.$executeRawUnsafe('CREATE TRIGGER accounts_test_scope_failure BEFORE INSERT ON user_role_scopes FOR EACH ROW EXECUTE FUNCTION accounts_test_reject_scope()');
        const res = await create('rollback', [a.id, b.id]); assert.equal(res.status, 503); safe(res.body);
        assert.equal(await db.user.count({ where: { username: prefix + 'rollback' } }), 0);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS accounts_test_scope_failure ON user_role_scopes');
        await db.$executeRawUnsafe('DROP FUNCTION accounts_test_reject_scope()');
      }
    });
    await t.test('new accounts log in and see exactly their granted branches/data', async () => {
      for (const [account, branches] of [[one, [a.id]], [multi, [a.id, b.id]]]) {
        const signed = await login(account.username); assert.equal(signed.status, 200);
        assert.deepEqual(signed.body.user.branches.map(b => b.id).sort(), branches.sort());
        const orders = await request('/orders', signed.body.accessToken); assert.equal(orders.status, 200); assert.ok(orders.body.items.length > 0); assert.ok(orders.body.items.every(o => branches.includes(o.branchId)));
        assert.equal((await request('/users', signed.body.accessToken)).status, 403);
        const locations = await request('/locations', signed.body.accessToken);
        assert.equal(locations.status, 200);
        assert.ok(locations.body.every(location => branches.includes(location.managingBranchId)));
      }
    });
    await t.test('search, status, branch and pagination are applied by PostgreSQL', async () => {
      const search = await request('/users?search=' + prefix + '&pageSize=2', admin);
      assert.equal(search.status, 200); assert.equal(search.body.items.length, 2); assert.ok(search.body.items.every(u => u.username.startsWith(prefix)));
      const second = await request('/users?search=' + prefix + '&pageSize=2&page=2', admin);
      assert.ok(second.body.items.every(u => !search.body.items.some(v => v.id === u.id)));
      const name = await request('/users?search=Name%20one', admin); assert.ok(name.body.items.some(u => u.id === one.id));
      const branch = await request('/users?search=' + prefix + '&branchId=' + b.id, admin);
      assert.ok(branch.body.items.some(u => u.id === multi.id)); assert.ok(branch.body.items.every(u => u.roleScopes.some(s => s.branch?.id === b.id)));
      const locked = await request('/users?status=locked', admin); assert.ok(locked.body.items.every(u => !u.active));
    });
    await t.test('permission, role and COMPANY scope revocation apply on the next request', async () => {
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'users.read' } });
      const key = { roleId: adminRole.id, permissionId: permission.id };
      await db.rolePermission.delete({ where: { roleId_permissionId: key } });
      try { assert.equal((await request('/users', admin)).status, 403); }
      finally { await db.rolePermission.create({ data: key }); }
      await db.accessRole.update({ where: { id: adminRole.id }, data: { active: false } });
      try { assert.equal((await request('/users', admin)).status, 403); }
      finally { await db.accessRole.update({ where: { id: adminRole.id }, data: { active: true } }); }
      const scope = await db.userRoleScope.findFirstOrThrow({ where: { userId: adminUser.id, scopeType: 'COMPANY' } });
      await db.userRoleScope.update({ where: { id: scope.id }, data: { active: false } });
      try { assert.equal((await request('/users', admin)).status, 403); }
      finally { await db.userRoleScope.update({ where: { id: scope.id }, data: { active: true } }); }
      const token = (await login(one.username)).body.accessToken;
      await db.userRoleScope.updateMany({ where: { userId: one.id }, data: { active: false } });
      try { assert.equal((await request('/orders', token)).status, 403); }
      finally { await db.userRoleScope.updateMany({ where: { userId: one.id }, data: { active: true } }); }
    });
    await t.test('lock revokes all tokens and disconnects subscribed sockets immediately', async () => {
      const token1 = (await login(one.username)).body.accessToken, token2 = (await login(one.username)).body.accessToken;
      const s = await connect(token1); assert.equal((await ack(s, 'join:branch', a.id)).ok, true);
      const trip = await db.trip.findUniqueOrThrow({ where: { tripNumber: 'DEMO-AUTH-TRIP-A' } });
      let received = 0; s.on('trip:updated', () => received++);
      const before = new Promise(resolve => s.once('trip:updated', resolve));
      await app.get(EventsGateway).emitTripUpdate(trip); await before; assert.equal(received, 1);
      const disconnected = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Socket was not disconnected')), 2000); s.once('disconnect', () => { clearTimeout(timer); resolve(); }); });
      const res = await request('/users/' + one.id + '/lock', admin, 'PATCH'); assert.equal(res.status, 200); assert.equal(res.body.active, false); safe(res.body);
      await disconnected;
      assert.equal(await db.authSession.count({ where: { userId: one.id, revokedAt: null } }), 0);
      for (const token of [token1, token2]) assert.equal((await request('/orders', token)).status, 401);
      await app.get(EventsGateway).emitTripUpdate(trip);
      assert.equal(received, 1); assert.equal(s.connected, false);
      await assert.rejects(connect(token1));
      assert.equal((await login(one.username)).body.code, 'ACCOUNT_DISABLED');
    });
    await t.test('repeated lock is idempotent; self-lock/missing user are rejected', async () => {
      const scopes = await db.userRoleScope.findMany({ where: { userId: one.id } });
      const sessions = await db.authSession.findMany({ where: { userId: one.id } });
      const results = await Promise.all([request('/users/' + one.id + '/lock', admin, 'PATCH'), request('/users/' + one.id + '/lock', admin, 'PATCH')]);
      assert.ok(results.every(r => r.status === 200 && !r.body.active));
      assert.deepEqual(await db.userRoleScope.findMany({ where: { userId: one.id } }), scopes);
      assert.deepEqual(await db.authSession.findMany({ where: { userId: one.id } }), sessions);
      assert.equal((await request('/users/' + adminUser.id + '/lock', admin, 'PATCH')).body.code, 'SELF_LOCK_DENIED');
      assert.equal((await request('/users/' + randomUUID() + '/lock', admin, 'PATCH')).status, 404);
    });
    await t.test('session revocation failure rolls back account lock', async () => {
      const account = await create('lock_rollback'); assert.equal(account.status, 201);
      const signed = await login(account.body.username); assert.equal(signed.status, 200);
      await db.$executeRawUnsafe(`CREATE FUNCTION accounts_test_reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."userId" = '${account.body.id}' THEN RAISE EXCEPTION 'test session failure'; END IF; RETURN NEW; END $$`);
      try {
        await db.$executeRawUnsafe('CREATE TRIGGER accounts_test_session_failure BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION accounts_test_reject_revoke()');
        assert.equal((await request('/users/' + account.body.id + '/lock', admin, 'PATCH')).status, 503);
        assert.equal((await db.user.findUniqueOrThrow({ where: { id: account.body.id } })).active, true);
        assert.equal(await db.authSession.count({ where: { userId: account.body.id, revokedAt: null } }), 1);
        assert.equal((await request('/orders', signed.body.accessToken)).status, 200);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS accounts_test_session_failure ON auth_sessions');
        await db.$executeRawUnsafe('DROP FUNCTION accounts_test_reject_revoke()');
      }
    });
    await t.test('login racing with lock never leaves a live session', async () => {
      const res = await create('race'); assert.equal(res.status, 201);
      const [signed, locked] = await Promise.all([login(res.body.username), request('/users/' + res.body.id + '/lock', admin, 'PATCH')]);
      assert.equal(locked.status, 200); assert.ok([200, 401].includes(signed.status));
      assert.equal(await db.authSession.count({ where: { userId: res.body.id, revokedAt: null } }), 0);
      if (signed.status === 200) assert.equal((await request('/orders', signed.body.accessToken)).status, 401);
    });
    await t.test('seed rerun preserves password/locked status/scopes and never elevates legacy users', async () => {
      const before = await db.user.findUniqueOrThrow({ where: { id: one.id } });
      const scopeCount = await db.userRoleScope.count();
      const legacyBefore = await db.userRoleScope.count({ where: { user: { username: 'pre_auth_legacy' } } });
      const demo = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
      const demoScope = await db.userRoleScope.findFirstOrThrow({ where: { userId: demo.id } });
      await db.user.update({ where: { id: demo.id }, data: { active: false } });
      await db.userRoleScope.update({ where: { id: demoScope.id }, data: { active: false } });
      try {
        await seedAuth(db);
        const seeded = await db.user.findUniqueOrThrow({ where: { id: demo.id } });
        assert.equal(seeded.active, false); assert.ok(seeded.password === demo.password);
        assert.equal((await db.userRoleScope.findUniqueOrThrow({ where: { id: demoScope.id } })).active, false);
      } finally {
        await db.user.update({ where: { id: demo.id }, data: { active: demo.active } });
        await db.userRoleScope.update({ where: { id: demoScope.id }, data: { active: demoScope.active } });
      }
      const after = await db.user.findUniqueOrThrow({ where: { id: one.id } });
      assert.ok(after.password === before.password); assert.equal(after.active, false);
      assert.equal(await db.userRoleScope.count(), scopeCount);
      assert.equal(await db.userRoleScope.count({ where: { user: { username: 'pre_auth_legacy' } } }), legacyBefore);
      assert.equal(await db.rolePermission.count({ where: { roleId: dispatcherRole.id, permission: { code: { startsWith: 'users.' } } } }), 0);
    });
  } finally {
    for (const s of sockets) s.disconnect();
    await db.user.deleteMany({ where: { username: { startsWith: prefix } } });
    await app.close();
  }
});
