const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { orderAcceptanceApp } = require('./order-acceptance-app.cjs');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { TripsService } = require('../dist/src/trips/trips.service');
const { AuthService } = require('../dist/src/auth/auth.service');

test('Order acceptance: real PostgreSQL and HTTP; production data adapter only', { timeout: 240000 }, async t => {
  const app = await orderAcceptanceApp();
  const db = app.get(PrismaService), base = await app.getUrl();
  const trips = { buildOptimizerOrders: (...args) => TripsService.prototype.buildOptimizerOrders(...args) };
  const req = async (path, token, method = 'GET', body, key) => {
    const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const command = (path, token, method, body, key = randomUUID()) => req(path, token, method, body, key);
  let order, token, admin, a, b, customer;
  const pkg = (weightG = '10001') => ({ lengthMm: 400, widthMm: 300, heightMm: 200, weightG });
  const payload = () => ({ branchId: a.id, customerId: customer.id, notes: '[TEST] ' + randomUUID(), stops: [
    { type: 'PICKUP', address: '[TEST] pickup', latitude: 21.03, longitude: 105.85, contactName: 'Test', contactPhone: '000', windowStart: '2031-01-01T23:00:00+07:00', windowEnd: '2031-01-02T02:00:00+07:00', serviceDurationMinutes: 10 },
    { type: 'DELIVERY', address: '[TEST] delivery', latitude: 21.04, longitude: 105.85, contactName: 'Test', contactPhone: '000', windowStart: '2031-01-01T23:00:00+07:00', windowEnd: '2031-01-02T04:00:00+07:00', serviceDurationMinutes: 20 },
  ], items: [ { description: 'A', packageType: 'CARTON', packages: [pkg(), pkg('20002')] }, { description: 'B', packageType: 'CRATE', packages: [pkg('30003'), { ...pkg('40004'), lengthMm: 500 }] } ] });
  const editable = o => ({ branchId: o.branchId, customerId: o.customerId, notes: o.notes, version: o.version,
    stops: o.stops.map(s => ({ id: s.id, type: s.type, address: s.address, latitude: s.latitude, longitude: s.longitude, contactName: s.contactName, contactPhone: s.contactPhone, windowStart: s.windowStart, windowEnd: s.windowEnd, serviceDurationMinutes: s.serviceDurationMinutes })),
    items: o.items.map(i => ({ id: i.id, description: i.description, packageType: i.packageType, packages: i.packages.map(p => ({ id: p.id, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: p.weightG })) })),
  });
  const make = async (input = payload(), who = token, key) => { const r = await command('/orders', who, 'POST', input, key); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  try {
    a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    b = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } });
    const fixtureVehicle = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
    await db.trip.upsert({ where: { id: 'legacy-trip' }, update: {}, create: { id: 'legacy-trip', tripNumber: 'MERGE-LEGACY-FK-TEST', vehicleId: fixtureVehicle.id, managingBranchId: a.id, plannedStartTime: new Date('2020-01-01'), plannedEndTime: new Date('2020-01-02'), status: 'COMPLETED' } });
    customer = await db.customer.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-CUSTOMER-A' } });
    token = (await req('/auth/login', null, 'POST', { username: 'demo_auth_a', password: process.env.AUTH_DEMO_PASSWORD })).body.accessToken;
    admin = (await req('/auth/login', null, 'POST', { username: 'demo_auth_admin', password: process.env.AUTH_DEMO_PASSWORD })).body.accessToken;
    assert.ok(token && admin);
    await t.test('create multi-line physical Packages and reload exact totals and UTC windows', async () => {
      order = await make(); assert.equal(order.status, 'DRAFT'); assert.equal(order.totalPackages, 4);
      assert.equal(order.totalWeightG, '100010'); assert.equal(order.totalVolumeMm3, '102000000'); assert.equal(order.totalWeightKg, 100.01);
      const loaded = await req('/orders/' + order.id, token); assert.equal(loaded.status, 200);
      assert.deepEqual(loaded.body, order);
      assert.equal(order.stops[0].windowStart, '2031-01-01T16:00:00.000Z');
      const ids = order.items.flatMap(i => i.packages.map(p => p.id)); assert.equal(new Set(ids).size, 4);
      for (const i of order.items) for (const p of i.packages) { assert.equal(p.orderItemId, i.id); assert.equal(p.pickupStopId, order.stops[0].id); assert.equal(p.deliveryStopId, order.stops[1].id); }
    });
    await t.test('bad measures, empty quantities, reversed windows and missing offsets rejected with field paths', async () => {
      const bad = [];
      for (const value of [0, -1, 0.5]) { const p = payload(); p.items[0].packages[0].lengthMm = value; bad.push(p); }
      for (const value of ['0','-1','1.5','9223372036854775808']) { const p = payload(); p.items[0].packages[0].weightG = value; bad.push(p); }
      const empty = payload(); empty.items[0].packages = []; bad.push(empty);
      const reverse = payload(); reverse.stops[0].windowEnd = '2031-01-01T12:00:00Z'; bad.push(reverse);
      const noOffset = payload(); noOffset.stops[0].windowStart = '2031-01-01T23:00:00'; bad.push(noOffset);
      const impossible = payload(); impossible.stops[1].windowEnd = '2031-01-01T16:05:00Z'; impossible.stops[1].windowStart = '2031-01-01T16:00:00Z'; bad.push(impossible);
      const forgedTotal = payload(); forgedTotal.totalWeightKg = 1; bad.push(forgedTotal);
      for (const p of bad) { const r = await command('/orders', token, 'POST', p); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.ok(r.body.fieldErrors?.length); }
    });
    await t.test('branch, customer and package ownership are enforced', async () => {
      assert.equal((await command('/orders', token, 'POST', { ...payload(), branchId: b.id })).status, 403);
      const other = await db.customer.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-CUSTOMER-B' } });
      assert.equal((await command('/orders', token, 'POST', { ...payload(), customerId: other.id })).status, 403);
      assert.equal((await req('/orders?branchId=' + b.id, token)).status, 403);
      const foreign = await make({ ...payload(), branchId: b.id, customerId: other.id }, admin);
      assert.equal((await req('/orders/' + foreign.id, token)).status, 404);
      assert.equal((await command('/orders/' + foreign.id, token, 'PATCH', editable(foreign))).status, 404);
      assert.equal((await command('/orders/' + foreign.id + '/confirm', token, 'POST', { version: foreign.version })).status, 404);
      assert.equal((await req('/orders/available-for-dispatch?branchId=' + b.id, token)).status, 403);
      const update = editable(order); update.items[0].packages[0].id = foreign.items[0].packages[0].id;
      assert.equal((await command('/orders/' + order.id, token, 'PATCH', update)).status, 400);
      assert.equal((await req('/orders')).status, 401);
    });
    await t.test('required package/point fields and duplicate IDs cannot bypass validation', async () => {
      for (const field of ['weightG', 'lengthMm']) {
        const p = payload(); delete p.items[0].packages[0][field]; assert.equal((await command('/orders', token, 'POST', p)).status, 400);
      }
      const p = payload(); delete p.stops[0].latitude; assert.equal((await command('/orders', token, 'POST', p)).status, 400);
      const duplicate = editable(order); duplicate.items[0].packages[1].id = duplicate.items[0].packages[0].id;
      assert.equal((await command('/orders/' + order.id, token, 'PATCH', duplicate)).status, 400);
      const retail = await db.order.create({ data: { orderNumber: 'ACCEPT-RETAIL-' + randomUUID(), orderType: 'RETAIL_PICKUP', branchId: a.id, customerId: customer.id } });
      assert.equal((await req('/orders/' + retail.id, token)).status, 404);
      assert.ok(!(await req('/orders', token)).body.items.some(o => o.id === retail.id));
    });
    await t.test('edits retain line, stop and package IDs; simultaneous versions cannot overwrite', async () => {
      const update = editable(order); update.items[0].packages[0].weightG = '10005';
      const results = await Promise.all([command('/orders/' + order.id, token, 'PATCH', update), command('/orders/' + order.id, token, 'PATCH', { ...update, notes: 'other editor' })]);
      assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
      const saved = results.find(r => r.status === 200).body;
      assert.deepEqual(saved.items.map(i => i.id), order.items.map(i => i.id));
      assert.deepEqual(saved.stops.map(s => s.id), order.stops.map(s => s.id));
      assert.deepEqual(saved.items.flatMap(i => i.packages.map(p => p.id)).sort(), order.items.flatMap(i => i.packages.map(p => p.id)).sort());
      assert.equal(saved.version, order.version + 1); order = saved;
    });
    await t.test('parallel create codes unique; concurrent retry identical; changed retry payload conflicts', async () => {
      const key = randomUUID(), data = payload();
      const repeated = await Promise.all([make(data, token, key), make(data, token, key)]);
      assert.deepEqual(repeated[0], repeated[1]);
      assert.equal(await db.order.count({ where: { id: repeated[0].id } }), 1);
      assert.equal(await db.package.count({ where: { orderItem: { orderId: repeated[0].id } } }), 4);
      assert.equal((await command('/orders', token, 'POST', { ...data, notes: 'changed' }, key)).status, 409);
      const created = await Promise.all([make(), make(), make()]);
      assert.equal(new Set(created.map(o => o.orderNumber)).size, 3);
      assert.equal(new Set(created.flatMap(o => o.items.flatMap(i => i.packages.map(p => p.packageCode)))).size, 12);
    });
    await t.test('database package failure rolls back order, stops, items and command', async () => {
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_package() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."lengthMm" = 9999 THEN RAISE EXCEPTION 'test package write failure'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER test_fail_package BEFORE INSERT ON packages FOR EACH ROW EXECUTE FUNCTION test_fail_package()');
      const before = [await db.order.count(), await db.orderItem.count(), await db.orderStop.count(), await db.package.count(), await db.processedCommand.count()];
      const p = payload(); p.items[1].packages[1].lengthMm = 9999;
      try {
        assert.equal((await command('/orders', token, 'POST', p)).status, 503);
        assert.deepEqual([await db.order.count(), await db.orderItem.count(), await db.orderStop.count(), await db.package.count(), await db.processedCommand.count()], before);
      } finally { await db.$executeRawUnsafe('DROP TRIGGER test_fail_package ON packages'); await db.$executeRawUnsafe('DROP FUNCTION test_fail_package()'); }
    });
    await t.test('draft may omit windows; confirm requires complete windows; confirmed orders carry real package contract', async () => {
      const p = payload(); p.stops.forEach(s => { s.windowStart = null; s.windowEnd = null; });
      const draft = await make(p);
      assert.equal((await command('/orders/' + draft.id + '/confirm', token, 'POST', { version: draft.version })).status, 400);
      const r = await command('/orders/' + order.id + '/confirm', token, 'POST', { version: order.version }); assert.equal(r.status, 201, JSON.stringify(r.body)); order = r.body;
      assert.equal(order.status, 'CONFIRMED');
      const raw = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { stops: true, items: { include: { packages: true } } } });
      const epoch = new Date('2031-01-01T00:00:00+07:00'), [contract] = trips.buildOptimizerOrders([raw], epoch);
      assert.deepEqual(contract.items.map(p => p.id).sort(), order.items.flatMap(i => i.packages.map(p => p.id)).sort());
      assert.equal(contract.pickup_location.id, order.stops[0].id);
      assert.equal(contract.pickup_service_time_sec, 600); assert.equal(contract.delivery_service_time_sec, 1200);
      assert.equal(epoch.getTime() + contract.pickup_window_start_sec * 1000, Date.parse(order.stops[0].windowStart));
      assert.ok(Math.abs(contract.items.reduce((n, p) => n + p.weight_kg, 0) - order.totalWeightKg) < 1e-9);
      const available = await req('/orders/available-for-dispatch', token); assert.equal(available.status, 200); assert.ok(available.body.some(o => o.id === order.id)); assert.ok(available.body.every(o => o.packageDataStatus === 'COMPLETE'));
    });
    await t.test('add/remove packages retains identity and recalculates exact totals', async () => {
      const original = await make(), edit = editable(original);
      const retained = original.items[0].packages[0];
      edit.items[0].packages = [{ ...edit.items[0].packages[0], lengthMm: 401, weightG: '7' }, { lengthMm: 1, widthMm: 2, heightMm: 3, weightG: '11' }];
      edit.items.splice(1, 1); edit.stops[0].contactName = '[TEST] Changed';
      const r = await command('/orders/' + original.id, token, 'PATCH', edit); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.totalPackages, 2); assert.equal(r.body.totalWeightG, '18'); assert.equal(r.body.totalVolumeMm3, '24060006');
      assert.equal(r.body.items[0].packages.find(p => p.id === retained.id).packageCode, retained.packageCode);
      assert.equal(await db.package.count({ where: { id: original.items[1].packages[0].id } }), 0);
      assert.equal((await req('/orders/' + original.id, token)).body.stops[0].contactName, '[TEST] Changed');
      for (const field of ['item', 'stop']) {
        const forged = editable(r.body); if (field === 'item') forged.items[0].id = order.items[0].id; else forged.stops[0].id = order.stops[0].id;
        assert.equal((await command('/orders/' + original.id, token, 'PATCH', forged)).status, 400);
      }
    });
    await t.test('confirmation retry writes one event; stale and non-draft commands conflict', async () => {
      const draft = await make(), key = randomUUID(), path = '/orders/' + draft.id + '/confirm';
      const results = await Promise.all([command(path, token, 'POST', { version: draft.version }, key), command(path, token, 'POST', { version: draft.version }, key)]);
      results.forEach(r => assert.equal(r.status, 201)); assert.deepEqual(results[0].body, results[1].body);
      assert.equal(await db.orderEvent.count({ where: { orderId: draft.id, eventType: 'CONFIRMED' } }), 1);
      assert.ok(results[0].body.items.every(i => i.packages.every(p => p.status === 'READY')));
      assert.equal((await command(path, token, 'POST', { version: results[0].body.version })).body.code, 'ORDER_NOT_DRAFT');
      assert.equal((await command(path, token, 'POST', { version: draft.version + 1 }, key)).body.code, 'IDEMPOTENCY_CONFLICT');
    });
    await t.test('update retry is idempotent and expired session cannot read', async () => {
      const draft = await make(), key = randomUUID(), input = { ...editable(draft), notes: '[TEST] retry edit' }, path = '/orders/' + draft.id;
      const first = await command(path, token, 'PATCH', input, key); const retry = await command(path, token, 'PATCH', input, key);
      assert.equal(first.status, 200); assert.deepEqual(retry.body, first.body);
      assert.equal(await db.orderEvent.count({ where: { orderId: draft.id, eventType: 'UPDATED' } }), 1);
      assert.equal((await command(path, token, 'PATCH', { ...input, notes: 'different' }, key)).status, 409);
      const fresh = (await req('/auth/login', null, 'POST', { username: 'demo_auth_a', password: process.env.AUTH_DEMO_PASSWORD })).body.accessToken;
      const claims = JSON.parse(Buffer.from(fresh.split('.')[1], 'base64url').toString());
      await db.authSession.update({ where: { id: claims.sid }, data: { expiresAt: new Date('2000-01-01') } });
      assert.equal((await req(path, fresh)).status, 401);
    });
    await t.test('simultaneous edit and confirmation share the order lock and one version wins', async () => {
      const draft = await make();
      const results = await Promise.all([command('/orders/' + draft.id, token, 'PATCH', editable(draft)), command('/orders/' + draft.id + '/confirm', token, 'POST', { version: draft.version })]);
      assert.equal(results.filter(r => [200,201].includes(r.status)).length, 1); assert.equal(results.filter(r => r.status === 409).length, 1);
      assert.equal((await req('/orders/' + draft.id, token)).body.version, draft.version + 1);
    });
    await t.test('exact BigInt totals survive HTTP and database; unsafe optimizer conversion is rejected', async () => {
      const p = payload(); p.items = [{ description: 'Precision', packageType: 'CRATE', packages: [{ lengthMm: 1000001, widthMm: 1000001, heightMm: 1000001, weightG: '9007199254740993' }] }];
      const saved = await make(p); assert.equal(saved.totalWeightG, '9007199254740993'); assert.equal(saved.totalVolumeMm3, '1000003000003000001');
      assert.equal((await req('/orders/' + saved.id, token)).body.items[0].packages[0].weightG, '9007199254740993');
      await command('/orders/' + saved.id + '/confirm', token, 'POST', { version: saved.version });
      const raw = await db.order.findUniqueOrThrow({ where: { id: saved.id }, include: { stops: true, items: { include: { packages: true } } } });
      assert.throws(() => trips.buildOptimizerOrders([raw], new Date('2031-01-01')), /contract optimizer/);
    });
    await t.test('service-start windows allow service to finish after window end; rounding tightens milliseconds', async () => {
      const p = payload(); p.stops[0].windowStart = '2031-01-01T23:00:00.123+07:00'; p.stops[0].windowEnd = '2031-01-01T23:00:01.987+07:00';
      const saved = await make(p); const confirmed = await command('/orders/' + saved.id + '/confirm', token, 'POST', { version: saved.version }); assert.equal(confirmed.status, 201);
      const raw = await db.order.findUniqueOrThrow({ where: { id: saved.id }, include: { stops: true, items: { include: { packages: true } } } });
      const [mapped] = trips.buildOptimizerOrders([raw], new Date('2031-01-01T16:00:00Z'));
      assert.equal(mapped.pickup_window_start_sec, 1); assert.equal(mapped.pickup_window_end_sec, 1); assert.equal(mapped.pickup_service_time_sec, 600);
    });
    await t.test('legacy null dimensions remain unknown; drafts and legacy orders never enter dispatch list', async () => {
      const legacy = await db.order.findUniqueOrThrow({ where: { orderNumber: 'DEMO-AUTH-ORDER-A' }, include: { items: true } });
      await db.orderItem.update({ where: { id: legacy.items[0].id }, data: { lengthCm: null } });
      const loaded = await req('/orders/' + legacy.id, token); assert.equal(loaded.body.items[0].lengthCm, null); assert.equal(loaded.body.totalWeightG, null);
      const draft = await make(); const list = await req('/orders/available-for-dispatch', token);
      assert.equal(list.status, 200); assert.ok(!list.body.some(o => o.id === draft.id || o.id === legacy.id));
      assert.ok(list.body.every(o => o.branchId === a.id && o.status === 'CONFIRMED'));
    });
    await t.test('allocated or historical packages cannot be edited or offered again', async () => {
      const draft = await make(); const confirmed = (await command('/orders/' + draft.id + '/confirm', token, 'POST', { version: draft.version })).body;
      const allocation = await db.allocation.create({ data: { orderItemId: confirmed.items[0].id, packageId: confirmed.items[0].packages[0].id, tripId: 'legacy-trip', allocatedQuantity: 1 } });
      assert.equal((await command('/orders/' + draft.id, token, 'PATCH', editable(confirmed))).body.code, 'ORDER_REFERENCED');
      assert.ok(!(await req('/orders/available-for-dispatch', token)).body.some(o => o.id === draft.id));
      assert.equal((await db.allocation.findUniqueOrThrow({ where: { id: allocation.id } })).packageId, confirmed.items[0].packages[0].id);
      const historical = await make();
      await db.packageEvent.create({ data: { packageId: historical.items[0].packages[0].id, eventType: 'PACKED', metadata: { test: true } } });
      assert.equal((await command('/orders/' + historical.id, token, 'PATCH', editable(historical))).body.code, 'ORDER_REFERENCED');
    });
    await t.test('read-only permissions and revoked sessions reject all writes', async () => {
      const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'orders.write' } });
      const where = { roleId_permissionId: { roleId: role.id, permissionId: permission.id } };
      await db.rolePermission.delete({ where });
      try {
        assert.equal((await req('/orders', token)).status, 200);
        for (const [path, method, data] of [['/orders', 'POST', payload()], ['/orders/' + order.id, 'PATCH', editable(order)], ['/orders/' + order.id + '/confirm', 'POST', { version: order.version }]]) assert.equal((await command(path, token, method, data)).status, 403);
      } finally { await db.rolePermission.create({ data: where.roleId_permissionId }); }
      const fresh = (await req('/auth/login', null, 'POST', { username: 'demo_auth_b', password: process.env.AUTH_DEMO_PASSWORD })).body.accessToken;
      assert.equal((await req('/auth/logout', fresh, 'POST')).status, 200);
      assert.equal((await req('/orders', fresh)).status, 401);
      assert.equal((await command('/orders', fresh, 'POST', payload())).status, 401);
    });
    await t.test('task referencing only Package blocks edits and new dispatch selection', async () => {
      const draft = await make(); const saved = (await command('/orders/' + draft.id + '/confirm', token, 'POST', { version: draft.version })).body;
      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
      const trip = await db.trip.create({ data: { tripNumber: 'ACCEPT-' + randomUUID(), vehicleId: vehicle.id, managingBranchId: a.id, plannedStartTime: new Date('2031-01-01'), plannedEndTime: new Date('2031-01-02'), status: 'DRAFT' } });
      const stop = await db.tripStop.create({ data: { tripId: trip.id, sequence: 1, stopType: 'PICKUP', address: '[TEST]', latitude: 21, longitude: 105 } });
      await db.stopTask.create({ data: { tripStopId: stop.id, action: 'LOAD', plannedQuantity: 1, packageId: saved.items[0].packages[0].id } });
      const result = await command('/orders/' + saved.id, token, 'PATCH', { ...editable(saved), notes: 'Must not change history' });
      assert.equal(result.status, 409, 'package-only task must prevent editing its order'); assert.equal(result.body.code, 'ORDER_REFERENCED');
      assert.ok(!(await req('/orders/available-for-dispatch', token)).body.some(o => o.id === saved.id));
      // Execute the real automatic-consumer selection against PostgreSQL, then stop before external planning.
      let selected; const captured = new Error('TEST_SELECTION_CAPTURED');
      const principal = await app.get(AuthService).authenticateToken(token);
      await assert.rejects(TripsService.prototype.executeAutomaticOptimization.call({ prisma: {
        branch: db.branch, vehicle: db.vehicle, driver: db.driver,
        order: { findMany: async args => { selected = await db.order.findMany(args); throw captured; } },
      } }, principal, { branchId: a.id }), error => error === captured);
      assert.ok(selected.some(o => o.id === order.id), 'ordinary confirmed order is still selected');
      assert.ok(!selected.some(o => o.id === saved.id), 'automatic consumer must also exclude package task history');
    });
    await t.test('newly granted customer can create their first transport order', async () => {
      const created = await command('/customers', token, 'POST', { name: '[TEST] First order customer ' + randomUUID(), address: '[TEST]', contactPerson: 'Test', phone: '000', branchIds: [a.id] });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const saved = await make({ ...payload(), customerId: created.body.id }); assert.equal(saved.customerId, created.body.id);
    });
    await t.test('edit waits for an assignment row lock and rejects committed allocation', async () => {
      const draft = await make(); const saved = (await command('/orders/' + draft.id + '/confirm', token, 'POST', { version: draft.version })).body;
      let signalLocked, release; const locked = new Promise(resolve => { signalLocked = resolve; }); const gate = new Promise(resolve => { release = resolve; });
      const writer = db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM orders WHERE id=${saved.id} FOR UPDATE`;
        const [{ pid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
        signalLocked(pid); await gate;
        await tx.allocation.create({ data: { orderItemId: saved.items[0].id, packageId: saved.items[0].packages[0].id, tripId: 'legacy-trip', allocatedQuantity: 1 } });
      }, { timeout: 15000 });
      const pid = await locked;
      const edit = command('/orders/' + saved.id, token, 'PATCH', editable(saved));
      try {
        const deadline = Date.now() + 10000; let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const rows = await db.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
          waiting = rows.length > 0;
          if (!waiting) await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(waiting, true, 'edit must actually block on assignment lock');
      } finally { release(); }
      await writer; const result = await edit; assert.equal(result.status, 409); assert.equal(result.body.code, 'ORDER_REFERENCED');
      assert.equal((await req('/orders/' + saved.id, token)).body.version, saved.version);
    });
  } finally { await app.close(); }
});
