// Real PostgreSQL + HTTP + Socket.IO. Never runs against the development database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { JwtService } = require('@nestjs/jwt');
const { io } = require('../../frontend/node_modules/socket.io-client');
const { AppModule } = require('../dist/src/app.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthService } = require('../dist/src/auth/auth.service');
const { EventsGateway } = require('../dist/src/events/events.gateway');
const { seedAuth } = require('../dist/prisma/seed-auth');

test('Auth and branch isolation on PostgreSQL', { timeout: 90000 }, async t => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/tms_auth_test', 'Refusing non-test database');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService);
  const base = await app.getUrl();
  const clients = [];
  const request = async (path, token, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const login = (username, password = process.env.AUTH_DEMO_PASSWORD) => request('/auth/login', null, 'POST', { username, password });
  const socket = token => { const s = io(base, { auth: { token }, transports: ['websocket'], forceNew: true, reconnection: false }); clients.push(s); return s; };
  const connected = s => new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
  const ack = (s, event, data) => new Promise((resolve, reject) => s.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  try {
    await seedAuth(db);
    await db.authLoginLimit.deleteMany();
    const a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const b = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } });
    const ua = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
    const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
    const adminRole = await db.accessRole.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const adminUser = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_admin' } });
    const oa = await db.order.findUniqueOrThrow({ where: { orderNumber: 'DEMO-AUTH-ORDER-A' }, include: { stops: true, items: true } });
    const ob = await db.order.findUniqueOrThrow({ where: { orderNumber: 'DEMO-AUTH-ORDER-B' } });
    const va = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
    const vb = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-B' } });
    const da = await db.driver.findUniqueOrThrow({ where: { citizenId: 'DEMO-AUTH-A' } });
    const dbDriver = await db.driver.findUniqueOrThrow({ where: { citizenId: 'DEMO-AUTH-B' } });
    const ta = await db.trip.findUniqueOrThrow({ where: { tripNumber: 'DEMO-AUTH-TRIP-A' } });
    const tb = await db.trip.findUniqueOrThrow({ where: { tripNumber: 'DEMO-AUTH-TRIP-B' } });
    const admin = (await login('demo_auth_admin')).body.accessToken;
    const tokenA = (await login('demo_auth_a')).body.accessToken;
    const tokenB = (await login('demo_auth_b')).body.accessToken;
    assert.ok(admin && tokenA && tokenB);

    await t.test('seed rerun preserves users, passwords and grants', async () => {
      const before = await db.user.count(); const scopes = await db.userRoleScope.count();
      await seedAuth(db);
      assert.equal(await db.user.count(), before); assert.equal(await db.userRoleScope.count(), scopes);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: ua.id } })).password, ua.password);
    });
    await t.test('login errors and runtime validation are distinct', async () => {
      assert.equal((await login('demo_auth_a', 'incorrect')).body.code, 'INVALID_CREDENTIALS');
      assert.equal((await login('demo_auth_locked')).body.code, 'ACCOUNT_DISABLED');
      assert.equal((await login('demo_auth_no_scope')).body.code, 'NO_SCOPE');
      for (const body of [{}, { username: {}, password: [] }, { username: ' ', password: 'x' }, { username: 'demo_auth_a', password: 'x', role: 'ADMIN' }]) assert.equal((await request('/auth/login', null, 'POST', body)).status, 400);
    });
    await t.test('profile comes from grants and omits internal credentials', async () => {
      const response = await request('/auth/profile', tokenA); assert.equal(response.status, 200);
      assert.equal(response.body.grants[0].branchId, a.id); assert.equal(response.body.branches.length, 1);
      assert.ok(!('password' in response.body) && !('sessionId' in response.body) && !('role' in response.body));
    });
    await t.test('missing, forged, expired and legacy JWT rejected', async () => {
      const jwt = new JwtService({ secret: process.env.JWT_SECRET });
      const session = await db.authSession.findFirstOrThrow({ where: { userId: ua.id } });
      for (const token of [undefined, 'forged', jwt.sign({ sub: ua.id, role: 'ADMIN' }), jwt.sign({ sub: ua.id, sid: session.id }, { expiresIn: -1, issuer: 'tms', audience: 'tms-web' })]) assert.equal((await request('/orders', token)).status, 401);
    });
    await t.test('company admin sees both branches and all demo resources', async () => {
      for (const endpoint of ['/branches', '/vehicles', '/drivers', '/orders', '/trips', '/customers']) {
        const response = await request(endpoint, admin); assert.equal(response.status, 200); assert.ok(response.body.length >= 2, endpoint);
      }
      assert.equal((await request('/branches/' + b.id, admin, 'PATCH', { phone: '0000000000' })).status, 200);
    });
    await t.test('lists, filters and direct IDs isolate A from B', async () => {
      for (const [endpoint, ownId, foreignId] of [['branches', a.id, b.id], ['vehicles', va.id, vb.id], ['drivers', da.id, dbDriver.id], ['orders', oa.id, ob.id], ['trips', ta.id, tb.id], ['customers', oa.customerId, ob.customerId]]) {
        const list = await request('/' + endpoint, tokenA); assert.equal(list.status, 200, endpoint);
        assert.ok(list.body.some(r => r.id === ownId), endpoint); assert.ok(!list.body.some(r => r.id === foreignId), endpoint);
        const detail = await request('/' + endpoint + '/' + foreignId, tokenA);
        assert.ok(detail.status === 404 || detail.body === null, endpoint);
      }
      for (const endpoint of ['vehicles','drivers','orders','trips']) assert.equal((await request('/' + endpoint + '?branchId=' + b.id, tokenA)).status, 403);
      assert.equal((await request('/orders', tokenA, 'GET', undefined, { 'X-Branch-Id': b.id })).status, 403);
      assert.equal((await request('/trips/' + tb.id + '/load-profile', tokenA)).status, 404);
    });
    await t.test('dispatcher cannot modify master data, even within own branch', async () => {
      for (const [path, body] of [['/branches/' + a.id, { name: 'tamper' }], ['/vehicles/' + va.id, { model: 'tamper' }], ['/drivers/' + da.id, { fullName: 'tamper' }]]) assert.equal((await request(path, tokenA, 'PATCH', body)).status, 403);
      assert.equal((await request('/users/' + ua.id, tokenA, 'PATCH', { role: 'ADMIN' })).status, 404);
    });
    await t.test('order writes persist and foreign IDs/customer payloads are refused', async () => {
      assert.equal((await request('/orders/' + ob.id, tokenA, 'PATCH', { notes: 'tamper' })).status, 404);
      assert.equal((await request('/orders/' + oa.id, tokenA, 'PATCH', { customerId: ob.customerId })).status, 403);
      const dto = { branchId: a.id, customerId: oa.customerId, notes: '[TEST AUTH] persisted', items: [{ description: 'demo', quantity: 1, weightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10 }], stops: oa.stops.map(s => ({ type: s.type, sequence: s.sequence, address: s.address, latitude: s.latitude, longitude: s.longitude, contactName: s.contactName, contactPhone: s.contactPhone })) };
      assert.equal((await request('/orders', tokenA, 'POST', { ...dto, branchId: b.id })).status, 403);
      assert.equal((await request('/orders', tokenA, 'POST', { ...dto, customerId: ob.customerId })).status, 403);
      const created = await request('/orders', tokenA, 'POST', dto); assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal((await request('/orders/' + created.body.id, tokenA)).body.notes, dto.notes);
      assert.equal((await request('/orders/' + created.body.id, tokenB)).status, 404);
      assert.equal((await request('/orders/' + created.body.id, tokenA, 'PATCH', { notes: '[TEST AUTH] updated' })).status, 200);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: created.body.id } })).notes, '[TEST AUTH] updated');
    });
    await t.test('mixed trip resources and foreign stop IDs rejected before providers', async () => {
      const dto = { branchId: a.id, vehicleId: va.id, driverId: da.id, orderIds: [oa.id], plannedStartTime: '2031-01-01T00:00:00Z', plannedEndTime: '2031-01-01T05:00:00Z' };
      for (const patch of [{ vehicleId: vb.id }, { driverId: dbDriver.id }, { orderIds: [ob.id] }, { orderedStopIds: [randomUUID()] }]) assert.equal((await request('/trips', tokenA, 'POST', { ...dto, ...patch })).status, 403);
      assert.equal((await request('/trips/optimize', tokenA, 'POST', { branchId: a.id, vehicleId: va.id, orderIds: [ob.id] })).status, 403);
      assert.equal((await request('/trips/automatic-optimization', tokenA, 'POST', { branchId: b.id })).status, 403);
      assert.equal((await request('/trips/' + tb.id + '/publish', tokenA, 'PATCH')).status, 404);
      assert.equal((await request('/trips', tokenA, 'POST', { ...dto, plannedEndTime: dto.plannedStartTime })).status, 400, 'authorized planning still runs the business validator');
      await db.trip.update({ where: { id: ta.id }, data: { status: 'DRAFT' } });
      try { assert.equal((await request('/trips/' + ta.id + '/publish', tokenA, 'PATCH')).status, 200); }
      finally { await db.trip.update({ where: { id: ta.id }, data: { status: ta.status } }); }
    });
    await t.test('shared customer counts and nested orders are scoped', async () => {
      await db.order.update({ where: { id: ob.id }, data: { customerId: oa.customerId } });
      try {
        const list = await request('/customers', tokenA); const customer = list.body.find(c => c.id === oa.customerId);
        assert.equal(customer._count.orders, await db.order.count({ where: { branchId: a.id, customerId: oa.customerId } }));
        const detail = await request('/customers/' + oa.customerId, tokenA); assert.ok(detail.body.orders.every(o => o.branchId === a.id));
      } finally { await db.order.update({ where: { id: ob.id }, data: { customerId: ob.customerId } }); }
    });
    await t.test('legacy mixed-branch trip cannot leak through nested vehicle or driver history', async () => {
      await db.trip.update({ where: { id: tb.id }, data: { vehicleId: va.id } });
      try {
        assert.ok(!(await request('/vehicles/' + va.id, tokenA)).body.trips.some(r => r.id === tb.id));
        assert.equal((await request('/trips/' + tb.id, tokenA)).status, 404);
      } finally { await db.trip.update({ where: { id: tb.id }, data: { vehicleId: vb.id } }); }
    });
    await t.test('legacy User.role does not grant company access', async () => {
      await db.user.update({ where: { id: ua.id }, data: { role: 'ADMIN' } });
      try { assert.equal((await request('/branches/' + a.id, tokenA, 'PATCH', { name: 'tamper' })).status, 403); }
      finally { await db.user.update({ where: { id: ua.id }, data: { role: ua.role } }); }
    });
    await t.test('scope revocation, role inactivity and account lock take effect on existing token', async () => {
      await db.userRoleScope.updateMany({ where: { userId: ua.id }, data: { active: false } });
      try { assert.equal((await request('/orders', tokenA)).status, 403); assert.deepEqual((await request('/auth/profile', tokenA)).body.branches, []); }
      finally { await db.userRoleScope.updateMany({ where: { userId: ua.id }, data: { active: true } }); }
      await db.accessRole.update({ where: { id: role.id }, data: { active: false } });
      try { assert.equal((await request('/orders', tokenA)).status, 403); }
      finally { await db.accessRole.update({ where: { id: role.id }, data: { active: true } }); }
      await db.user.update({ where: { id: ua.id }, data: { active: false } });
      try { assert.equal((await request('/orders', tokenA)).body.code, 'ACCOUNT_DISABLED'); }
      finally { await db.user.update({ where: { id: ua.id }, data: { active: true } }); }
    });
    await t.test('removing a role permission affects the next request', async () => {
      const p = await db.permission.findUniqueOrThrow({ where: { code: 'orders.write' } });
      await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: p.id } } });
      try { assert.equal((await request('/orders/' + oa.id, tokenA, 'PATCH', { notes: 'tamper' })).status, 403); }
      finally { await db.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }); }
    });
    await t.test('multiple BRANCH grants supported without widening other users', async () => {
      const scope = await db.userRoleScope.create({ data: { userId: ua.id, roleId: role.id, scopeType: 'BRANCH', branchId: b.id } });
      try {
        assert.equal((await request('/auth/profile', tokenA)).body.branches.length, 2);
        assert.equal((await request('/orders/' + ob.id, tokenA)).status, 200);
        const mixed = { branchId: a.id, vehicleId: vb.id, driverId: dbDriver.id, orderIds: [ob.id], plannedStartTime: '2031-01-01T00:00:00Z', plannedEndTime: '2031-01-01T05:00:00Z' };
        assert.equal((await request('/trips', tokenA, 'POST', mixed)).status, 403, 'related resources must belong to the selected managing branch');
      }
      finally { await db.userRoleScope.delete({ where: { id: scope.id } }); }
    });
    await t.test('DB01 CHECK, FK and NULL-safe uniqueness enforced by PostgreSQL', async () => {
      const invalid = [
        { userId: ua.id, roleId: role.id, scopeType: 'COMPANY', branchId: a.id },
        { userId: ua.id, roleId: role.id, scopeType: 'BRANCH', branchId: null },
        { userId: ua.id, roleId: role.id, scopeType: 'BRANCH', branchId: randomUUID() },
        { userId: ua.id, roleId: role.id, scopeType: 'BRANCH', branchId: a.id },
        { userId: adminUser.id, roleId: adminRole.id, scopeType: 'COMPANY', branchId: null },
      ];
      for (const data of invalid) await assert.rejects(db.userRoleScope.create({ data }));
    });
    await t.test('concurrent COMPANY grants cannot bypass NULL uniqueness', async () => {
      const user = await db.user.create({ data: { username: 'test-concurrent-' + randomUUID(), password: 'not-login', fullName: '[TEST]' } });
      const data = { userId: user.id, roleId: adminRole.id, scopeType: 'COMPANY', branchId: null };
      const outcomes = await Promise.allSettled([db.userRoleScope.create({ data }), db.userRoleScope.create({ data })]);
      assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    });
    await t.test('login limiter configured, concurrent, persistent and expires', async () => {
      const previousWindow = process.env.AUTH_LOGIN_WINDOW_SECONDS;
      const previousLimit = process.env.AUTH_LOGIN_MAX_ATTEMPTS;
      process.env.AUTH_LOGIN_WINDOW_SECONDS = '1';
      process.env.AUTH_LOGIN_MAX_ATTEMPTS = '2';
      const service = new AuthService(db, new JwtService(), new ConfigService());
      if (previousWindow === undefined) delete process.env.AUTH_LOGIN_WINDOW_SECONDS; else process.env.AUTH_LOGIN_WINDOW_SECONDS = previousWindow;
      if (previousLimit === undefined) delete process.env.AUTH_LOGIN_MAX_ATTEMPTS; else process.env.AUTH_LOGIN_MAX_ATTEMPTS = previousLimit;
      const username = 'missing-' + randomUUID();
      const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => service.login({ username, password: 'wrong' }, 'test-' + username)));
      assert.equal(attempts.filter(x => x.status === 'rejected' && x.reason.getStatus() === 429).length, 1);
      await new Promise(resolve => setTimeout(resolve, 1100));
      await assert.rejects(service.login({ username, password: 'wrong' }, 'test-' + username), e => e.getStatus() === 401);
    });
    await t.test('socket handshake/room authorization and event isolation', async () => {
      const invalid = socket('forged'); await assert.rejects(connected(invalid));
      const sa = socket(tokenA), sb = socket(tokenB); await Promise.all([connected(sa), connected(sb)]);
      assert.equal((await ack(sa, 'join:branch', b.id)).ok, false);
      assert.equal((await ack(sa, 'join:branch', a.id)).ok, true);
      assert.equal((await ack(sb, 'join:branch', b.id)).ok, true);
      let aEvents = 0, bEvents = 0; sa.on('trip:updated', () => aEvents++); sb.on('trip:updated', () => bEvents++);
      await app.get(EventsGateway).emitTripUpdate({ id: tb.id }); await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(aEvents, 0); assert.equal(bEvents, 1);
      await db.userRoleScope.updateMany({ where: { userId: ua.id }, data: { active: false } });
      try { await app.get(EventsGateway).emitTripUpdate({ id: ta.id }); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(aEvents, 0); }
      finally { await db.userRoleScope.updateMany({ where: { userId: ua.id }, data: { active: true } }); }
    });
    await t.test('logout revokes bearer in database, including sockets', async () => {
      assert.equal((await request('/auth/logout', tokenA, 'POST')).status, 200);
      assert.equal((await request('/orders', tokenA)).status, 401);
      const revoked = socket(tokenA); await assert.rejects(connected(revoked));
      assert.equal((await request('/auth/profile', tokenB)).status, 200);
    });
  } finally {
    for (const client of clients) client.disconnect();
    await app.close();
  }
});
