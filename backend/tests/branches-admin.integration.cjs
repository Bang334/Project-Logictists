const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { seedAuth } = require('../dist/prisma/seed-auth');

test('Branch administration with real PostgreSQL guards', { timeout: 90000 }, async t => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/tms_auth_test');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  try {
    await app.listen(0, '127.0.0.1');
    const db = app.get(PrismaService), base = await app.getUrl();
    await seedAuth(db);
    const request = async (path, token, method = 'GET', body, key = randomUUID()) => {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    const signed = await request('/auth/login', null, 'POST', { username: 'demo_auth_admin', password: process.env.AUTH_DEMO_PASSWORD });
    assert.equal(signed.status, 200); const token = signed.body.accessToken;
    const code = 'B-' + randomUUID(), payload = { code, name: '[TEST] Branch', address: '[TEST] Actual input', latitude: 10, longitude: 106 };
    let branch;
    await t.test('dispatcher cannot administer branches', async () => {
      const login = await request('/auth/login', null, 'POST', { username: 'demo_auth_a', password: process.env.AUTH_DEMO_PASSWORD });
      assert.equal(login.status, 200);
      for (const [path, method, body] of [['/branches/admin-list', 'GET'], ['/branches', 'POST', payload]]) {
        assert.equal((await request(path, login.body.accessToken, method, body)).status, 403);
      }
    });
    await t.test('concurrent create retries save one branch and one audit', async () => {
      const key = randomUUID();
      const results = await Promise.all([1, 2].map(() => request('/branches', token, 'POST', payload, key)));
      assert.ok(results.every(result => result.status === 201));
      branch = results[0].body; assert.equal(branch.id, results[1].body.id);
      assert.equal(await db.auditLog.count({ where: { entityId: branch.id, action: 'BRANCH_CREATED' } }), 1);
      assert.equal((await request('/branches', token, 'POST', { ...payload, code: code.toLowerCase() })).status, 409);
      assert.equal((await request('/branches', token, 'POST', { ...payload, name: 'Changed' }, key)).status, 409);
      const duplicates = await Promise.all([1, 2].map(() => request('/branches', token, 'POST', { ...payload, code: 'D-' + code.slice(2) })));
      assert.deepEqual(duplicates.map(result => result.status).sort(), [201, 409]);
    });
    await t.test('edit validates input and preserves zero coordinates; competing versions have one winner', async () => {
      for (const changes of [{ name: '   ' }, { latitude: null }, { latitude: 91 }, { longitude: -181 }, { timezone: 'invalid' }, { active: false }]) {
        assert.equal((await request(`/branches/${branch.id}`, token, 'PATCH', { expectedUpdatedAt: branch.updatedAt, ...changes })).status, 400);
      }
      const edits = await Promise.all([1, 2].map(index => request(`/branches/${branch.id}`, token, 'PATCH', { expectedUpdatedAt: branch.updatedAt, name: '[TEST] Edit ' + index, latitude: 0, longitude: 0 })));
      assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
      branch = edits.find(result => result.status === 200).body;
      assert.equal(branch.latitude, 0); assert.equal(branch.longitude, 0);
    });
    await t.test('deactivate/reactivate preserve scopes; stale version is rejected', async () => {
      const result = await request(`/branches/${branch.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: branch.updatedAt });
      assert.equal(result.status, 200); assert.equal(result.body.active, false);
      assert.equal((await request(`/branches/${branch.id}`, token, 'PATCH', { name: 'Stale', expectedUpdatedAt: branch.updatedAt })).status, 409);
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const user = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
      await assert.rejects(db.userRoleScope.create({ data: { userId: user.id, roleId: role.id, branchId: branch.id, scopeType: 'BRANCH' } }));
      const activated = await request(`/branches/${branch.id}/status`, token, 'PATCH', { active: true, expectedUpdatedAt: result.body.updatedAt });
      assert.equal(activated.status, 200); branch = activated.body;
      assert.equal(await db.userRoleScope.count({ where: { branchId: branch.id } }), 0);
    });
    await t.test('deactivation racing with a new driver cannot leave an inactive branch with that driver', async () => {
      const identity = randomUUID();
      const results = await Promise.allSettled([
        db.driver.create({ data: { citizenId: identity, licenseNumber: identity, fullName: '[TEST] Concurrent driver', phone: '0000000000', licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: branch.id } }),
        request(`/branches/${branch.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: branch.updatedAt }),
      ]);
      const persisted = await db.branch.findUniqueOrThrow({ where: { id: branch.id } });
      const driverCount = await db.driver.count({ where: { homeBranchId: branch.id } });
      assert.ok(persisted.active || driverCount === 0);
      if (results[0].status === 'fulfilled') {
        assert.equal(persisted.active, true);
        const blocked = await request(`/branches/${branch.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: persisted.updatedAt });
        assert.equal(blocked.status, 409); assert.equal(blocked.body.impacts.drivers, 1);
      } else assert.equal(persisted.active, false);
    });
    await t.test('scope, trip and reservation writes racing deactivation cannot leave live links', async () => {
      const user = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
      for (const kind of ['scope', 'trip', 'reservation']) {
        const created = await request('/branches', token, 'POST', { ...payload, code: 'R-' + randomUUID() });
        assert.equal(created.status, 201); const target = created.body;
        const tripData = { tripNumber: 'TEST-' + randomUUID(), vehicleId: vehicle.id, managingBranchId: target.id, plannedStartTime: new Date('2035-01-01'), plannedEndTime: new Date('2035-01-02') };
        const history = kind === 'reservation' ? await db.trip.create({ data: { ...tripData, status: 'COMPLETED' } }) : null;
        const write = () => kind === 'scope'
          ? db.userRoleScope.create({ data: { userId: user.id, roleId: role.id, branchId: target.id, scopeType: 'BRANCH' } })
          : kind === 'trip' ? db.trip.create({ data: tripData })
          : db.resourceReservation.create({ data: { tripId: history.id, vehicleId: vehicle.id, startsAt: new Date('2035-01-01'), endsAt: new Date('2035-01-02'), status: 'HELD' } });
        const results = await Promise.allSettled([write(), request(`/branches/${target.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: target.updatedAt })]);
        const persisted = await db.branch.findUniqueOrThrow({ where: { id: target.id } });
        if (results[0].status === 'fulfilled') {
          assert.equal(persisted.active, true, kind);
          const blocked = await request(`/branches/${target.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: persisted.updatedAt });
          assert.equal(blocked.status, 409);
          assert.equal(blocked.body.impacts[{ scope: 'accounts', trip: 'trips', reservation: 'reservations' }[kind]], 1);
          if (history) {
            const inactive = await db.branch.create({ data: { ...payload, code: 'I-' + randomUUID(), active: false } });
            await assert.rejects(db.trip.update({ where: { id: history.id }, data: { managingBranchId: inactive.id } }));
            assert.equal((await db.trip.findUniqueOrThrow({ where: { id: history.id } })).managingBranchId, target.id);
          }
        } else {
          assert.equal(results[1].status, 'fulfilled'); assert.equal(results[1].value.status, 200);
          assert.equal(persisted.active, false, kind);
          await assert.rejects(write());
        }
      }
    });
    await t.test('reactivation preserves independently revoked scopes and completed history', async () => {
      const created = await request('/branches', token, 'POST', { ...payload, code: 'H-' + randomUUID() });
      const target = created.body;
      const user = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const scope = await db.userRoleScope.create({ data: { userId: user.id, roleId: role.id, branchId: target.id, scopeType: 'BRANCH', active: false } });
      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
      const history = await db.trip.create({ data: { tripNumber: 'HISTORY-' + randomUUID(), vehicleId: vehicle.id, managingBranchId: target.id, status: 'COMPLETED', plannedStartTime: new Date('2035-01-01'), plannedEndTime: new Date('2035-01-02') } });
      const stopped = await request(`/branches/${target.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: target.updatedAt });
      assert.equal(stopped.status, 200);
      const started = await request(`/branches/${target.id}/status`, token, 'PATCH', { active: true, expectedUpdatedAt: stopped.body.updatedAt });
      assert.equal(started.status, 200);
      assert.equal((await db.userRoleScope.findUniqueOrThrow({ where: { id: scope.id } })).active, false);
      assert.deepEqual(await db.trip.findUniqueOrThrow({ where: { id: history.id } }), history);
    });
    await t.test('live reservations on branch resources block even when managed elsewhere; retired vehicles alone do not', async () => {
      const target = (await request('/branches', token, 'POST', { ...payload, code: 'V-' + randomUUID() })).body;
      const other = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
      const vehicleType = await db.vehicleType.findUniqueOrThrow({ where: { code: 'DEMO-AUTH' } });
      const vehicle = await db.vehicle.create({ data: { plateNumber: 'TEST-' + randomUUID(), model: '[TEST] Retired', homeBranchId: target.id, vehicleTypeId: vehicleType.id, status: 'DECOMMISSIONED' } });
      const history = await db.trip.create({ data: { tripNumber: 'TEST-' + randomUUID(), vehicleId: vehicle.id, managingBranchId: other.id, status: 'COMPLETED', plannedStartTime: new Date('2035-01-01'), plannedEndTime: new Date('2035-01-02') } });
      const reservationData = { tripId: history.id, vehicleId: vehicle.id, startsAt: new Date('2035-01-01'), endsAt: new Date('2035-01-02'), status: 'HELD' };
      const reservation = await db.resourceReservation.create({ data: reservationData });
      const blocked = await request(`/branches/${target.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: target.updatedAt });
      assert.equal(blocked.status, 409); assert.equal(blocked.body.impacts.vehicles, 0); assert.equal(blocked.body.impacts.reservations, 1);
      await db.resourceReservation.update({ where: { id: reservation.id }, data: { status: 'RELEASED' } });
      const stopped = await request(`/branches/${target.id}/status`, token, 'PATCH', { active: false, expectedUpdatedAt: target.updatedAt });
      assert.equal(stopped.status, 200);
      assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).homeBranchId, target.id);
      await assert.rejects(db.resourceReservation.create({ data: reservationData }));
      assert.deepEqual(await db.trip.findUniqueOrThrow({ where: { id: history.id } }), history);
    });
  } finally { await app.close(); }
});
