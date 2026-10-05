const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { MapboxService } = require('../dist/src/mapbox/mapbox.service');
const { TripsService } = require('../dist/src/trips/trips.service');
const { validationException } = require('../dist/src/orders/validation-errors');
const { seedAuth } = require('../dist/prisma/seed-auth');

test('Order Packages: real PostgreSQL + HTTP, fixture road times only', { timeout: 120000 }, async t => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost','127.0.0.1'].includes(target.hostname) && target.pathname === '/tms_orders_test_v2', 'Refusing non-test DB');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true, exceptionFactory: validationException }));
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService), trips = app.get(TripsService), map = app.get(MapboxService), base = await app.getUrl();
  // Only external road responses are fixtures. All writes, auth, locks and constraints use PostgreSQL.
  map.getRoute = async () => ({ distanceKm: 2, durationMinutes: 2, geometry: null, waypoints: [] });
  map.getRoadMatrix = async coords => ({ durationsSeconds: coords.map((_, i) => coords.map((_, j) => i === j ? 0 : 60)), distancesMeters: coords.map((_, i) => coords.map((_, j) => i === j ? 0 : 1000)) });
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
    await seedAuth(db);
    await db.authLoginLimit.deleteMany();
    a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    b = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } });
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
      const update = editable(order); update.items[0].packages[0].id = foreign.items[0].packages[0].id;
      assert.equal((await command('/orders/' + order.id, token, 'PATCH', update)).status, 400);
      assert.equal((await req('/orders')).status, 401);
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
      const epoch = trips.getPlanningEpoch([raw]), [contract] = trips.buildOptimizerOrders([raw], epoch);
      assert.deepEqual(contract.items.map(p => p.id).sort(), order.items.flatMap(i => i.packages.map(p => p.id)).sort());
      assert.equal(contract.pickup_location.id, order.stops[0].id);
      assert.equal(contract.pickup_service_time_sec, 600); assert.equal(contract.delivery_service_time_sec, 1200);
      assert.equal(epoch.getTime() + contract.pickup_window_start_sec * 1000, Date.parse(order.stops[0].windowStart));
      assert.ok(Math.abs(contract.items.reduce((n, p) => n + p.weight_kg, 0) - order.totalWeightKg) < 1e-9);
      const available = await req('/orders/available-for-dispatch', token); assert.equal(available.status, 200); assert.ok(available.body.some(o => o.id === order.id)); assert.ok(available.body.every(o => o.packageDataStatus === 'COMPLETE'));
    });
    await t.test('manual dispatch persists one allocation/task pair per Package, protects edits and correct stop loads', async () => {
      const vehicle = await db.vehicle.create({ data: { plateNumber: 'TEST-' + randomUUID(), model: 'test', vehicleType: 'test', homeBranchId: a.id, payloadCapacityKg: 1000, volumeCapacityM3: 10, lengthCm: 400, widthCm: 200, heightCm: 200 } });
      const driver = await db.driver.create({ data: { citizenId: randomUUID(), fullName: '[TEST]', phone: '000', licenseNumber: randomUUID(), licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: a.id } });
      const tripInput = { branchId: a.id, vehicleId: vehicle.id, driverId: driver.id, orderIds: [order.id], plannedStartTime: '2031-01-01T15:00:00Z', plannedEndTime: '2031-01-01T22:00:00Z' };
      const results = await Promise.all([req('/trips', token, 'POST', tripInput), req('/trips', token, 'POST', tripInput)]);
      assert.deepEqual(results.map(r => r.status).sort(), [201,409]);
      const trip = results.find(r => r.status === 201).body;
      const allocations = await db.allocation.findMany({ where: { tripId: trip.id }, include: { tasks: true } });
      assert.equal(allocations.length, 4); assert.ok(allocations.every(a => a.packageId && a.allocatedQuantity === 1 && a.tasks.length === 2 && a.tasks.every(t => t.orderStopId && t.plannedQuantity === 1)));
      const latest = (await req('/orders/' + order.id, token)).body;
      assert.equal((await command('/orders/' + order.id, token, 'PATCH', editable(latest))).status, 409);
      const profile = await req('/trips/' + trip.id + '/load-profile', token); assert.equal(profile.status, 200, JSON.stringify(profile.body));
      assert.ok(Math.abs(profile.body.maxWeightKg - order.totalWeightKg) < 1e-9); assert.ok(Math.abs(profile.body.loadProfile.at(-1).currentWeightKg) < 1e-9);
      // A stale state alone cannot bypass historical relations.
      await db.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } });
      assert.equal((await command('/orders/' + order.id, token, 'PATCH', editable(latest))).body.code, 'ORDER_REFERENCED');
    });
    await t.test('legacy migration preserved original totals/history and cannot enter optimizer', async () => {
      const legacy = await db.order.findUniqueOrThrow({ where: { id: 'legacy-order' }, include: { stops: true, items: { include: { packages: true, allocations: true } } } });
      assert.equal(legacy.items[0].weightKg, 37); assert.equal(legacy.items[0].quantity, 3); assert.equal(legacy.items[0].allocations[0].id, 'legacy-allocation'); assert.equal(legacy.items[0].packages.length, 0);
      assert.throws(() => trips.buildOptimizerOrders([legacy], new Date()), /đối soát/);
    });
    await t.test('PostgreSQL rejects invalid Package measurements and cross-line allocation even without API', async () => {
      const draft = await make();
      const p = draft.items[0].packages[0];
      await assert.rejects(db.package.update({ where: { id: p.id }, data: { weightG: 0n } }));
      await assert.rejects(db.package.update({ where: { id: p.id }, data: { lengthMm: 0 } }));
      await assert.rejects(db.allocation.create({ data: { tripId: 'legacy-trip', orderItemId: draft.items[1].id, packageId: p.id, allocatedQuantity: 1 } }));
      await assert.rejects(db.allocation.create({ data: { tripId: 'legacy-trip', orderItemId: p.orderItemId, packageId: p.id, allocatedQuantity: 2 } }));
      assert.equal((await db.package.findUniqueOrThrow({ where: { id: p.id } })).weightG.toString(), p.weightG);
    });
    await t.test('removing and adding unreferenced packages preserves retained IDs and exact totals', async () => {
      const draft = await make(), update = editable(draft);
      const removed = update.items[0].packages.pop();
      update.items[0].packages.push(pkg('7'));
      const result = await command('/orders/' + draft.id, token, 'PATCH', update);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.ok(result.body.items[0].packages.some(p => p.id === draft.items[0].packages[0].id));
      assert.equal(await db.package.findUnique({ where: { id: removed.id } }), null);
      assert.equal(result.body.totalWeightG, (100010n - BigInt(removed.weightG) + 7n).toString());
      assert.equal(await db.orderStop.count({ where: { orderId: draft.id } }), 2);
    });
    await t.test('unreferenced legacy order is reconciled explicitly with original measurements in audit', async () => {
      const id = randomUUID();
      const legacy = await db.order.create({ data: { id, orderNumber: 'TEST-LEGACY-' + id, branchId: a.id, customerId: customer.id,
        totalPackages: 2, totalWeightKg: 37, items: { create: { description: 'legacy', quantity: 2, weightKg: 37, lengthCm: 40, widthCm: 30, heightCm: 20, volumeM3: 0.048 } },
        stops: { create: payload().stops.map((s, i) => ({ ...s, sequence: i + 1 })) },
      }, include: { items: { include: { packages: true } }, stops: true } });
      const update = editable(legacy); update.items[0].packages = [pkg('15000'), pkg('22000')];
      const result = await command('/orders/' + id, token, 'PATCH', update);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.packageDataStatus, 'COMPLETE'); assert.equal(result.body.totalWeightG, '37000');
      assert.equal(result.body.items[0].id, legacy.items[0].id);
      const event = await db.orderEvent.findFirstOrThrow({ where: { orderId: id, eventType: 'PACKAGES_RECONCILED' } });
      assert.equal(event.payload.before.items[0].weightKg, 37); assert.equal(event.payload.before.items[0].lengthCm, 40);
      assert.equal(event.payload.source, 'USER_DECLARED');
    });
    await t.test('edit during route calculation prevents stale assignment at transaction boundary', async () => {
      const draft = await make();
      const confirmed = (await command('/orders/' + draft.id + '/confirm', token, 'POST', { version: draft.version })).body;
      const vehicle = await db.vehicle.create({ data: { plateNumber: 'TEST-RACE-' + randomUUID(), model: 'test', vehicleType: 'test', homeBranchId: a.id, payloadCapacityKg: 1000, volumeCapacityM3: 10, lengthCm: 400, widthCm: 200, heightCm: 200 } });
      const driver = await db.driver.create({ data: { citizenId: randomUUID(), fullName: '[TEST]', phone: '000', licenseNumber: randomUUID(), licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: a.id } });
      const original = map.getRoute;
      let release, reached;
      const gate = new Promise(r => { release = r; }), entered = new Promise(r => { reached = r; });
      map.getRoute = async () => { reached(); await gate; return original(); };
      const pending = req('/trips', token, 'POST', { branchId: a.id, vehicleId: vehicle.id, driverId: driver.id, orderIds: [draft.id], plannedStartTime: '2031-01-01T15:00:00Z', plannedEndTime: '2031-01-01T22:00:00Z' });
      try {
        await entered;
        const edit = editable(confirmed); edit.items[0].packages[0].weightG = '11';
        assert.equal((await command('/orders/' + draft.id, token, 'PATCH', edit)).status, 200);
        release();
        assert.equal((await pending).status, 409);
        assert.equal(await db.allocation.count({ where: { orderItem: { orderId: draft.id } } }), 0);
        assert.equal(await db.trip.count({ where: { vehicleId: vehicle.id } }), 0);
      } finally { release(); map.getRoute = original; await pending; }
    });
    await t.test('HTTP Nest → real FastAPI/OR-Tools → apply persists exact Package IDs and service windows', { timeout: 60000 }, async () => {
      const { spawn } = require('child_process'), path = require('path');
      const { signOptimizationProposal } = require('../dist/src/trips/optimization-proposal');
      const python = path.resolve('../optimizer/.venv/Scripts/python.exe');
      const engine = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '18012'], { cwd: path.resolve('../optimizer'), windowsHide: true, stdio: 'ignore' });
      let processError; engine.on('error', e => { processError = e; });
      const previousUrl = process.env.OPTIMIZER_URL; process.env.OPTIMIZER_URL = 'http://127.0.0.1:18012';
      try {
        let ready = false;
        for (let i = 0; i < 50 && !ready; i++) {
          if (processError) throw processError;
          if (engine.exitCode !== null) throw new Error('Test optimizer did not start');
          try { ready = (await fetch(process.env.OPTIMIZER_URL + '/health')).ok; } catch { await new Promise(r => setTimeout(r, 200)); }
        }
        assert.ok(ready, 'Real optimizer must be available; no mock fallback');
        const branch = await db.branch.create({ data: { code: 'TEST-OPT-' + randomUUID(), name: '[TEST]', address: '[TEST]', latitude: 21, longitude: 105 } });
        await db.vehicle.create({ data: { plateNumber: 'TEST-OPT-' + randomUUID(), model: 'test', vehicleType: 'test', homeBranchId: branch.id, payloadCapacityKg: 1000, volumeCapacityM3: 10, lengthCm: 400, widthCm: 200, heightCm: 200 } });
        await db.driver.create({ data: { citizenId: randomUUID(), fullName: '[TEST]', phone: '000', licenseNumber: randomUUID(), licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: branch.id } });
        const draft = await make({ ...payload(), branchId: branch.id }, admin);
        const confirmed = await command('/orders/' + draft.id + '/confirm', admin, 'POST', { version: draft.version }); assert.equal(confirmed.status, 201);
        const optimized = await req('/trips/automatic-optimization', admin, 'POST', { branchId: branch.id });
        assert.equal(optimized.status, 201, JSON.stringify(optimized.body));
        const { proposal } = optimized.body;
        assert.equal(proposal.result.routes.length, 1); assert.equal(proposal.result.unassigned_orders.length, 0);
        const route = proposal.result.routes[0], ids = draft.items.flatMap(i => i.packages.map(p => p.id)).sort();
        assert.deepEqual([...route.stops[0].items_loaded].sort(), ids);
        assert.deepEqual([...route.stops[1].items_unloaded].sort(), ids);
        assert.equal(route.stops[0].current_weight_kg, 100.01);
        assert.equal(route.stops[0].departure_time_sec - route.stops[0].arrival_time_sec, 600);
        assert.equal(route.stops[1].departure_time_sec - route.stops[1].arrival_time_sec, 1200);
        const wrong = structuredClone(proposal); wrong.result.routes[0].stops[0].items_loaded[0] = randomUUID();
        const signature = signOptimizationProposal(wrong, process.env.OPTIMIZATION_PROPOSAL_SECRET || process.env.JWT_SECRET);
        assert.equal((await req('/trips/automatic-optimization/apply', admin, 'POST', { proposal: wrong, signature })).status, 400);
        const applied = await req('/trips/automatic-optimization/apply', admin, 'POST', optimized.body);
        assert.equal(applied.status, 201, JSON.stringify(applied.body));
        const allocations = await db.allocation.findMany({ where: { tripId: applied.body.trips[0].id }, include: { tasks: true } });
        assert.deepEqual(allocations.map(a => a.packageId).sort(), ids);
        assert.ok(allocations.every(a => a.allocatedQuantity === 1 && a.tasks.length === 2 && a.tasks.every(t => t.orderStopId)));
        assert.equal((await req('/trips/automatic-optimization/apply', admin, 'POST', optimized.body)).status, 409);
      } finally {
        engine.kill();
        if (previousUrl === undefined) delete process.env.OPTIMIZER_URL; else process.env.OPTIMIZER_URL = previousUrl;
      }
    });
  } finally { await app.close(); }
});
