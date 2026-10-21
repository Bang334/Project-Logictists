const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monitorApp, fixture } = require('./monitor-test-app.cjs');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { randomUUID } = require('node:crypto');

test('Monitoring HTTP with real PostgreSQL and private filesystem', { timeout: 180000 }, async t => {
  const app = await monitorApp(), db = app.get(PrismaService), base = await app.getUrl();
  const req = async (path, token, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(options.headers || {}) } });
    const type = response.headers.get('content-type');
    return { status: response.status, headers: response.headers, body: type?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const login = async template => {
    const source = await db.user.findUniqueOrThrow({ where: { username: template } });
    const username = 'monitor_http_' + randomUUID();
    const account = await db.user.create({ data: { username, password: source.password, fullName: '[TEST] Read-only HTTP', role: source.role, branchId: source.branchId } });
    const grants = await db.userRoleScope.findMany({ where: { userId: source.id, active: true } });
    await db.userRoleScope.createMany({ data: grants.map(g => ({ userId: account.id, roleId: g.roleId, branchId: g.branchId, scopeType: g.scopeType })) });
    const response = await req('/auth/login', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: process.env.AUTH_DEMO_PASSWORD }) });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.accessToken;
  };
  try {
    const a = await login('demo_auth_a'), b = await login('demo_auth_b'), f = await fixture(app);
    const path = '/trip-monitoring/' + f.trip.id;
    await t.test('server pagination, filters, planned-start range and distinct delivered packages', async () => {
      const p = await req('/trip-monitoring?search=' + f.trip.tripNumber + '&pageSize=1', a);
      assert.equal(p.status, 200, JSON.stringify(p.body)); assert.equal(p.body.total, 1); assert.equal(p.body.items.length, 1);
      assert.equal(p.body.items[0].packageCount, 5); assert.equal(p.body.items[0].deliveredCount, 1); assert.equal(p.body.items[0].completedStopCount, 1);
      for (const filter of ['status=CANCELLED', 'from=2032-01-01T00:00:00Z', 'to=2031-01-01T01:00:00Z', 'vehicleId=' + randomUUID(), 'driverId=' + randomUUID()]) {
        assert.equal((await req('/trip-monitoring?search=' + f.trip.tripNumber + '&' + filter, a)).body.total, 0);
      }
      assert.equal((await req('/trip-monitoring?search=' + f.trip.tripNumber + '&driverId=' + f.driver.id, a)).body.total, 1);
      const resources = await req('/trip-monitoring/resources', a);
      assert.equal(resources.status, 200); assert(resources.body.vehicles.some(v => v.id === f.vehicle.id)); assert(resources.body.drivers.some(d => d.id === f.driver.id));
      const outsideResources = await req('/trip-monitoring/resources', b); assert(!outsideResources.body.vehicles.some(v => v.id === f.vehicle.id));
      assert.equal((await req('/trip-monitoring?search=' + f.trip.tripNumber + '&page=2&pageSize=1', a)).body.items.length, 0);
      for (const filter of ['page=0', 'pageSize=51', 'status=MADE_UP', 'from=bad', 'from=2032-01-01T00:00:00Z&to=2031-01-01T00:00:00Z', 'from=2031-01-01T00:00:00']) assert.equal((await req('/trip-monitoring?' + filter, a)).status, 400);
    });
    await t.test('read-only user, branch denial and nested data scope', async () => {
      assert.equal((await req(path, a)).status, 200);
      assert.equal((await req(path, b)).status, 404);
      assert.equal((await req(path + '/events', b)).status, 404);
      assert.equal((await req(path + '/pod/' + f.pod.id, b)).status, 404);
      assert.equal((await req('/trip-monitoring?branchId=' + f.a.id, b)).status, 403);
      assert.equal((await req('/trip-monitoring?search=' + f.trip.tripNumber, b)).body.total, 0);
      assert.equal((await req(path)).status, 401);
      assert.equal((await req(path + '/pod/' + randomUUID(), a)).status, 404);
      const other = await db.order.findUniqueOrThrow({ where: { orderNumber: 'DEMO-AUTH-ORDER-B' } });
      await db.stopTask.update({ where: { id: f.tasks[0].id }, data: { orderId: other.id } });
      try { assert.equal((await req(path, a)).status, 404); assert.equal((await req('/trip-monitoring?search=' + f.trip.tripNumber, a)).body.total, 0); }
      finally { await db.stopTask.update({ where: { id: f.tasks[0].id }, data: { orderId: null } }); }
    });
    await t.test('actual/planned, pickup, unloaded, reloaded, failed and delivered remain distinct', async () => {
      const d = (await req(path, a)).body;
      assert.equal(d.actualEndTime, null); assert.notEqual(d.actualStartTime, d.plannedStartTime);
      assert.equal(d.snapshot.sourceTripVersion, 2); assert.equal(d.version, 8);
      const tasks = d.stops.flatMap(s => s.tasks);
      assert(tasks.some(x => x.pickupResult?.outcome === 'NOT_COLLECTED'));
      for (const state of ['DELIVERED','UNLOADED','ON_VEHICLE','FAILED']) assert(tasks.some(x => x.deliveryState?.state === state));
      assert(tasks.some(x => x.deliveryState?.lastEvent.eventType === 'PACKAGE_RELOADED'));
      const results = tasks.flatMap(x => x.deliveryResults); assert.equal(results.filter(x => x.result === 'DELIVERED').length, 1);
      assert(!JSON.stringify(d).includes('storageKey')); assert(!JSON.stringify(d).includes('licenseNumber'));
      const history = await req(path + '/events?pageSize=2', a); assert.equal(history.body.items.length, 2); assert(history.body.total > 2);
      assert.notEqual(history.body.items[0].occurredAt, history.body.items[0].receivedAt);
      const second = await req(path + '/events?pageSize=2&page=2', a); assert(!second.body.items.some(x => history.body.items.some(y => x.id === y.id)));
      for (const status of ['DRAFT','PLANNED','DISPATCHED','IN_PROGRESS','COMPLETED','CANCELLED']) {
        await db.trip.update({ where: { id: f.trip.id }, data: { status } });
        const state = (await req(path, a)).body; assert.equal(state.status, status); assert.equal(state.actualEndTime, null);
        assert.equal((await req('/trip-monitoring?search=' + f.trip.tripNumber, a)).body.items[0].deliveredCount, 1);
      }
      await db.trip.update({ where: { id: f.trip.id }, data: { status: 'IN_PROGRESS' } });
    });
    await t.test('POD bytes, cache headers, pending, tampering, missing file and mismatched nesting', async () => {
      const podPath = path + '/pod/' + f.pod.id;
      const file = await req(podPath, a); assert.equal(file.status, 200); assert.equal(file.headers.get('cache-control'), 'private, no-store'); assert.equal(file.headers.get('x-content-type-options'), 'nosniff'); assert.equal(file.body.length, f.pod.sizeBytes);
      for (const uploadStatus of ['PENDING','UPLOADING','FAILED']) {
        await db.podFile.update({ where: { id: f.pod.id }, data: { uploadStatus } }); assert.equal((await req(podPath, a)).status, 409);
      }
      await db.podFile.update({ where: { id: f.pod.id }, data: { uploadStatus: 'UPLOADED', checksum: '0'.repeat(64) } }); assert.equal((await req(podPath, a)).status, 409);
      await db.podFile.update({ where: { id: f.pod.id }, data: { checksum: f.pod.checksum, storageKey: 'pod/missing.png' } }); assert.equal((await req(podPath, a)).status, 404);
      await db.podFile.update({ where: { id: f.pod.id }, data: { storageKey: f.pod.storageKey, tripStopId: f.pickup.id } }); assert.equal((await req(podPath, a)).status, 404); assert.equal((await req(path, a)).status, 409);
      await db.podFile.update({ where: { id: f.pod.id }, data: { tripStopId: f.stop.id } });
    });
    await t.test('revoked permission stops subsequent metadata and content', async () => {
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'trips.read' } });
      await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
      try { assert.equal((await req(path, a)).status, 403); assert.equal((await req(path + '/pod/' + f.pod.id, a)).status, 403); }
      finally { await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } }); }
    });
  } finally { await app.close(); }
});
