const { test } = require('node:test');
require('ts-node').register({ skipProject: true, transpileOnly: true, compilerOptions: {
  module: 'CommonJS', moduleResolution: 'Node', target: 'ES2021', esModuleInterop: true,
} });
const { Api } = require('../../mobile/src/api.ts');
const { DriverStore } = require('../../mobile/src/store.ts');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/src/app.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { seedDriverMobile, createDriverDemoTrip } = require('../dist/prisma/seed-driver-mobile');

test('Driver start/arrival: HTTP and PostgreSQL transactions', { timeout: 120000 }, async t => {
  const target = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost','127.0.0.1'].includes(target.hostname) && target.pathname === '/tms_driver_test_20261007');
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, '127.0.0.1');
  const db = app.get(PrismaService), base = await app.getUrl();
  const call = async (path, token, body, key) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    await seedDriverMobile(db);
    const demo = await db.user.findUniqueOrThrow({ where: { username: 'demo_driver_a' }, include: { driver: true } });
    const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DRIVER' } });
    const fresh = async (owner, sharedVehicle) => {
      const id = randomUUID();
      if (!owner) {
        const user = await db.user.create({ data: { username: 'execution-' + id, password: demo.password, fullName: '[TEST execution]', role: 'DRIVER' } });
        const driver = await db.driver.create({ data: { userId: user.id, fullName: '[TEST]', citizenId: id, phone: '000', licenseNumber: id,
          licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: demo.driver.homeBranchId } });
        const scope = await db.userRoleScope.create({ data: { userId: user.id, roleId: role.id, scopeType: 'BRANCH', branchId: driver.homeBranchId } });
        const login = await call('/auth/login', null, { username: user.username, password: process.env.AUTH_DEMO_PASSWORD });
        assert.equal(login.status, 200);
        owner = { user, driver, scope, token: login.body.accessToken };
      }
      const vehicle = sharedVehicle ?? await db.vehicle.create({ data: {
        plateNumber: 'EX-' + id, model: '[TEST]', vehicleType: 'Demo', homeBranchId: owner.driver.homeBranchId,
        payloadCapacityKg: 1000, volumeCapacityM3: 10, lengthCm: 400, widthCm: 200, heightCm: 200,
      } });
      const trip = await db.$transaction(tx => createDriverDemoTrip(tx, 'EX-' + id, owner.driver.homeBranchId, vehicle.id, owner.driver.id));
      const a = await db.driverAssignment.findFirstOrThrow({ where: { tripId: trip.id } });
      await db.driverAssignment.update({ where: { id: a.id }, data: { status: 'ACCEPTED', respondedAt: new Date(), version: 2 } });
      const stops = await db.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { sequence: 'asc' } });
      return { ...owner, vehicle, trip, a, stops, body: { expectedVersion: 2, expectedTripVersion: trip.version }, path: '/driver/assignments/' + a.id };
    };
    const start = (f, key = randomUUID(), body = f.body) => call(f.path + '/start', f.token, body, key);
    const arrive = (f, stop, key = randomUUID(), version = f.trip.version + 1) => call(f.path + `/stops/${stop}/arrive`, f.token, { ...f.body, expectedTripVersion: version }, key);
    let main;
    await t.test('requires accepted assignment, valid DTO, permission and ownership', async () => {
      const f = await fresh(), other = await fresh();
      assert.equal((await call(f.path + '/start', other.token, f.body, randomUUID())).status, 404);
      assert.equal((await call(f.path + '/start', null, f.body, randomUUID())).status, 401);
      assert.equal((await call(f.path + '/start', f.token, { ...f.body, driverId: f.driver.id }, randomUUID())).status, 400);
      assert.equal((await start(f, 'bad')).status, 400);
      assert.equal((await start(f, randomUUID(), { ...f.body, expectedTripVersion: 1 })).status, 409);
      await db.driverAssignment.update({ where: { id: f.a.id }, data: { status: 'ASSIGNED', respondedAt: null } });
      assert.equal((await start(f)).body.code, 'ASSIGNMENT_NOT_ACCEPTED');
      await db.userRoleScope.update({ where: { id: other.scope.id }, data: { active: false } });
      assert.equal((await start(other)).status, 403);
    });
    await t.test('starts early, keeps planned/assignment data, commits snapshot/event/command/audit/outbox', async () => {
      main = await fresh(); const key = randomUUID();
      assert.ok(main.trip.plannedStartTime > new Date());
      const r = await start(main, key); assert.equal(r.status, 200, JSON.stringify(r.body));
      main.startResult = r; main.startKey = key;
      const trip = await db.trip.findUniqueOrThrow({ where: { id: main.trip.id } });
      assert.equal(trip.status, 'IN_PROGRESS'); assert.ok(trip.actualStartTime);
      assert.equal(+trip.plannedStartTime, +main.trip.plannedStartTime); assert.equal(trip.version, main.trip.version + 1);
      assert.equal((await db.driverAssignment.findUniqueOrThrow({ where: { id: main.a.id } })).version, 2);
      const event = await db.executionEvent.findUniqueOrThrow({ where: { id: r.body.eventId }, include: { command: true, sourceSnapshot: true } });
      assert.equal(event.eventType, 'TRIP_STARTED'); assert.equal(event.command.status, 'COMPLETED');
      assert.equal(event.sourceSnapshot.sourceTripVersion, main.trip.version);
      assert.equal(event.sourceSnapshot.plan.stops.length, main.stops.length);
      assert.equal(await db.auditLog.count({ where: { entityId: trip.id, action: 'TRIP_STARTED' } }), 1);
      assert.equal(await db.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'driver.trip.started' } }), 1);
      const detail = await call(main.path, main.token);
      assert.equal(detail.body.trip.executionSnapshot.id, event.sourceSnapshotId);
      assert.equal(detail.body.trip.actualStartTime, trip.actualStartTime.toISOString());
    });
    await t.test('replay persists across keys and versions without duplicate start', async () => {
      assert.deepEqual(await start(main, main.startKey), main.startResult);
      assert.deepEqual(await start(main, main.startKey, { expectedTripVersion: main.body.expectedTripVersion, expectedVersion: main.body.expectedVersion }), main.startResult);
      assert.equal((await start(main, main.startKey, { ...main.body, expectedTripVersion: 99 })).body.code, 'IDEMPOTENCY_MISMATCH');
      assert.equal((await start(main, randomUUID(), { ...main.body, expectedTripVersion: main.trip.version + 1 })).body.code, 'INVALID_TRANSITION');
      assert.equal(await db.executionEvent.count({ where: { tripId: main.trip.id } }), 1);
    });
    await t.test('arrival requires own stop, current version, started trip and completed predecessor', async () => {
      assert.equal((await arrive(main, randomUUID())).status, 404);
      assert.equal((await arrive(main, main.stops[1].id)).body.code, 'PREVIOUS_STOP_INCOMPLETE');
      assert.equal((await arrive(main, main.stops[0].id, randomUUID(), main.trip.version)).body.code, 'VERSION_CONFLICT');
      const pending = await fresh();
      assert.equal((await arrive(pending, pending.stops[0].id, randomUUID(), pending.trip.version)).body.code, 'INVALID_TRANSITION');
      const other = await fresh();
      assert.equal((await call(main.path + `/stops/${main.stops[0].id}/arrive`, other.token, main.body, randomUUID())).status, 404);
    });
    await t.test('concurrent arrivals have one winner, retry returns exact result and next point stays blocked', async () => {
      const keys = [randomUUID(), randomUUID()];
      const results = await Promise.all(keys.map(key => arrive(main, main.stops[0].id, key)));
      assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
      const winner = results.findIndex(r => r.status === 200);
      assert.deepEqual(await arrive(main, main.stops[0].id, keys[winner]), results[winner]);
      const stop = await db.tripStop.findUniqueOrThrow({ where: { id: main.stops[0].id } });
      assert.equal(stop.status, 'ARRIVED'); assert.ok(stop.actualArrivalTime); assert.equal(stop.actualDepartureTime, null);
      assert.equal((await arrive(main, main.stops[1].id, randomUUID(), main.trip.version + 2)).body.code, 'PREVIOUS_STOP_INCOMPLETE');
      assert.equal(await db.executionEvent.count({ where: { tripId: main.trip.id, eventType: 'STOP_ARRIVED' } }), 1);
      assert.equal(await db.outboxEvent.count({ where: { aggregateId: main.trip.id, eventType: 'driver.stop.arrived' } }), 1);
    });
    await t.test('driver and vehicle cannot run different trips concurrently', async () => {
      const a = await fresh(), b = await fresh(a);
      assert.deepEqual((await Promise.all([start(a), start(b)])).map(r => r.status).sort(), [200,409]);
      const c = await fresh(), d = await fresh(undefined, c.vehicle);
      assert.deepEqual((await Promise.all([start(c), start(d)])).map(r => r.status).sort(), [200,409]);
    });
    await t.test('same-key concurrent start returns one durable result', async () => {
      const f = await fresh(), key = randomUUID();
      const [a,b] = await Promise.all([start(f,key), start(f,key)]);
      assert.equal(a.status, 200); assert.deepEqual(a,b);
      assert.equal(await db.executionEvent.count({ where: { tripId: f.trip.id } }), 1);
    });
    await t.test('unavailable vehicle, driver or expired licence prevents start', async () => {
      const f = await fresh();
      await db.vehicle.update({ where: { id: f.vehicle.id }, data: { status: 'MAINTENANCE' } });
      assert.equal((await start(f)).body.code, 'RESOURCE_UNAVAILABLE');
      await db.vehicle.update({ where: { id: f.vehicle.id }, data: { status: 'AVAILABLE' } });
      await db.driver.update({ where: { id: f.driver.id }, data: { licenseExpiry: new Date('2000-01-01') } });
      assert.equal((await start(f)).body.code, 'RESOURCE_UNAVAILABLE');
      assert.equal(await db.tripExecutionSnapshot.count({ where: { tripId: f.trip.id } }), 0);
    });
    await t.test('snapshot and execution history are immutable; changed plan cannot produce arrival', async () => {
      const f = await fresh(), r = await start(f); assert.equal(r.status, 200);
      await assert.rejects(db.tripExecutionSnapshot.update({ where: { id: r.body.snapshotId }, data: { planHash: 'tampered' } }));
      await assert.rejects(db.executionEvent.delete({ where: { id: r.body.eventId } }));
      await db.tripStop.update({ where: { id: f.stops[0].id }, data: { address: '[TEST changed plan]' } });
      assert.equal((await arrive(f, f.stops[0].id)).body.code, 'PLAN_CHANGED');
      assert.equal(await db.executionEvent.count({ where: { tripId: f.trip.id } }), 1);
    });
    await t.test('outbox error rolls back start, snapshot, event, audit and processed command', async () => {
      const f = await fresh(), key = randomUUID();
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_execution_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."aggregateId"='${f.trip.id}' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER fail_execution_outbox_test BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_execution_outbox_test()');
      try { assert.equal((await start(f,key)).status, 503); }
      finally {
        await db.$executeRawUnsafe('DROP TRIGGER fail_execution_outbox_test ON outbox_events');
        await db.$executeRawUnsafe('DROP FUNCTION fail_execution_outbox_test()');
      }
      const trip = await db.trip.findUniqueOrThrow({ where: { id: f.trip.id } });
      assert.equal(trip.status, 'DISPATCHED'); assert.equal(trip.actualStartTime, null); assert.equal(trip.version, f.trip.version);
      assert.equal(await db.tripExecutionSnapshot.count({ where: { tripId: f.trip.id } }), 0);
      assert.equal(await db.executionEvent.count({ where: { tripId: f.trip.id } }), 0);
      assert.equal(await db.auditLog.count({ where: { entityId: f.trip.id } }), 0);
      assert.equal(await db.processedCommand.count({ where: { idempotencyKey: key } }), 0);
      assert.equal((await start(f,key)).status, 200);
    });
    await t.test('actual mobile client starts, arrives, restores snapshot and receives current version', async () => {
      const f = await fresh(); let stored = null;
      // Test-only storage adapter; native SecureStore needs a device.
      const storage = { read: async () => stored, write: async token => { stored = token; }, clear: async () => { stored = null; } };
      const store = new DriverStore(new Api(base), storage, randomUUID);
      await store.login(f.user.username, process.env.AUTH_DEMO_PASSWORD);
      await store.open(f.a.id); assert.equal(store.snapshot().error, null);
      await store.respond('start'); assert.equal(store.snapshot().error, null);
      assert.equal(store.snapshot().detail.trip.status, 'IN_PROGRESS');
      await store.respond('arrive', '', f.stops[0].id); assert.equal(store.snapshot().error, null);
      assert.equal(store.snapshot().detail.trip.stops[0].status, 'ARRIVED');
      const reopened = new DriverStore(new Api(base), storage, randomUUID);
      await reopened.restore(); await reopened.open(f.a.id);
      assert.equal(reopened.snapshot().detail.trip.version, f.trip.version + 2);
      assert.equal(reopened.snapshot().detail.trip.stops[0].status, 'ARRIVED');
      await reopened.logout(); assert.equal(stored, null);
    });
    await t.test('snapshot and stop foreign keys cannot join execution data from different trips', async () => {
      const other = await fresh();
      const source = await db.executionEvent.findUniqueOrThrow({ where: { id: main.startResult.body.eventId } });
      await assert.rejects(db.executionEvent.create({ data: { tripId: other.trip.id, sourceSnapshotId: source.sourceSnapshotId,
        actorUserId: main.user.id, commandId: source.commandId, eventSequence: 1, eventType: 'TEST_FK', occurredAt: new Date() } }));
      await assert.rejects(db.executionEvent.create({ data: { tripId: main.trip.id, tripStopId: other.stops[0].id, sourceSnapshotId: source.sourceSnapshotId,
        actorUserId: main.user.id, commandId: source.commandId, eventSequence: 1, eventType: 'TEST_FK', occurredAt: new Date() } }));
    });
  } finally { await app.close(); }
});
