const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { orderAcceptanceApp } = require('./order-acceptance-app.cjs');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthService } = require('../dist/src/auth/auth.service');
const { DashboardService } = require('../dist/src/dashboard/dashboard.service');

test('Transport cancellation HTTP and PostgreSQL', { timeout: 240000 }, async t => {
  const app = await orderAcceptanceApp(), db = app.get(PrismaService), base = await app.getUrl();
  const req = async (path, token, method = 'GET', body, key = randomUUID()) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const customer = await db.customer.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-CUSTOMER-A' } });
    const login = async username => (await req('/auth/login', null, 'POST', { username, password: process.env.AUTH_DEMO_PASSWORD })).body.accessToken;
    const token = await login('demo_auth_a'), foreign = await login('demo_auth_b'), admin = await login('demo_auth_admin');
    assert.ok(token && foreign && admin);
    const principal = await app.get(AuthService).authenticateToken(token);
    const payload = () => ({ branchId: a.id, customerId: customer.id, stops: ['PICKUP', 'DELIVERY'].map((type, i) => ({ type, address: '[TEST] cancellation', latitude: 21 + i / 100, longitude: 105, contactName: 'Test', contactPhone: '000', windowStart: '2031-01-01T00:00:00Z', windowEnd: '2031-01-02T00:00:00Z', serviceDurationMinutes: 1 })), items: [{ description: '[TEST] cancel', packageType: 'CARTON', packages: [{ lengthMm: 400, widthMm: 300, heightMm: 200, weightG: '10000' }] }] });
    const make = async (confirmed = false) => {
      let r = await req('/orders', token, 'POST', payload()); assert.equal(r.status, 201, JSON.stringify(r.body));
      if (confirmed) { r = await req(`/orders/${r.body.id}/confirm`, token, 'POST', { version: r.body.version }); assert.equal(r.status, 201); }
      return r.body;
    };
    const cancel = (o, body = { version: o.version, reason: 'Khách yêu cầu hủy' }, key, who = token) => req(`/orders/${o.id}/cancel`, who, 'POST', body, key);
    const editable = o => ({ ...payload(), version: o.version, stops: o.stops.map(s => ({ ...payload().stops.find(v => v.type === s.type), id: s.id })), items: o.items.map(i => ({ id: i.id, description: i.description, packageType: i.packageType, packages: i.packages.map(p => ({ id: p.id, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: p.weightG })) })) });
    const vehicle = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
    const trip = await db.trip.create({ data: { tripNumber: 'CANCEL-HISTORY-' + randomUUID(), vehicleId: vehicle.id, managingBranchId: a.id, plannedStartTime: new Date('2020-01-01'), plannedEndTime: new Date('2020-01-02'), status: 'COMPLETED' } });
    const stop = await db.tripStop.create({ data: { tripId: trip.id, sequence: 1, stopType: 'PICKUP', address: '[TEST]', latitude: 21, longitude: 105 } });
    await t.test('DRAFT and CONFIRMED cancel with preserved identities, audit, reload, no restore', async () => {
      for (const confirmed of [false, true]) {
        const o = await make(confirmed), key = randomUUID();
        const before = await db.orderEvent.count({ where: { orderId: o.id } });
        const result = await cancel(o, undefined, key); assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.status, 'CANCELLED'); assert.equal(result.body.version, o.version + 1);
        assert.equal(result.body.cancellation.reason, 'Khách yêu cầu hủy'); assert.equal(result.body.cancellation.actorUserId, principal.id);
        assert.ok(Number.isFinite(Date.parse(result.body.cancellation.occurredAt)));
        assert.deepEqual(result.body.items.map(i => i.id), o.items.map(i => i.id));
        assert.deepEqual(result.body.stops.map(s => s.id), o.stops.map(s => s.id));
        for (const p of result.body.items[0].packages) { assert.equal(p.id, o.items[0].packages[0].id); assert.equal(p.status, 'CANCELLED'); assert.equal(p.version, o.items[0].packages[0].version + 1); }
        assert.equal(await db.orderEvent.count({ where: { orderId: o.id } }), before + 1);
        assert.deepEqual((await req('/orders/' + o.id, token)).body, result.body);
        assert.equal((await cancel(result.body)).body.code, 'ORDER_ALREADY_CANCELLED');
        assert.equal((await req(`/orders/${o.id}/confirm`, token, 'POST', { version: result.body.version })).status, 409);
        assert.equal((await req(`/orders/${o.id}`, token, 'PATCH', editable(result.body))).status, 409);
        assert.deepEqual((await cancel(o, undefined, key)).body, result.body);
        assert.equal((await cancel(o, { version: o.version, reason: 'Khác' }, key)).body.code, 'IDEMPOTENCY_CONFLICT');
      }
    });
    await t.test('HTTP validation, permission, branch scope, missing and retail orders', async () => {
      const o = await make();
      for (const body of [{ version: 1 }, { reason: 'x' }, { version: 0, reason: 'x' }, { version: 1.5, reason: 'x' }, { version: 1, reason: ' \n\t' }, { version: 1, reason: 7 }, { version: 1, reason: 'x'.repeat(1001) }, { version: 1, reason: 'x', actorUserId: principal.id }]) assert.equal((await cancel(o, body)).status, 400);
      assert.equal((await cancel(o, undefined, 'short')).status, 400);
      assert.equal((await cancel(o, undefined, undefined, foreign)).status, 404);
      assert.equal((await cancel(o, undefined, undefined, null)).status, 401);
      assert.equal((await cancel({ ...o, id: randomUUID() })).status, 404);
      const retail = await db.order.create({ data: { orderNumber: 'CANCEL-RETAIL-' + randomUUID(), orderType: 'RETAIL_PICKUP', branchId: a.id, customerId: customer.id } });
      assert.equal((await cancel(retail)).status, 404);
      assert.equal((await cancel(o, { version: 7, reason: 'x' })).body.code, 'ORDER_VERSION_CONFLICT');
      assert.equal((await cancel(o, undefined, undefined, admin)).status, 201);
    });
    await t.test('historical allocation, package-only task, execution and inconsistent records block without deletion', async () => {
      for (const kind of ['allocation', 'task', 'orderStopTask', 'execution', 'packageEvent', 'orderEvent', 'legacy', 'wrongStatus', 'directMapping']) {
        const o = await make(true), p = o.items[0].packages[0]; let record;
        if (kind === 'allocation') record = await db.allocation.create({ data: { orderItemId: o.items[0].id, packageId: p.id, tripId: trip.id, allocatedQuantity: 1, status: 'RELEASED' } });
        if (kind === 'task' || kind === 'execution') record = await db.stopTask.create({ data: { tripStopId: stop.id, packageId: p.id, action: 'LOAD', plannedQuantity: 1, actualQuantity: kind === 'execution' ? 1 : null } });
        if (kind === 'orderStopTask') record = await db.stopTask.create({ data: { tripStopId: stop.id, orderStopId: o.stops[0].id, action: 'LOAD', plannedQuantity: 1 } });
        if (kind === 'packageEvent') await db.packageEvent.create({ data: { packageId: p.id, eventType: 'PACKED' } });
        if (kind === 'orderEvent') await db.orderEvent.create({ data: { orderId: o.id, eventType: 'ASSIGNED', toStatus: 'ASSIGNED' } });
        if (kind === 'legacy') await db.order.update({ where: { id: o.id }, data: { packageDataStatus: 'LEGACY_REVIEW' } });
        if (kind === 'wrongStatus') await db.package.update({ where: { id: p.id }, data: { status: 'LOADED' } });
        if (kind === 'directMapping') await db.package.update({ where: { id: p.id }, data: { orderId: (await make()).id } });
        const r = await cancel(o); assert.equal(r.status, 409, kind + JSON.stringify(r.body));
        assert.equal(r.body.code, ['allocation', 'task', 'orderStopTask'].includes(kind) ? 'ORDER_ASSIGNMENT_EXISTS' : kind === 'execution' ? 'ORDER_EXECUTION_EXISTS' : 'ORDER_RECONCILIATION_REQUIRED');
        assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'CONFIRMED');
        assert.equal(await db.orderEvent.count({ where: { orderId: o.id, eventType: 'CANCELLED' } }), 0);
        const detail = await req('/orders/' + o.id, token);
        assert.equal(detail.status, 200); assert.equal(detail.body.cancellationAllowed, false);
        if (kind === 'allocation') assert.ok(await db.allocation.findUnique({ where: { id: record.id } }));
        if (kind === 'task') assert.ok(await db.stopTask.findUnique({ where: { id: record.id } }));
        // Restore the deliberately corrupt status after its rejection assertions so
        // unrelated candidate-list tests don't encounter an invalid test fixture.
        if (kind === 'wrongStatus') await db.package.update({ where: { id: p.id }, data: { status: 'READY' } });
      }
    });
    await t.test('concurrent cancel/retry/confirm/edit commits only one transition', async () => {
      for (const rival of ['cancel', 'sameKey', 'confirm', 'edit']) {
        const o = await make(), key = randomUUID();
        const other = () => rival === 'confirm' ? req(`/orders/${o.id}/confirm`, token, 'POST', { version: o.version }) : rival === 'edit' ? req(`/orders/${o.id}`, token, 'PATCH', editable(o)) : cancel(o, undefined, rival === 'sameKey' ? key : undefined);
        const results = await Promise.all([cancel(o, undefined, key), other()]);
        assert.equal(results.filter(r => r.status < 300).length, rival === 'sameKey' ? 2 : 1, JSON.stringify(results));
        if (rival === 'sameKey') assert.deepEqual(results[0].body, results[1].body);
        else assert.equal(results.filter(r => r.status === 409).length, 1);
        assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).version, o.version + 1);
        assert.ok(await db.orderEvent.count({ where: { orderId: o.id, eventType: 'CANCELLED' } }) <= 1);
      }
    });
    await t.test('legacy inventory reservation blocks cancellation without releasing it', async () => {
      const o = await make();
      const product = await db.product.create({ data: { code: 'CANCEL-' + randomUUID(), name: '[TEST]' } });
      const sku = await db.sku.create({ data: { productId: product.id, skuCode: 'CANCEL-' + randomUUID(), name: '[TEST]' } });
      const location = await db.location.create({ data: { code: 'CANCEL-' + randomUUID(), name: '[TEST]', address: '[TEST]', latitude: 21, longitude: 105, managingBranchId: a.id } });
      const reservation = await db.inventoryReservation.create({ data: { reservationNumber: 'CANCEL-' + randomUUID(), orderId: o.id, skuId: sku.id, locationId: location.id, quantity: 1, expiresAt: new Date('2031-01-01') } });
      assert.equal((await cancel(o)).body.code, 'ORDER_RECONCILIATION_REQUIRED');
      assert.deepEqual(await db.inventoryReservation.findUniqueOrThrow({ where: { id: reservation.id } }), reservation);
    });
    await t.test('retail cancellation cannot bypass transport policy on real records', async () => {
      const { SalesOrdersService } = require('../dist/src/sales-orders/sales-orders.service');
      const retail = new SalesOrdersService(db, {}, {});
      const o = await make(true);
      await assert.rejects(retail.cancelOrder(o.id, { reason: 'Bypass', idempotencyKey: randomUUID() }, { id: principal.id, role: 'ADMIN' }), e => e.getStatus() === 404);
      assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'CONFIRMED');
      assert.equal(await db.orderEvent.count({ where: { orderId: o.id, eventType: 'ORDER_CANCELLED' } }), 0);
    });
    await t.test('event write failure rolls back packages, order and processed command', async () => {
      const o = await make(), key = randomUUID();
      await db.$executeRawUnsafe(`CREATE FUNCTION cancel_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."eventType" = 'CANCELLED' THEN RAISE EXCEPTION 'test cancellation failure'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER cancel_test_fail BEFORE INSERT ON order_status_events FOR EACH ROW EXECUTE FUNCTION cancel_test_fail()');
      try {
        assert.equal((await cancel(o, undefined, key)).status, 503);
        assert.equal((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status, 'DRAFT');
        assert.equal((await db.package.findUniqueOrThrow({ where: { id: o.items[0].packages[0].id } })).status, 'DRAFT');
        assert.equal(await db.processedCommand.count({ where: { idempotencyKey: key } }), 0);
      } finally { await db.$executeRawUnsafe('DROP TRIGGER cancel_test_fail ON order_status_events'); await db.$executeRawUnsafe('DROP FUNCTION cancel_test_fail()'); }
      assert.equal((await cancel(o, undefined, key)).status, 201);
    });
    await t.test('retry checks current permissions and branch grants', async () => {
      const o = await make(), key = randomUUID(); assert.equal((await cancel(o, undefined, key)).status, 201);
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'orders.write' } });
      const pair = { roleId: role.id, permissionId: permission.id };
      await db.rolePermission.delete({ where: { roleId_permissionId: pair } });
      try { assert.equal((await cancel(o, undefined, key)).status, 403); }
      finally { await db.rolePermission.create({ data: pair }); }
      const narrowed = { ...principal, selectedBranchId: (await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } })).id };
      const { OrdersService } = require('../dist/src/orders/orders.service');
      await assert.rejects(app.get(OrdersService).cancel(o.id, { version: o.version, reason: 'Khách yêu cầu hủy' }, narrowed, key), e => e.getStatus() === 403);
    });
    await t.test('dispatch candidates, cancelled filter and dashboard exclude cancelled orders', async () => {
      const o = await make(true), dashboard = new DashboardService(db);
      const query = { from: '2031-01-01T00:00:00Z', to: '2031-01-02T00:00:00Z', branchId: a.id };
      const before = await dashboard.summary(principal, query);
      assert.ok((await req('/orders/available-for-dispatch', token)).body.some(v => v.id === o.id));
      assert.equal((await cancel(o)).status, 201);
      assert.ok(!(await req('/orders/available-for-dispatch', token)).body.some(v => v.id === o.id));
      assert.equal((await dashboard.summary(principal, query)).metrics.candidateOrders, before.metrics.candidateOrders - 1);
      assert.ok((await req('/orders?status=CANCELLED&search=' + o.orderNumber, token)).body.items.some(v => v.id === o.id));
    });
    const { exerciseDispatchRaces } = require('./order-cancellation-races.cjs');
    await exerciseDispatchRaces({ t, app, db, principal, make, cancel, branch: a });
  } finally { await app.close(); }
});
