const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaModule } = require('../dist/src/prisma/prisma.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthModule } = require('../dist/src/auth/auth.module');
const { VehiclesModule } = require('../dist/src/vehicles/vehicles.module');
const { DriversModule } = require('../dist/src/drivers/drivers.module');
const { FleetModule } = require('../dist/src/fleet/fleet.module');
const { seedAuth } = require('../dist/prisma/seed-auth');

test('Fleet profile updates: PostgreSQL and authenticated HTTP', { timeout: 90000 }, async t => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/tms_fleet_test');
  process.env.JWT_SECRET = 'isolated-fleet-test-secret-at-least-32-characters';
  process.env.AUTH_DEMO_PASSWORD = 'Fleet-test-only-2026!';
  class FleetTestModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, VehiclesModule, DriversModule, FleetModule] })(FleetTestModule);
  const app = await NestFactory.create(FleetTestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.init();
  const db = app.get(PrismaService);
  try {
    await seedAuth(db);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const req = async (path, token, method = 'GET', body, key) => {
      const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(key ? { 'Idempotency-Key': key } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json() };
    };
    const login = async username => {
      const r = await req('/auth/login', null, 'POST', { username, password: process.env.AUTH_DEMO_PASSWORD });
      assert.equal(r.status, 200); return r.body.accessToken;
    };
    const admin = await login('demo_auth_admin'), dispatcher = await login('demo_auth_a');
    const branch = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const type = await db.vehicleType.create({ data: { code: randomUUID(), name: '[TEST] type', payloadCapacityKg: 1000, volumeCapacityM3: 8, lengthCm: 200, widthCm: 200, heightCm: 200 } });
    let vehicle = await db.vehicle.create({ data: { plateNumber: randomUUID(), model: '[TEST] vehicle', homeBranchId: branch.id, vehicleTypeId: type.id } });
    const employee = await db.employee.create({ data: { employeeCode: randomUUID(), fullName: '[TEST] employee', phone: '100', branchId: branch.id, joinedOn: new Date('2026-01-01') } });
    let driver = await db.driver.create({ data: { employeeId: employee.id, fullName: employee.fullName, citizenId: randomUUID(), phone: '100', licenseNumber: randomUUID(), licenseClass: 'TEST', licenseExpiry: new Date('2035-01-01'), homeBranchId: branch.id } });
    await t.test('concurrent edits commit exactly once and stale version cannot overwrite', async () => {
      const updates = await Promise.all(['one', 'two'].map(model => req('/vehicles/' + vehicle.id, admin, 'PATCH', { model, expectedUpdatedAt: vehicle.updatedAt.toISOString() })));
      assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
      assert.equal(updates.find(r => r.status === 409).body.code, 'RESOURCE_VERSION_CONFLICT');
      vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
      assert.equal((await req('/vehicles/' + vehicle.id, admin)).body.model, vehicle.model);
      assert.equal(await db.auditLog.count({ where: { entityType: 'Vehicle', entityId: vehicle.id } }), 1);
    });
    await t.test('validation rejects missing version and internal fields; dispatcher cannot edit', async () => {
      assert.equal((await req('/vehicles/' + vehicle.id, admin, 'PATCH', { model: 'bad' })).status, 400);
      assert.equal((await req('/vehicles/' + vehicle.id, admin, 'PATCH', { expectedUpdatedAt: vehicle.updatedAt.toISOString(), currentLatitude: 1 })).status, 400);
      assert.equal((await req('/vehicles/' + vehicle.id, dispatcher, 'PATCH', { expectedUpdatedAt: vehicle.updatedAt.toISOString(), model: 'bad' })).status, 403);
    });
    await t.test('driver edits preserve zero salary, update linked Employee, and detect concurrent edits', async () => {
      const updates = await Promise.all(['name A', 'name B'].map(fullName => req('/drivers/' + driver.id, admin, 'PATCH', { fullName, expectedUpdatedAt: driver.updatedAt.toISOString() })));
      assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
      driver = await db.driver.findUniqueOrThrow({ where: { id: driver.id } });
      assert.equal(String(driver.fixedSalaryMonthly), '0');
      assert.equal((await db.employee.findUniqueOrThrow({ where: { id: employee.id } })).fullName, driver.fullName);
      assert.equal((await req('/drivers/' + driver.id, admin)).body.fullName, driver.fullName);
    });
    await t.test('does not overwrite newer Employee information through a stale Driver projection', async () => {
      await db.employee.update({ where: { id: employee.id }, data: { fullName: 'Employee changed independently', version: { increment: 1 } } });
      const r = await req('/drivers/' + driver.id, admin, 'PATCH', { fullName: 'Overwrite', expectedUpdatedAt: driver.updatedAt.toISOString() });
      assert.equal(r.status, 409); assert.equal(r.body.code, 'EMPLOYEE_PROFILE_CONFLICT');
      assert.equal((await db.employee.findUniqueOrThrow({ where: { id: employee.id } })).fullName, 'Employee changed independently');
      assert.equal((await db.driver.findUniqueOrThrow({ where: { id: driver.id } })).fullName, driver.fullName);
    });
    await t.test('resource lock serializes profile update behind reservation write', async () => {
      let locked;
      const ready = new Promise(resolve => { locked = resolve; });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const writer = db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4101, hashtext(${vehicle.id}))`;
        const trip = await tx.trip.create({ data: { tripNumber: randomUUID(), vehicleId: vehicle.id, managingBranchId: branch.id, status: 'PLANNED', plannedStartTime: new Date('2026-11-01T01:00:00Z'), plannedEndTime: new Date('2026-11-01T02:00:00Z') } });
        await tx.resourceReservation.create({ data: { tripId: trip.id, vehicleId: vehicle.id, startsAt: trip.plannedStartTime, endsAt: trip.plannedEndTime, status: 'HELD' } });
        locked(); await gate;
      });
      await ready;
      const write = req('/vehicles/' + vehicle.id, admin, 'PATCH', { status: 'MAINTENANCE', expectedUpdatedAt: vehicle.updatedAt.toISOString() });
      release(); await writer;
      const r = await write;
      assert.equal(r.status, 409); assert.equal(r.body.code, 'RESOURCE_IN_USE');
      assert.equal((await db.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).status, 'AVAILABLE');
    });
    await t.test('active driver reservation prevents manual status override', async () => {
      const trip = await db.trip.create({ data: { tripNumber: randomUUID(), vehicleId: vehicle.id, managingBranchId: branch.id, status: 'PLANNED', plannedStartTime: new Date('2026-11-02T01:00:00Z'), plannedEndTime: new Date('2026-11-02T02:00:00Z') } });
      await db.driverShift.create({ data: { driverId: driver.id, startsAt: trip.plannedStartTime, endsAt: trip.plannedEndTime, reason: 'Fixture shift', recordedById: (await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_admin' } })).id } });
      await db.resourceReservation.create({ data: { tripId: trip.id, driverId: driver.id, startsAt: trip.plannedStartTime, endsAt: trip.plannedEndTime, status: 'ACTIVE' } });
      const r = await req('/drivers/' + driver.id, admin, 'PATCH', { status: 'ON_LEAVE', expectedUpdatedAt: driver.updatedAt.toISOString() });
      assert.equal(r.status, 409); assert.equal(r.body.code, 'RESOURCE_IN_USE');
    });
    let v, d, shift;
    const span = { startsAt: '2030-11-01T15:00:00Z', endsAt: '2030-11-02T03:00:00Z' };
    const schedulePath = (kind, id) => `/fleet/${kind}/${id}/schedules`;
    const saveSchedule = (kind, id, body, key = randomUUID()) => req(schedulePath(kind, id), admin, 'POST', body, key);
    const query = (times = span) => new URLSearchParams(times).toString();
    const availability = async (kind, id, times = span) => { const r = await req(`/fleet/${kind}/availability?` + query(times) + '&pageSize=100', admin); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.items.find(row => row.resourceId === id); };
    await t.test('create vehicle with normalized unique plate and idempotent concurrent retry', async () => {
      const plate = 'T' + randomUUID().replaceAll('-', '').slice(0, 12);
      const body = { plateNumber: plate, model: 'Fleet create test', vehicleTypeId: type.id, homeBranchId: branch.id };
      const key = randomUUID(); const results = await Promise.all([req('/fleet/vehicles', admin, 'POST', body, key), req('/fleet/vehicles', admin, 'POST', body, key)]);
      results.forEach(r => assert.equal(r.status, 201, JSON.stringify(r.body))); v = results[0].body;
      assert.equal(v.id, results[1].body.id);
      assert.equal((await req('/fleet/vehicles', admin, 'POST', { ...body, model: 'Other' }, key)).status, 409);
      assert.equal((await req('/fleet/vehicles', admin, 'POST', { ...body, plateNumber: plate.slice(0, 3) + '-.' + plate.slice(3).toLowerCase() }, randomUUID())).status, 409);
      assert.equal((await req('/fleet/vehicles/' + v.id, admin)).body.id, v.id);
    });
    await t.test('create driver from existing Employee without account; privacy and forged inputs', async () => {
      const e = await db.employee.create({ data: { employeeCode: randomUUID(), fullName: '[FLEET] new driver', citizenId: randomUUID(), phone: '100', branchId: branch.id, joinedOn: new Date('2026-01-01') } });
      const body = { employeeId: e.id, employeeVersion: e.version, licenseNumber: randomUUID(), licenseClass: 'TEST', licenseExpiry: '2030-11-02' };
      const key = randomUUID(); const results = await Promise.all([req('/fleet/drivers', admin, 'POST', body, key), req('/fleet/drivers', admin, 'POST', body, key)]);
      results.forEach(r => assert.equal(r.status, 201, JSON.stringify(r.body))); d = results[0].body; assert.equal(d.id, results[1].body.id); assert.equal(d.userLinked, false);
      const list = await req('/fleet/drivers?search=' + encodeURIComponent(e.fullName), dispatcher); assert.equal(list.status, 200); assert.ok(!('citizenId' in list.body.items[0])); assert.ok(!('licenseNumber' in list.body.items[0]));
      assert.equal((await req('/fleet/drivers', dispatcher, 'POST', body, randomUUID())).status, 403);
      assert.equal((await req('/fleet/drivers', admin, 'POST', { ...body, userId: randomUUID() }, randomUUID())).status, 400);
      assert.equal((await req('/fleet/vehicles', admin, 'POST', { plateNumber: 'bad', model: 'bad', homeBranchId: randomUUID(), vehicleTypeId: type.id }, randomUUID())).status, 400);
      assert.equal((await req('/fleet/drivers/availability?' + query(), admin)).status, 200);
      assert.ok((await availability('drivers', d.id)).reasons.includes('SHIFT_NOT_COVERING_INTERVAL'));
    });
    await t.test('overnight shift, adjacency, overlap, invalid interval, retry and version conflict', async () => {
      const body = { ...span, kind: 'SHIFT', reason: 'Overnight shift' }, key = randomUUID();
      const r = await saveSchedule('drivers', d.id, body, key); assert.equal(r.status, 201, JSON.stringify(r.body)); shift = r.body;
      assert.equal((await saveSchedule('drivers', d.id, body, key)).body.id, shift.id);
      assert.equal((await saveSchedule('drivers', d.id, { ...body, reason: 'Different' }, key)).status, 409);
      assert.equal((await saveSchedule('drivers', d.id, body)).status, 409);
      assert.equal((await saveSchedule('drivers', d.id, { ...body, endsAt: body.startsAt })).status, 400);
      assert.equal((await saveSchedule('drivers', d.id, { ...body, startsAt: span.endsAt, endsAt: '2030-11-02T05:00:00Z' })).status, 201);
      let a = await availability('drivers', d.id, { ...span, endsAt: '2030-11-02T05:00:00Z' }); assert.equal(a.scheduleCovered, true);
      const list = await req(schedulePath('drivers', d.id) + '?' + query(), admin); assert.equal(list.status, 200); shift = list.body.items.find(row => row.id === shift.id); assert.equal(shift.recordedById != null, true);
      const updates = await Promise.all(['A', 'B'].map(reason => req(schedulePath('drivers', d.id) + '/SHIFT/' + shift.id, admin, 'PATCH', { ...body, reason, version: shift.version }, randomUUID())));
      assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
      a = await availability('drivers', d.id); assert.notEqual(a.version, d.updatedAt);
    });
    await t.test('license is valid through local expiry day and invalid beyond it', async () => {
      const inside = await availability('drivers', d.id, { startsAt: '2030-11-02T15:00:00Z', endsAt: '2030-11-02T17:00:00Z' });
      assert.ok(!inside.reasons.includes('LICENSE_EXPIRES_BEFORE_WORK_END'));
      const beyond = await availability('drivers', d.id, { startsAt: '2030-11-02T16:00:00Z', endsAt: '2030-11-02T17:00:00.001Z' });
      assert.ok(beyond.reasons.includes('LICENSE_EXPIRES_BEFORE_WORK_END'));
    });
    await t.test('calendar snapshot carries real shifts and versions without identity documents', async () => {
      const { calendarSnapshot } = require('../dist/src/fleet/calendar-snapshot');
      const snapshot = await calendarSnapshot(db, [v.id], [d.id], new Date(span.startsAt), new Date(span.endsAt));
      assert.equal(snapshot.contractVersion, 'fleet.calendar.v1');
      assert.ok(snapshot.shifts.some(s => s.id === shift.id));
      await assert.rejects(db.driverShift.update({ where: { id: shift.id }, data: { driverId: driver.id } }), /FLEET_SCHEDULE_CONFLICT/);
      assert.equal((await db.driverShift.findUniqueOrThrow({ where: { id: shift.id } })).driverId, d.id);
      const current = await db.driver.findUniqueOrThrow({ where: { id: d.id } });
      assert.equal(snapshot.drivers[0].updatedAt.toISOString(), current.updatedAt.toISOString());
      for (const forbidden of ['citizenId', 'licenseNumber', 'phone', 'reason']) assert.ok(!JSON.stringify(snapshot).includes('"' + forbidden + '"'));
      assert.equal((await req(schedulePath('drivers', d.id), dispatcher, 'POST', { ...span, kind: 'OTHER', reason: 'Forbidden' }, randomUUID())).status, 403);
      const otherBranch = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } });
      const foreign = await db.vehicle.create({ data: { plateNumber: randomUUID(), model: 'Other branch', homeBranchId: otherBranch.id, vehicleTypeId: type.id } });
      assert.equal((await req(schedulePath('vehicles', foreign.id) + '?' + query(), dispatcher)).status, 404);
    });
    await t.test('legacy Employee link preserves Driver ID, is retryable and cannot replace identity', async () => {
      const legacy = await db.driver.create({ data: { fullName: 'Legacy', citizenId: randomUUID(), phone: '100', licenseNumber: randomUUID(), licenseClass: 'TEST', licenseExpiry: new Date('2035-01-01'), homeBranchId: branch.id } });
      const employee = await db.employee.create({ data: { employeeCode: randomUUID(), fullName: 'Linked employee', citizenId: randomUUID(), phone: '101', branchId: branch.id, joinedOn: new Date('2026-01-01') } });
      const body = { employeeId: employee.id, employeeVersion: employee.version, expectedUpdatedAt: legacy.updatedAt.toISOString() }, key = randomUUID();
      const path = '/fleet/drivers/' + legacy.id + '/employee';
      const saved = await req(path, admin, 'POST', body, key); assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.equal(saved.body.id, legacy.id); assert.equal(saved.body.employeeId, employee.id); assert.equal(saved.body.fullName, employee.fullName);
      assert.equal((await req(path, admin, 'POST', body, key)).body.id, legacy.id);
      assert.equal((await req(path, admin, 'POST', { ...body, expectedUpdatedAt: saved.body.updatedAt }, randomUUID())).status, 409);
    });
    await t.test('leave uses EmployeeLeave and blocks availability; cancel preserves history', async () => {
      const r = await saveSchedule('drivers', d.id, { ...span, kind: 'LEAVE', reason: 'Leave test' }); assert.equal(r.status, 201, JSON.stringify(r.body));
      const saved = await db.employeeLeave.findUniqueOrThrow({ where: { id: r.body.id } }); assert.equal(saved.employeeId, d.employeeId); assert.equal(saved.approvalStatus, 'APPROVED');
      assert.ok((await availability('drivers', d.id)).reasons.includes('EMPLOYEE_LEAVE'));
      assert.equal((await req(schedulePath('drivers', d.id) + '/LEAVE/' + saved.id + '/cancel', admin, 'POST', { version: saved.version, reason: 'Correction' }, randomUUID())).status, 201);
      assert.equal((await db.employeeLeave.findUniqueOrThrow({ where: { id: saved.id } })).approvalStatus, 'CANCELLED');
    });
    let planned;
    await t.test('reservation rejects missing shift; normal leave and shift cancellation cannot conflict with assignments', async () => {
      planned = await db.trip.create({ data: { tripNumber: randomUUID(), vehicleId: v.id, managingBranchId: branch.id, status: 'PLANNED', plannedStartTime: new Date(span.startsAt), plannedEndTime: new Date(span.endsAt) } });
      await db.resourceReservation.createMany({ data: [{ tripId: planned.id, vehicleId: v.id, startsAt: planned.plannedStartTime, endsAt: planned.plannedEndTime, status: 'HELD' }, { tripId: planned.id, driverId: d.id, startsAt: planned.plannedStartTime, endsAt: planned.plannedEndTime, status: 'HELD' }] });
      assert.equal((await saveSchedule('drivers', d.id, { ...span, kind: 'OTHER', reason: 'Conflicting leave' })).status, 409);
      const current = await db.driverShift.findUniqueOrThrow({ where: { id: shift.id } });
      assert.equal((await req(schedulePath('drivers', d.id) + '/SHIFT/' + shift.id + '/cancel', admin, 'POST', { version: current.version, reason: 'Would remove assigned shift' }, randomUUID())).status, 409);
      await assert.rejects(db.resourceReservation.create({ data: { tripId: planned.id, driverId: d.id, startsAt: new Date('2030-11-03T01:00:00Z'), endsAt: new Date('2030-11-03T02:00:00Z'), status: 'HELD' } }));
    });
    await t.test('actual breakdown persists despite trip, ordinary maintenance refused; no automatic Trip mutation', async () => {
      assert.equal((await saveSchedule('vehicles', v.id, { ...span, kind: 'MAINTENANCE', reason: 'Conflict' })).status, 409);
      const r = await saveSchedule('vehicles', v.id, { ...span, kind: 'BREAKDOWN', reason: 'Actual breakdown' }); assert.equal(r.status, 201, JSON.stringify(r.body));
      const a = await availability('vehicles', v.id); assert.ok(a.reasons.includes('VEHICLE_UNAVAILABILITY')); assert.ok(a.affectedTrips.some(t => t.id === planned.id));
      assert.equal((await db.trip.findUniqueOrThrow({ where: { id: planned.id } })).status, 'PLANNED');
      await assert.rejects(db.resourceReservation.updateMany({ where: { tripId: planned.id }, data: { status: 'ACTIVE' } }));
      assert.equal((await req('/vehicles/' + v.id, admin, 'PATCH', { expectedUpdatedAt: a.version, homeBranchId: (await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-B' } })).id })).status, 409);
    });
    await t.test('concurrent maintenance and reservation cannot both commit', async () => {
      const newV = await db.vehicle.create({ data: { plateNumber: randomUUID(), model: 'Race', homeBranchId: branch.id, vehicleTypeId: type.id } });
      const trip = await db.trip.create({ data: { tripNumber: randomUUID(), vehicleId: newV.id, managingBranchId: branch.id, status: 'DRAFT', plannedStartTime: new Date(span.startsAt), plannedEndTime: new Date(span.endsAt) } });
      const results = await Promise.allSettled([saveSchedule('vehicles', newV.id, { ...span, kind: 'MAINTENANCE', reason: 'Race' }), db.resourceReservation.create({ data: { tripId: trip.id, vehicleId: newV.id, startsAt: trip.plannedStartTime, endsAt: trip.plannedEndTime, status: 'HELD' } })]);
      const scheduleOK = results[0].status === 'fulfilled' && results[0].value.status === 201, reservationOK = results[1].status === 'fulfilled';
      assert.notEqual(scheduleOK, reservationOK);
    });
  } finally { await app.close(); }
});
