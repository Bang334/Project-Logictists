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
const { preparePickupFixture } = require('../dist/prisma/seed-driver-pickup');
const { seedDriverMobile, createDriverDemoTrip } = require('../dist/prisma/seed-driver-mobile');

test('Driver pickup: HTTP and real PostgreSQL transactions', { timeout: 120000 }, async t => {
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
      await db.$transaction(tx => preparePickupFixture(tx, trip.id));
      const a = await db.driverAssignment.findFirstOrThrow({ where: { tripId: trip.id } });
      await db.driverAssignment.update({ where: { id: a.id }, data: { status: 'ACCEPTED', respondedAt: new Date(), version: 2 } });
      const stops = await db.tripStop.findMany({ where: { tripId: trip.id }, orderBy: { sequence: 'asc' } });
      return { ...owner, vehicle, trip, a, stops, body: { expectedVersion: 2, expectedTripVersion: trip.version }, path: '/driver/assignments/' + a.id };
    };
    const start = (f, key = randomUUID(), body = f.body) => call(f.path + '/start', f.token, body, key);
    const arrive = (f, stop, key = randomUUID(), version = f.trip.version + 1) => call(f.path + `/stops/${stop}/arrive`, f.token, { ...f.body, expectedTripVersion: version }, key);
    const ready = async (owner, sharedVehicle) => {
      const f = await fresh(owner, sharedVehicle);
      assert.equal((await start(f)).status, 200);
      assert.equal((await arrive(f, f.stops[0].id)).status, 200);
      f.tasks = await db.stopTask.findMany({ where: { tripStopId: f.stops[0].id }, include: { allocation: { include: { package: true } } } });
      f.tasks.sort((a,b) => a.allocation.package.packageCode.localeCompare(b.allocation.package.packageCode));
      f.version = f.trip.version + 2;
      f.qr = f.tasks.map(t => `TMS:PACKAGE:1:${t.allocation.packageId}`);
      return f;
    };
    const body = f => ({ expectedVersion: 2, expectedTripVersion: f.version });
    const send = (f, endpoint, data, key = randomUUID()) => call(f.path + `/stops/${f.stops[0].id}/${endpoint}`, f.token, { ...body(f), ...data }, key);
    const load = (f, i=0, key=randomUUID()) => send(f, 'pickup', { qrCode: f.qr[i], loadedOnVehicle: true }, key);
    const complete = (f, declaredOutcome, missing=[], key=randomUUID()) => send(f, 'complete-pickup', { declaredOutcome, missing }, key);
    const count = f => db.pickupResult.count({ where: { event: { tripId: f.trip.id } } });
    await t.test('scan checks ownership, correct package and plan without marking loaded', async () => {
      const f = await ready(), other = await fresh();
      const before = await db.processedCommand.count({ where: { actorUserId: f.user.id } });
      const r = await send(f, 'scan-pickup', { qrCode: f.qr[0] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.packageId, f.tasks[0].allocation.packageId);
      assert.equal(r.body.placement.xMm, 0); assert.equal(await count(f), 0);
      assert.equal(await db.processedCommand.count({ where: { actorUserId: f.user.id } }), before);
      assert.equal((await send(f, 'scan-pickup', { qrCode: 'unknown-qr' })).status, 404);
      assert.equal((await call(f.path + `/stops/${f.stops[0].id}/pickup`, other.token, { ...body(f), qrCode: f.qr[0], loadedOnVehicle: true }, randomUUID())).status, 404);
      assert.equal((await send(f, 'pickup', { qrCode: f.qr[0] })).status, 400);
      assert.equal((await send(f, 'pickup', { qrCode: f.qr[0], loadedOnVehicle: false })).status, 400);
      assert.equal((await send(f, 'pickup', { qrCode: f.qr[0], loadedOnVehicle: true, driverId: f.driver.id })).status, 400);
      await db.userRoleScope.update({ where: { id: f.scope.id }, data: { active: false } });
      assert.equal((await load(f)).status, 403);
    });
    await t.test('load updates only actuals and custody, repeated intent has no extra effects', async () => {
      const f = await ready(), key = randomUUID();
      const r = await load(f, 0, key); assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(await load(f, 0, key), r);
      assert.equal((await load(f, 1, key)).body.code, 'IDEMPOTENCY_MISMATCH');
      assert.equal(await count(f), 1);
      const task = await db.stopTask.findUniqueOrThrow({ where: { id: f.tasks[0].id } });
      assert.equal(task.actualQuantity, 1); assert.equal(task.plannedQuantity, 1);
      const parcel = await db.package.findUniqueOrThrow({ where: { id: f.tasks[0].allocation.packageId } });
      assert.equal(parcel.status, 'LOADED'); assert.equal(parcel.version, f.tasks[0].allocation.package.version + 1);
      const event = await db.executionEvent.findUniqueOrThrow({ where: { id: r.body.eventId }, include: { command: true } });
      assert.equal(event.command.status, 'COMPLETED'); assert.equal(event.payload.vehicleId, f.vehicle.id);
      assert.equal(event.payload.confirmationMethod, 'QR_AND_LOADED_ATTESTATION');
      assert.ok(!JSON.stringify(event).includes(f.qr[0]));
      assert.equal(await db.auditLog.count({ where: { entityId: f.trip.id, action: 'PACKAGE_LOADED' } }), 1);
      assert.equal(await db.outboxEvent.count({ where: { aggregateId: f.trip.id, eventType: 'driver.package.loaded' } }), 1);
      f.version++; assert.equal((await load(f)).body.code, 'PACKAGE_ALREADY_RECORDED');
      const detail = await call(f.path, f.token);
      assert.equal(detail.body.trip.stops[0].tasks.find(t => t.id === task.id).pickup.outcome, 'LOADED');
      assert.ok(!/password|qrHash|placementHash|validatorVersion/.test(JSON.stringify(detail.body)));
      assert.equal(detail.body.trip.status, 'IN_PROGRESS');
    });
    await t.test('partial completion requires an exact manifest of missing packages and truthful outcome', async () => {
      const f = await ready(); assert.equal((await load(f)).status, 200); f.version++;
      assert.equal((await complete(f, 'PARTIAL')).status, 400);
      assert.equal((await complete(f, 'PARTIAL', [{ taskId: f.tasks[1].id, reason: ' ' }])).status, 400);
      assert.equal((await complete(f, 'PARTIAL', [{ taskId: f.tasks[0].id, reason: 'Wrong task' }])).status, 400);
      const missing = [{ taskId: f.tasks[1].id, reason: 'Sender has not packed this parcel' }];
      assert.equal((await complete(f, 'FULL', missing)).status, 400);
      assert.equal((await complete(f, 'PARTIAL', [...missing, ...missing])).status, 400);
      const key = randomUUID(), r = await complete(f, 'PARTIAL', missing, key);
      assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(await complete(f, 'PARTIAL', missing, key), r);
      const absent = await db.pickupResult.findUniqueOrThrow({ where: { stopTaskId: f.tasks[1].id } });
      assert.equal(absent.reason, missing[0].reason); assert.equal(absent.outcome, 'NOT_COLLECTED');
      assert.equal((await db.package.findUniqueOrThrow({ where: { id: absent.packageId } })).status, 'ALLOCATED');
      assert.equal((await db.stopTask.findUniqueOrThrow({ where: { id: absent.stopTaskId } })).actualQuantity, 0);
      const stop = await db.tripStop.findUniqueOrThrow({ where: { id: f.stops[0].id } });
      assert.equal(stop.status, 'COMPLETED'); assert.ok(stop.actualDepartureTime);
      assert.deepEqual((await call(f.path,f.token)).body.trip.stops[0].pickupSummary, { plannedCount: 2, loadedCount: 1, outcome: 'PARTIAL' });
      assert.equal(+stop.plannedDepartureTime, +f.stops[0].plannedDepartureTime);
      const events = await db.executionEvent.findMany({ where: { command: { idempotencyKey: key } }, orderBy: { eventSequence: 'asc' } });
      assert.deepEqual(events.map(e => e.eventType), ['PACKAGE_NOT_COLLECTED', 'PICKUP_STOP_COMPLETED']);
      f.version++;
      assert.equal((await load(f, 1)).body.code, 'INVALID_TRANSITION');
      assert.equal((await arrive(f, f.stops[1].id, randomUUID(), f.version)).status, 200);
      const unload = await db.stopTask.findMany({ where: { tripStopId: f.stops[1].id } });
      assert.ok(unload.every(t => t.actualQuantity === null));
    });
    await t.test('all received and none received are distinct durable outcomes', async () => {
      const full = await ready();
      assert.equal((await load(full)).status, 200); full.version++;
      assert.equal((await load(full, 1)).status, 200); full.version++;
      assert.equal((await complete(full, 'FULL')).body.outcome, 'FULL');
      const none = await ready();
      assert.equal((await complete(none, 'NONE', none.tasks.map(t => ({ taskId: t.id, reason: 'No goods available' })))).body.outcome, 'NONE');
      assert.equal(await db.package.count({ where: { id: { in: none.tasks.map(t => t.allocation.packageId) }, status: 'LOADED' } }), 0);
      assert.equal(await count(none), 2);
    });
    await t.test('concurrent scans, new keys, load vs close and stale versions have one winner', async () => {
      const f = await ready(), key = randomUUID();
      const same = await Promise.all([load(f,0,key), load(f,0,key)]);
      assert.equal(same[0].status, 200); assert.deepEqual(same[0], same[1]);
      assert.equal((await load(f,1)).body.code, 'VERSION_CONFLICT'); f.version++;
      const race = await Promise.all([load(f,1), complete(f,'PARTIAL',[{ taskId: f.tasks[1].id, reason: 'Not supplied' }])]);
      assert.deepEqual(race.map(r => r.status).sort(), [200,409]);
      assert.equal(await count(f), 2);
      const g = await ready();
      assert.deepEqual((await Promise.all([load(g),load(g)])).map(r => r.status).sort(), [200,409]);
    });
    await t.test('immutable load plan detects package changes, missing plan and blocks unsafe order', async () => {
      const f = await ready();
      assert.equal((await load(f,1)).status, 200); f.version++;
      assert.equal((await load(f)).body.code, 'LOADING_PATH_BLOCKED');
      assert.equal(await count(f), 1);
      const changed = await ready();
      await db.package.update({ where: { id: changed.tasks[0].allocation.packageId }, data: { lengthMm: 201 } });
      assert.equal((await load(changed)).body.code, 'PLAN_CHANGED');
      const draft = await fresh();
      await db.loadPlan.updateMany({ where: { tripId: draft.trip.id }, data: { validationStatus: 'PENDING' } });
      assert.equal((await start(draft)).status, 200); assert.equal((await arrive(draft,draft.stops[0].id)).status,200);
      draft.version=draft.trip.version+2; draft.qr=[(await db.allocation.findFirstOrThrow({where:{tripId:draft.trip.id}})).packageId];
      draft.qr[0]='TMS:PACKAGE:1:'+draft.qr[0];
      assert.equal((await load(draft)).body.code,'LOAD_PLAN_REQUIRED');
    });
    await t.test('outbox failure rolls back parcel, actuals, receipts, audit, events and command', async () => {
      const f = await ready(), key = randomUUID();
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_pickup_outbox_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."aggregateId"='${f.trip.id}' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER fail_pickup_outbox_test BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_pickup_outbox_test()');
      try { assert.equal((await load(f,0,key)).status,503); }
      finally { await db.$executeRawUnsafe('DROP TRIGGER fail_pickup_outbox_test ON outbox_events'); await db.$executeRawUnsafe('DROP FUNCTION fail_pickup_outbox_test()'); }
      assert.equal(await count(f),0);
      assert.equal((await db.package.findUniqueOrThrow({where:{id:f.tasks[0].allocation.packageId}})).status,'ALLOCATED');
      assert.equal((await db.stopTask.findUniqueOrThrow({where:{id:f.tasks[0].id}})).actualQuantity,null);
      assert.equal((await db.trip.findUniqueOrThrow({where:{id:f.trip.id}})).version,f.version);
      assert.equal(await db.executionEvent.count({where:{tripId:f.trip.id,eventType:'PACKAGE_LOADED'}}),0);
      assert.equal(await db.auditLog.count({where:{entityId:f.trip.id,action:'PACKAGE_LOADED'}}),0);
      assert.equal(await db.processedCommand.count({where:{idempotencyKey:key}}),0);
      assert.equal((await load(f,0,key)).status,200);
      const receipt = await db.pickupResult.findUniqueOrThrow({where:{stopTaskId:f.tasks[0].id}});
      await assert.rejects(db.pickupResult.update({where:{id:receipt.id},data:{reason:'tamper'}}));
      await assert.rejects(db.pickupResult.delete({where:{id:receipt.id}}));
    });
    await t.test('partial completion also rolls back all missing results and stop actuals on failure', async () => {
      const f=await ready(), key=randomUUID(), missing=f.tasks.map(t=>({taskId:t.id,reason:'Not supplied'}));
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_pickup_close_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."aggregateId"='${f.trip.id}' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe('CREATE TRIGGER fail_pickup_close_test BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_pickup_close_test()');
      try { assert.equal((await complete(f,'NONE',missing,key)).status,503); }
      finally { await db.$executeRawUnsafe('DROP TRIGGER fail_pickup_close_test ON outbox_events'); await db.$executeRawUnsafe('DROP FUNCTION fail_pickup_close_test()'); }
      assert.equal(await count(f),0);
      assert.ok((await db.stopTask.findMany({where:{tripStopId:f.stops[0].id}})).every(t=>t.actualQuantity===null));
      const stop=await db.tripStop.findUniqueOrThrow({where:{id:f.stops[0].id}});
      assert.equal(stop.status,'ARRIVED'); assert.equal(stop.actualDepartureTime,null);
      assert.equal(await db.processedCommand.count({where:{idempotencyKey:key}}),0);
      assert.equal((await complete(f,'NONE',missing,key)).status,200);
    });
    await t.test('legacy execution snapshots stay immutable and cannot silently acquire pickup history', async () => {
      const f=await fresh();
      const { readExecutionPlan, planHash, jsonValue }=require('../dist/src/driver-mobile/execution-plan');
      const plan=await readExecutionPlan(db,f.trip.id,false);
      await db.tripExecutionSnapshot.create({data:{tripId:f.trip.id,sourceTripVersion:f.trip.version,planHash:planHash(plan,false),plan:jsonValue(plan)}});
      await db.trip.update({where:{id:f.trip.id},data:{status:'IN_PROGRESS',actualStartTime:new Date(),version:{increment:1}}});
      assert.equal((await arrive(f,f.stops[0].id)).status,200);
      f.version=f.trip.version+2;
      const a=await db.allocation.findFirstOrThrow({where:{tripId:f.trip.id}}); f.qr=['TMS:PACKAGE:1:'+a.packageId];
      assert.equal((await load(f)).body.code,'PICKUP_SNAPSHOT_REQUIRED'); assert.equal(await count(f),0);
    });
    await t.test('real mobile API/store scans, confirms partial pickup and restores durable state', async () => {
      const f = await ready(); let stored = f.token;
      const storage = { read:async()=>stored,write:async token=>{stored=token;},clear:async()=>{stored=null;} };
      const store = new DriverStore(new Api(base),storage,randomUUID);
      await store.restore(); await store.open(f.a.id);
      const scan=await store.scanPickup(f.stops[0].id,f.qr[0]); assert.equal(scan.packageId,f.tasks[0].allocation.packageId);
      assert.equal(await count(f),0);
      await store.respond('pickup','',f.stops[0].id,{qrCode:f.qr[0],loadedOnVehicle:true}); assert.equal(store.snapshot().error,null);
      await store.respond('complete-pickup','',f.stops[0].id,{declaredOutcome:'PARTIAL',missing:[{taskId:f.tasks[1].id,reason:'Sender not ready'}]});
      assert.equal(store.snapshot().error,null); assert.equal(store.snapshot().detail.trip.stops[0].status,'COMPLETED');
      const reopened=new DriverStore(new Api(base),storage,randomUUID); await reopened.restore(); await reopened.open(f.a.id);
      assert.equal(reopened.snapshot().detail.trip.stops[0].tasks.filter(t=>t.pickup?.outcome==='LOADED').length,1);
      await reopened.logout(); assert.equal(stored,null); assert.equal(reopened.snapshot().detail,null);
    });
  } finally { await app.close(); }
});
