const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { flowTestApp } = require('./flow-test-app.cjs');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { MapboxService } = require('../dist/src/mapbox/mapbox.service');

test('manual flow: HTTP + PostgreSQL + FastAPI spatial validator; road responses are fixtures', { timeout: 120000 }, async t => {
  const app = await flowTestApp(), db = app.get(PrismaService), map = app.get(MapboxService), base = await app.getUrl();
  // Explicit synthetic road fixture. No replacement of auth, persistence, spatial validator or transactions.
  map.getRoute = async () => ({ distanceKm: 2, durationMinutes: 2, geometry: null, waypoints: [] });
  map.getRoadMatrix = async coordinates => ({ durationsSeconds: coordinates.map((_, i) => coordinates.map((_, j) => i === j ? 0 : 60)), distancesMeters: coordinates.map((_, i) => coordinates.map((_, j) => i === j ? 0 : 1000)) });
  const request = async (path, token, method = 'GET', body, key = randomUUID()) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const expectStatus = (r, status) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  const suffix = randomUUID(), begin = new Date();
  try {
    const login = async username => expectStatus(await request('/auth/login', null, 'POST', { username, password: process.env.AUTH_DEMO_PASSWORD }), 201).accessToken;
    const admin = await login('demo_auth_admin'), planner = await login('demo_auth_a'), foreign = await login('demo_auth_b');
    assert.ok(admin && planner && foreign);
    const branch = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const customer = expectStatus(await request('/customers', admin, 'POST', { name: '[TEST FLOW] ' + suffix, phone: '000', branchIds: [branch.id] }), 201);
    const vt = await db.vehicleType.create({ data: { code: 'FLOW-' + suffix, name: '[TEST FLOW]', payloadCapacityKg: 1000, volumeCapacityM3: 12, lengthCm: 300, widthCm: 200, heightCm: 200 } });
    const depot = await db.location.create({ data: { code: 'FLOW-' + suffix, name: '[TEST FLOW] depot', type: 'CENTRAL_WAREHOUSE', managingBranchId: branch.id, address: '[TEST]', latitude: 21.03, longitude: 105.85 } });
    const employee = await db.employee.create({ data: { employeeCode: 'FLOW-' + suffix, fullName: '[TEST FLOW] driver', phone: '000', citizenId: suffix, joinedOn: new Date('2030-01-01'), branchId: branch.id } });
    const vehicle = expectStatus(await request('/fleet/vehicles', admin, 'POST', { plateNumber: 'T-' + suffix.slice(0, 20), model: '[TEST FLOW]', vehicleTypeId: vt.id, homeBranchId: branch.id, homeDepotLocationId: depot.id }), 201);
    const driver = expectStatus(await request('/fleet/drivers', admin, 'POST', { employeeId: employee.id, employeeVersion: employee.version, licenseNumber: suffix, licenseClass: 'C', licenseExpiry: '2035-01-01' }), 201);
    const schedule = { kind: 'SHIFT', startsAt: '2031-01-01T15:00:00Z', endsAt: '2031-01-01T22:00:00Z', reason: '[TEST FLOW] overnight', readyAt: '2031-01-01T15:00:00Z', readyAddress: '[TEST FLOW] separate driver location', readyLatitude: 21.02, readyLongitude: 105.84 };
    await t.test('readiness is validated, persisted and visible independently of vehicle depot', async () => {
      expectStatus(await request(`/fleet/drivers/${driver.id}/schedules`, admin, 'POST', { ...schedule, readyAt: schedule.endsAt }), 400);
      expectStatus(await request(`/fleet/drivers/${driver.id}/schedules`, admin, 'POST', schedule), 201);
      const read = expectStatus(await request(`/fleet/drivers/${driver.id}/schedules?startsAt=${schedule.startsAt}&endsAt=${schedule.endsAt}`, planner), 200);
      assert.equal(read.items[0].readyLatitude, 21.02); assert.equal(read.items[0].readyAt, '2031-01-01T15:00:00.000Z');
      expectStatus(await request(`/fleet/drivers/${driver.id}/schedules?startsAt=${schedule.startsAt}&endsAt=${schedule.endsAt}`, foreign), 404);
    });
    let order = expectStatus(await request('/orders', planner, 'POST', { branchId: branch.id, customerId: customer.id,
      stops: ['PICKUP', 'DELIVERY'].map((type, i) => ({ type, address: '[TEST FLOW] ' + type, latitude: 21.03 + i / 100, longitude: 105.85, contactName: 'Fixture', contactPhone: '000', windowStart: '2031-01-01T16:00:00Z', windowEnd: '2031-01-01T21:00:00Z', serviceDurationMinutes: 1 })),
      items: [{ description: '[TEST FLOW] different packages', packageType: 'CARTON', packages: [{ lengthMm: 400, widthMm: 300, heightMm: 200, weightG: '10001' }, { lengthMm: 500, widthMm: 300, heightMm: 250, weightG: '20002' }] }],
    }), 201);
    await t.test('customer → packages → confirm → exact persistent totals and branch scope', async () => {
      assert.equal(order.totalWeightG, '30003'); assert.equal(order.totalPackages, 2);
      assert.equal(new Set(order.items[0].packages.map(p => p.id)).size, 2);
      order = expectStatus(await request(`/orders/${order.id}/confirm`, planner, 'POST', { version: order.version }), 201);
      assert.equal(expectStatus(await request(`/orders/${order.id}`, planner), 200).totalWeightG, '30003');
      expectStatus(await request(`/orders/${order.id}`, foreign), 404);
      assert.ok(expectStatus(await request('/orders/available-for-dispatch', planner), 200).some(o => o.id === order.id));
    });
    const endpoint = { address: '[TEST FLOW] depot', latitude: depot.latitude, longitude: depot.longitude };
    const input = { branchId: branch.id, idempotencyKey: randomUUID(), vehicleId: vehicle.id, driverId: driver.id, orderIds: [order.id], plannedStartTime: '2031-01-01T16:00:00Z', plannedEndTime: '2031-01-01T20:00:00Z', startLocation: endpoint, endLocation: endpoint };
    await t.test('cannot depart before driver can reach the vehicle', async () => {
      expectStatus(await request('/trips', planner, 'POST', { ...input, idempotencyKey: randomUUID(), plannedStartTime: schedule.readyAt }), 409);
      assert.equal(await db.allocation.count({ where: { packageId: { in: order.items[0].packages.map(p => p.id) } } }), 0);
    });
    const trip = expectStatus(await request('/trips', planner, 'POST', input), 201);
    await t.test('manual save/retry → persisted spatial plan → publish/version → reload', async () => {
      assert.equal(expectStatus(await request('/trips', planner, 'POST', input), 201).id, trip.id);
      const load = expectStatus(await request(`/trips/${trip.id}/load-plan`, planner), 200);
      assert.equal(load.validationStatus, 'VALID'); assert.equal(load.steps.length, 2);
      assert.equal(load.steps.flatMap(s => s.tasks).length, 4);
      expectStatus(await request(`/trips/${trip.id}/publish`, planner, 'PATCH', { expectedVersion: trip.version - 1 }), 409);
      expectStatus(await request(`/trips/${trip.id}/publish`, planner, 'PATCH', { expectedVersion: trip.version }), 200);
      const read = expectStatus(await request(`/trips/${trip.id}`, planner), 200);
      assert.equal(read.status, 'DISPATCHED'); assert.equal(read.version, trip.version + 1);
      assert.equal(read.actualStartTime, null); assert.equal(read.planningSnapshot.driverArrival.readyLatitude, 21.02);
      assert.equal(await db.resourceReservation.count({ where: { tripId: trip.id, status: 'ACTIVE' } }), 2);
      assert.equal(await db.outboxEvent.count({ where: { aggregateId: trip.id, eventType: 'TRIP_PUBLISHED' } }), 1);
      expectStatus(await request(`/trips/${trip.id}`, foreign), 404);
      assert.ok(!expectStatus(await request('/orders/available-for-dispatch', planner), 200).some(o => o.id === order.id));
    });
    await t.test('dashboard and audit reconcile the committed trip', async () => {
      const dashboard = expectStatus(await request('/dashboard/summary?from=2031-01-01T00:00:00Z&to=2031-01-03T00:00:00Z&branchId=' + branch.id, planner), 200);
      assert.equal(dashboard.metrics.dispatchedTrips, await db.trip.count({ where: { managingBranchId: branch.id, status: 'DISPATCHED' } }));
      const audit = expectStatus(await request('/audit-logs?' + new URLSearchParams({ from: begin.toISOString(), to: new Date(Date.now() + 1000).toISOString(), entityType: 'Trip', entityId: trip.id }), admin), 200);
      assert.ok(audit.items.some(item => item.action === 'TRIP_PUBLISHED'), JSON.stringify(audit));
      console.log('TEST FLOW persisted trip:', trip.id);
    });
  } finally { await app.close(); }
});
