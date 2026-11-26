const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { start, fixtures, configure, executeSql, roleMigration, installFleetGuards, password, PrismaClient } = require('./three-roles-app.cjs');

test('Person 2 three roles on real PostgreSQL and HTTP', { timeout: 120000 }, async t => {
  configure();
  const fixtureDb = new PrismaClient();
  const f = await fixtures(fixtureDb);
  await installFleetGuards(fixtureDb);
  const oldSession = await fixtureDb.authSession.create({ data: { userId: f.users.legacy.id, expiresAt: new Date(Date.now() + 600000) } });
  // Duplicate target scope on the same branch must merge, preserving the retired history.
  await fixtureDb.userRoleScope.upsert({ where: { userId_roleId_scopeType_branchId: { userId: f.users.legacy.id, roleId: f.roles.TRANSPORT_DISPATCHER.id, scopeType: 'BRANCH', branchId: f.branches[0].id } }, create: { userId: f.users.legacy.id, roleId: f.roles.TRANSPORT_DISPATCHER.id, scopeType: 'BRANCH', branchId: f.branches[0].id }, update: { active: true } });
  await t.test('migration rolls back ambiguous branches, then merges same-branch grants and revokes old sessions', async () => {
    await fixtureDb.accessRole.update({ where: { id: f.roles.ORDER_SCHEDULER.id }, data: { active: false } });
    await assert.rejects(executeSql(fixtureDb, roleMigration()), /THREE_ROLES_RECONCILIATION_REQUIRED/);
    await fixtureDb.accessRole.update({ where: { id: f.roles.ORDER_SCHEDULER.id }, data: { active: true } });
    const ambiguous = await fixtureDb.userRoleScope.upsert({ where: { userId_roleId_scopeType_branchId: { userId: f.users.legacy.id, roleId: f.roles.ORDER_SCHEDULER.id, scopeType: 'BRANCH', branchId: f.branches[1].id } }, create: { userId: f.users.legacy.id, roleId: f.roles.ORDER_SCHEDULER.id, scopeType: 'BRANCH', branchId: f.branches[1].id }, update: { active: true } });
    await assert.rejects(executeSql(fixtureDb, roleMigration()), /THREE_ROLES_RECONCILIATION_REQUIRED/);
    assert.equal((await fixtureDb.authSession.findUniqueOrThrow({ where: { id: oldSession.id } })).revokedAt, null);
    await fixtureDb.userRoleScope.update({ where: { id: ambiguous.id }, data: { active: false } });
    const adminPermissions = await fixtureDb.rolePermission.count({ where: { roleId: f.roles.ADMIN.id } });
    await executeSql(fixtureDb, roleMigration());
    assert.equal(await fixtureDb.rolePermission.count({ where: { roleId: f.roles.ADMIN.id } }), adminPermissions);
    const scopes = await fixtureDb.userRoleScope.findMany({ where: { userId: f.users.legacy.id }, include: { role: true } });
    assert.deepEqual(scopes.filter(s => s.active).map(s => [s.role.code, s.branchId]), [['TRANSPORT_DISPATCHER', f.branches[0].id]]);
    assert.ok(scopes.some(s => !s.active && s.role.code === 'ORDER_SCHEDULER'));
    assert.ok((await fixtureDb.authSession.findUniqueOrThrow({ where: { id: oldSession.id } })).revokedAt);
    assert.equal((await fixtureDb.accessRole.findUniqueOrThrow({ where: { code: 'ORDER_SCHEDULER' } })).active, false);
  });
  await fixtureDb.$disconnect();
  const { app, db, base } = await start();
  const request = async (path, token, method = 'GET', body, headers = {}) => {
    const result = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: result.status, body: await result.json() };
  };
  const tokens = {};
  const login = key => request('/auth/login', null, 'POST', { username: 'roles_test_' + key, password });
  try {
    for (const key of ['admin','lead','resource','transport','legacy','other']) { const result = await login(key); assert.equal(result.status, 200, 'Login for ' + key); tokens[key] = result.body.accessToken; }
    await t.test('profiles expose approved capabilities; scheduler now logs in as transport', async () => {
      const profiles = {};
      for (const key of ['lead','resource','transport','legacy']) { profiles[key] = (await request('/auth/profile', tokens[key])).body; assert.equal(profiles[key].branches[0].id, f.branches[0].id); }
      assert.ok(profiles.lead.permissions.includes('trips.approve')); assert.ok(!profiles.lead.permissions.includes('trips.publish'));
      assert.ok(profiles.resource.permissions.includes('drivers.manage')); assert.ok(!profiles.resource.permissions.includes('orders.write'));
      assert.ok(profiles.transport.permissions.includes('orders.write')); assert.ok(profiles.transport.permissions.includes('trips.publish')); assert.ok(!profiles.transport.permissions.includes('trips.plan'));
      assert.equal(profiles.legacy.grants[0].role, 'TRANSPORT_DISPATCHER');
      assert.equal(profiles.legacy.role, 'STAFF');
      const locations = await request('/locations', tokens.legacy);
      assert.equal(locations.status, 200);
      assert.deepEqual(locations.body.map(location => location.id), [f.locations[0].id]);
    });
    await t.test('read endpoints and lookup endpoints enforce roles and branch ownership', async () => {
      assert.equal((await request('/orders', tokens.lead)).status, 200);
      assert.equal((await request('/orders', tokens.resource)).status, 403);
      assert.equal((await request('/orders', tokens.transport)).status, 200);
      assert.equal((await request('/customers/lookup?branchId=' + f.branches[0].id, tokens.transport)).status, 200);
      assert.equal((await request('/customers/lookup', tokens.resource)).status, 403);
      for (const key of ['lead','resource','transport']) {
        assert.equal((await request('/fleet/drivers', tokens[key])).status, 200);
        assert.equal((await request('/fleet/vehicles/' + f.vehicles[1].id, tokens[key])).status, 404);
        assert.equal((await request('/fleet/drivers?branchId=' + f.branches[1].id, tokens[key])).status, 403);
        assert.equal((await request('/monitoring/' + f.trips[1].id, tokens[key])).status, 404);
        assert.equal((await request('/users', tokens[key])).status, 403);
      }
      for (const key of ['lead','transport']) assert.equal((await request('/orders/' + f.orders[1].id, tokens[key])).status, 404);
      assert.equal((await request('/users', tokens.admin)).status, 200);
    });
    await t.test('accidental database grants cannot exceed the role policy or a selected branch', async () => {
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'orders.write' } });
      await db.rolePermission.create({ data: { roleId: f.roles.RESOURCE_MANAGER.id, permissionId: permission.id } });
      try {
        const profile = await request('/auth/profile', tokens.resource);
        assert.ok(!profile.body.permissions.includes('orders.write'));
        assert.equal((await request('/orders/' + f.orders[0].id + '/confirm', tokens.resource, 'POST', { version: 1 }, { 'Idempotency-Key': randomUUID() })).status, 403);
      } finally { await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: f.roles.RESOURCE_MANAGER.id, permissionId: permission.id } } }); }
      assert.equal((await request('/fleet/drivers', tokens.resource, 'GET', undefined, { 'X-Branch-Id': f.branches[1].id })).status, 403);
    });
    await t.test('resource manager writes a shift, retries idempotently, rejects other roles/branches and shows affected trips', async () => {
      const interval = { startsAt: '2026-12-07T00:30:00.000Z', endsAt: '2026-12-07T10:00:00.000Z' };
      const data = { ...interval, kind: 'SHIFT', reason: 'Role authorization test', readyAt: interval.startsAt, readyAddress: 'Test', readyLatitude: 10, readyLongitude: 106 };
      const key = randomUUID(), path = '/fleet/drivers/' + f.drivers[0].id + '/schedules';
      for (const role of ['lead','transport']) assert.equal((await request(path, tokens[role], 'POST', data, { 'Idempotency-Key': randomUUID() })).status, 403);
      assert.equal((await request('/fleet/drivers/' + f.drivers[1].id + '/schedules', tokens.resource, 'POST', data, { 'Idempotency-Key': randomUUID() })).status, 404);
      const result = await request(path, tokens.resource, 'POST', data, { 'Idempotency-Key': key }); assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal((await request(path, tokens.resource, 'POST', data, { 'Idempotency-Key': key })).body.id, result.body.id);
      assert.equal((await request(path, tokens.resource, 'POST', { ...data, reason: 'Changed payload' }, { 'Idempotency-Key': key })).status, 409);
      const list = await request(path + '?' + new URLSearchParams(interval), tokens.lead); assert.equal(list.status, 200); assert.ok(list.body.items.some(s => s.id === result.body.id));
      const availability = await request('/fleet/vehicles/' + f.vehicles[0].id + '/availability?' + new URLSearchParams(interval), tokens.resource);
      assert.equal(availability.status, 200); assert.ok(availability.body.affectedTrips.some(trip => trip.id === f.trips[0].id));
      const maintenance = await request('/fleet/vehicles/' + f.vehicles[0].id + '/schedules', tokens.resource, 'POST', { ...interval, kind: 'MAINTENANCE', reason: 'Conflicts with dispatched trip' }, { 'Idempotency-Key': randomUUID() });
      assert.equal(maintenance.status, 409, JSON.stringify(maintenance.body));
      const breakdown = await request('/fleet/vehicles/' + f.vehicles[0].id + '/schedules', tokens.resource, 'POST', { ...interval, kind: 'BREAKDOWN', reason: 'Actual breakdown' }, { 'Idempotency-Key': randomUUID() }); assert.equal(breakdown.status, 201);
    });
    await t.test('transport processes orders; read-only lead and resource role cannot write', async () => {
      const path = '/orders/' + f.orders[0].id + '/confirm';
      for (const role of ['lead','resource']) assert.equal((await request(path, tokens[role], 'POST', { version: 1 }, { 'Idempotency-Key': randomUUID() })).status, 403);
      const result = await request(path, tokens.transport, 'POST', { version: 1 }, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.status, 'CONFIRMED');
      assert.equal((await request('/orders/' + f.orders[1].id + '/cancel', tokens.transport, 'POST', { version: 1, reason: 'Foreign branch' }, { 'Idempotency-Key': randomUUID() })).status, 404);
    });
    await t.test('ADMIN assigns exactly three roles; role change revokes sessions and rejects the old role', async () => {
      const legacyDto = { username: 'role_new_' + randomUUID(), fullName: 'Test', password, branchIds: [f.branches[0].id] };
      assert.equal((await request('/users', tokens.admin, 'POST', { ...legacyDto, roleCode: 'ORDER_SCHEDULER' }, { 'Idempotency-Key': randomUUID() })).status, 400);
      for (const roleCode of ['BRANCH_DISPATCH_LEAD','RESOURCE_MANAGER','TRANSPORT_DISPATCHER']) {
        const result = await request('/users', tokens.admin, 'POST', { ...legacyDto, username: 'role_new_' + randomUUID(), roleCode }, { 'Idempotency-Key': randomUUID() }); assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.roleScopes[0].role.code, roleCode);
      }
      const target = (await request('/users/' + f.users.transport.id, tokens.admin)).body;
      const result = await request('/users/' + target.id, tokens.admin, 'PATCH', { expectedUpdatedAt: target.updatedAt, fullName: target.fullName, roleCode: 'RESOURCE_MANAGER', branchIds: [f.branches[0].id] }); assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal((await request('/auth/profile', tokens.transport)).status, 401);
      const fresh = await login('transport'); assert.equal(fresh.status, 200); assert.ok(fresh.body.user.permissions.includes('drivers.manage')); assert.ok(!fresh.body.user.permissions.includes('orders.write'));
      assert.ok(await db.auditLog.findFirst({ where: { entityId: target.id, action: 'ACCOUNT_UPDATED' } }));
      const legacy = await db.user.findUniqueOrThrow({ where: { id: f.users.legacy.id } });
      const locked = await request('/users/' + legacy.id + '/lock', tokens.admin, 'PATCH', { expectedUpdatedAt: legacy.updatedAt.toISOString() });
      assert.equal(locked.status, 200); assert.equal((await request('/auth/profile', tokens.legacy)).status, 401);
    });
  } finally { await app.close(); }
});
