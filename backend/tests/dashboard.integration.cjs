const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboardApp } = require('./dashboard-test-app.cjs');
test('Dashboard counts and scope on real PostgreSQL + HTTP', { timeout: 180000 }, async t => {
  const { app, db, data: f } = await dashboardApp(), base = await app.getUrl();
  const req = async (path, token, init = {}) => {
    const res = await fetch(base + path, { ...init, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...init.headers } });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const login = async u => {
    const r = await req('/auth/login', null, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u.username, password: process.env.AUTH_DEMO_PASSWORD }) });
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.accessToken;
  };
  const range = 'from=2031-01-02T00:00:00%2B07:00&to=2031-01-03T00:00:00%2B07:00';
  const summary = '/dashboard/summary?' + range;
  try {
    const a = await login(f.viewer), b = await login(f.other), multi = await login(f.multi);
    await t.test('independent expected counts, current vs period, no join multiplication', async () => {
      const r = await req(summary, a);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(r.body.metrics, { candidateOrders: 2, availableVehicles: 1, availableDrivers: 2, plannedTrips: 1, dispatchedTrips: 1, activeTrips: 1, departedTrips: 2, completedTrips: 1 });
      assert.deepEqual(r.body.issues, { reviewOrders: 1, expiredDrivers: 1, blockedVehicles: 1 });
      assert.equal(r.body.missingCompletionTime, 1);
      const next = await req('/dashboard/summary?from=2031-01-02T17:00:00Z&to=2031-01-03T17:00:00Z', a);
      assert.equal(next.body.metrics.departedTrips, 1); assert.equal(next.body.metrics.completedTrips, 1);
      assert.equal(next.body.metrics.candidateOrders, 2); assert.equal(next.body.metrics.activeTrips, 1);
      const old = await req('/dashboard/summary?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z', a);
      assert.equal(old.body.metrics.candidateOrders, 2); assert.equal(old.body.metrics.departedTrips, 0);
    });
    await t.test('drilldowns match totals, stable server pages, evidence and minimal fields', async () => {
      for (const [metric,total] of [['candidateOrders',2],['reviewOrders',1],['availableVehicles',1],['availableDrivers',2],['expiredDrivers',1],['blockedVehicles',1]]) {
        const r = await req('/dashboard/items?metric=' + metric + '&pageSize=1', a);
        assert.equal(r.status,200,JSON.stringify(r.body)); assert.equal(r.body.total,total); assert.equal(r.body.items.length,1);
        assert(r.body.items[0].evidence); assert(r.body.items[0].evidenceAt);
        assert(!JSON.stringify(r.body).includes('licenseNumber')); assert(!JSON.stringify(r.body).includes('citizenId'));
        const next = await req('/dashboard/items?metric=' + metric + '&pageSize=1&page=2', a);
        assert.equal(next.body.total,total); assert.equal(next.body.items.length,total-1);
        if (next.body.items[0]) assert.notEqual(next.body.items[0].id,r.body.items[0].id);
      }
      const trips = await req('/trip-monitoring?' + range + '&timeBasis=actualStartTime&pageSize=1', a);
      assert.equal(trips.body.total,2); assert.equal(trips.body.items.length,1);
      assert.equal((await req('/trip-monitoring?' + range + '&timeBasis=actualEndTime&status=COMPLETED', a)).body.total,1);
      assert.equal((await req('/trip-monitoring?status=IN_PROGRESS', a)).body.total,1);
      assert.equal((await req('/trip-monitoring/' + f.trips[2].id,a)).status,200);
    });
    await t.test('authorization: all means granted branches; forged branch and nested references fail closed', async () => {
      assert.equal((await req(summary)).status,401);
      assert.equal((await req('/auth/login', null, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: f.noScope.username, password: process.env.AUTH_DEMO_PASSWORD }) })).status,403);
      assert.equal((await req(summary + '&branchId=' + f.b.id,a)).status,403);
      assert.equal((await req(summary,a,{ headers: { 'x-branch-id': f.b.id } })).status,403);
      for (const metric of ['candidateOrders','expiredDrivers','blockedVehicles']) assert.equal((await req('/dashboard/items?metric=' + metric + '&branchId=' + f.b.id,a)).status,403);
      assert.equal((await req(summary,b)).body.metrics.candidateOrders,1);
      assert.equal((await req(summary,multi)).body.metrics.candidateOrders,3);
      assert.equal((await req(summary + '&branchId=' + f.a.id,multi)).body.metrics.candidateOrders,2);
      await db.stopTask.update({ where: { id: f.historyTask.id }, data: { orderId: f.orders[5].id } });
      try {
        assert.equal((await req(summary,a)).body.metrics.plannedTrips,0);
        assert.equal((await req('/trip-monitoring?status=PLANNED',a)).body.total,0);
      } finally { await db.stopTask.update({ where: { id: f.historyTask.id }, data: { orderId: f.orders[6].id } }); }
    });
    await t.test('validation rejects invalid intervals, timezone omission, filters and paging', async () => {
      for (const path of [
        '/dashboard/summary', '/dashboard/summary?from=bad&to=bad',
        '/dashboard/summary?from=2031-01-01T00:00:00&to=2031-01-02T00:00:00',
        '/dashboard/summary?from=2031-01-01T00:00:00Z&to=2031-01-01T00:00:00Z',
        '/dashboard/summary?from=2031-01-01T00:00:00Z&to=2033-01-01T00:00:00Z',
        summary + '&branchId=invalid', summary + '&unexpected=true',
        '/dashboard/items?metric=unknown', '/dashboard/items?metric=candidateOrders&pageSize=51',
        '/dashboard/items?metric=candidateOrders&page=0',
        '/trip-monitoring?timeBasis=createdAt',
      ]) assert.equal((await req(path,a)).status,400,path);
    });
    await t.test('permission loss returns null per metric, never leaked zero; revocation enforced live', async () => {
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const p = await db.permission.findUniqueOrThrow({ where: { code: 'orders.read' } });
      await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: p.id } } });
      try {
        const r = await req(summary,a);
        assert.equal(r.status,200); assert.equal(r.body.metrics.candidateOrders,null); assert.equal(r.body.issues.reviewOrders,null); assert.equal(r.body.metrics.activeTrips,1);
        assert.equal((await req('/dashboard/items?metric=candidateOrders',a)).status,403);
      } finally { await db.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }); }
      await db.userRoleScope.updateMany({ where: { userId: f.viewer.id }, data: { active:false } });
      assert.equal((await req(summary,a)).status,403);
    });
  } finally { await app.close(); }
});
