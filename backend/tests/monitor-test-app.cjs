require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaModule } = require('../dist/src/prisma/prisma.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthModule } = require('../dist/src/auth/auth.module');
const { EventsModule } = require('../dist/src/events/events.module');
const { MonitoringModule } = require('../dist/src/trip-monitoring/monitoring.module');
const { StorageService } = require('../dist/src/common/services/storage.service');
const { seedAuth } = require('../dist/prisma/seed-auth');
const { randomUUID } = require('node:crypto');
const { EventsGateway } = require('../dist/src/events/events.gateway');
async function monitorApp(port = 0, withBrowserFixtures = false) {
  const target = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(target.hostname) || target.pathname !== '/tms_monitor_test') throw new Error('Isolated monitor DB required');
  class TestModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, EventsModule, MonitoringModule] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableCors({ origin: 'http://127.0.0.1:5179' });
  const db = app.get(PrismaService); await seedAuth(db);
  // Dedicated read-only role permissions in isolated DB, preserving admin permissions.
  const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
  const read = await db.permission.findUniqueOrThrow({ where: { code: 'trips.read' } });
  await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { not: read.id } } });
  if (withBrowserFixtures) {
    const branch = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
    const username = 'monitor_browser_' + randomUUID();
    const password = await require('bcryptjs').hash(process.env.AUTH_DEMO_PASSWORD, 12);
    const account = await db.user.create({ data: { username, password, role: 'DISPATCHER', fullName: '[TEST] Monitor viewer', branchId: branch.id } });
    await db.userRoleScope.create({ data: { userId: account.id, roleId: role.id, scopeType: 'BRANCH', branchId: branch.id } });
    app.getHttpAdapter().get('/__test/profile', (_req, res) => res.json({ username }));
    app.getHttpAdapter().post('/__test/revoke-viewer', async (_req, res) => {
      await db.userRoleScope.updateMany({ where: { userId: account.id }, data: { active: false } });
      const trips = await db.trip.findMany({ where: { managingBranchId: branch.id, tripNumber: { startsWith: 'MONITOR-FIXTURE-BROWSER-' } }, select: { id: true }, take: 1 });
      if (trips[0]) await app.get(EventsGateway).emitTripUpdate(trips[0]);
      res.json({ revoked: true });
    });
  }
  // Test-only control: loopback isolated DB, never imported into the production app.
  // Register through Express after guards have initialized; only fixture trip IDs are accepted.
  app.getHttpAdapter().post('/__test/notify/:id', async (req, res) => {
    const found = await db.trip.findUnique({ where: { id: req.params.id } });
    if (!found?.tripNumber.startsWith('MONITOR-FIXTURE-')) return res.status(404).end();
    const updated = await db.trip.update({ where: { id: found.id }, data: { version: { increment: 1 } } });
    const gateway = app.get(EventsGateway);
    await gateway.emitTripUpdate({ id: updated.id });
    await gateway.emitTripUpdate({ id: updated.id });
    // Deliberately duplicated and old invalidation; it must never replace HTTP state.
    gateway.server.to('branch:' + updated.managingBranchId).emit('trip:updated', { id: updated.id, version: 1 });
    res.json({ version: updated.version });
  });
  await app.init();
  if (withBrowserFixtures) {
    await fixture(app, 'BROWSER-A-' + randomUUID());
    await fixture(app, 'BROWSER-B-' + randomUUID());
  }
  await app.listen(port, '127.0.0.1'); return app;
}
async function fixture(app, suffix = randomUUID()) {
  const db = app.get(PrismaService), storage = app.get(StorageService);
  const a = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
  const vehicle = await db.vehicle.findUniqueOrThrow({ where: { plateNumber: 'DEMO-AUTH-A' } });
  const driver = await db.driver.findUniqueOrThrow({ where: { citizenId: 'DEMO-AUTH-A' } });
  const actor = await db.user.findUniqueOrThrow({ where: { username: 'demo_auth_a' } });
  const order = await db.order.findUniqueOrThrow({ where: { orderNumber: 'DEMO-AUTH-ORDER-A' }, include: { items: true } });
  const trip = await db.trip.create({ data: { tripNumber: 'MONITOR-FIXTURE-' + suffix, managingBranchId: a.id, vehicleId: vehicle.id, status: 'IN_PROGRESS', plannedStartTime: new Date('2031-01-01T01:00:00Z'), plannedEndTime: new Date('2031-01-02T01:00:00Z'), actualStartTime: new Date('2031-01-01T00:30:00Z'), version: 8 } });
  const assignment = await db.driverAssignment.create({ data: { tripId: trip.id, driverId: driver.id, startTime: trip.plannedStartTime, endTime: trip.plannedEndTime, status: 'ACCEPTED', respondedAt: new Date('2031-01-01T00:00:00Z') } });
  const pickup = await db.tripStop.create({ data: { tripId: trip.id, sequence: 1, stopType: 'PICKUP', address: '[FIXTURE] Pickup', latitude: 21, longitude: 105, status: 'COMPLETED' } });
  const stop = await db.tripStop.create({ data: { tripId: trip.id, sequence: 2, stopType: 'DELIVERY', address: '[FIXTURE] Delivery', latitude: 21.1, longitude: 105, status: 'ARRIVED', actualArrivalTime: new Date('2031-01-01T02:00:00Z') } });
  const snapshot = await db.tripExecutionSnapshot.create({ data: { tripId: trip.id, sourceTripVersion: 2, planHash: 'fixture-only', plan: { fixture: true } } });
  const command = async () => db.processedCommand.create({ data: { actorUserId: actor.id, commandType: 'MONITOR_FIXTURE', idempotencyKey: randomUUID(), requestHash: 'fixture', result: {}, status: 'COMPLETED' } });
  const event = async (type, task) => { const cmd = await command(); return db.executionEvent.create({ data: { tripId: trip.id, tripStopId: task.tripStopId, stopTaskId: task.id, eventType: type, occurredAt: new Date('2031-01-01T02:01:00Z'), receivedAt: new Date('2031-01-01T02:02:00Z'), actorUserId: actor.id, commandId: cmd.id, sourceSnapshotId: snapshot.id } }); };
  const packages = [], tasks = [], results = [];
  for (let i = 0; i < 5; i++) {
    const pkg = await db.package.create({ data: { packageCode: 'MONITOR-' + suffix + '-' + i, orderItemId: order.items[0].id, lengthMm: 100, widthMm: 100, heightMm: 100, weightG: 100, measurementSource: 'TEST', status: 'LOADED' } }); packages.push(pkg);
    const allocation = await db.allocation.create({ data: { tripId: trip.id, orderItemId: order.items[0].id, packageId: pkg.id, allocatedQuantity: 1 } });
    const load = await db.stopTask.create({ data: { tripStopId: pickup.id, allocationId: allocation.id, packageId: pkg.id, action: 'LOAD', plannedQuantity: 1, actualQuantity: i === 1 ? 0 : 1 } });
    const task = await db.stopTask.create({ data: { tripStopId: stop.id, allocationId: allocation.id, packageId: pkg.id, action: 'UNLOAD', plannedQuantity: 1, actualQuantity: i === 0 ? 1 : null } }); tasks.push(task);
    const loaded = await event(i === 1 ? 'PICKUP_NOT_COLLECTED' : 'PACKAGE_LOADED', load);
    const pr = await db.pickupResult.create({ data: { stopTaskId: load.id, eventId: loaded.id, packageId: pkg.id, allocationId: allocation.id, outcome: i === 1 ? 'NOT_COLLECTED' : 'LOADED', reason: i === 1 ? 'Sender not ready' : null } });
    if (i !== 1) { const state = ['DELIVERED', null, 'UNLOADED', 'ON_VEHICLE', 'FAILED'][i]; const last = await event(i === 3 ? 'PACKAGE_RELOADED' : 'PACKAGE_' + state, task); await db.driverDeliveryState.create({ data: { stopTaskId: task.id, pickupResultId: pr.id, lastEventId: last.id, state } }); }
    if (i < 2 || i === 4) {
      for (const result of i === 0 ? ['FAILED','DELIVERED'] : [i === 1 ? 'NOT_COLLECTED' : 'FAILED']) {
        const cmd = await command();
        const attempt = await db.deliveryAttempt.create({ data: { tripStopId: stop.id, attemptNumber: results.length + 1, occurredAt: new Date('2031-01-01T02:03:00Z'), recipientName: result === 'DELIVERED' ? '[FIXTURE] Recipient' : null, result, commandId: cmd.id, sourceSnapshotId: snapshot.id } });
        await db.deliveryResult.create({ data: { deliveryAttemptId: attempt.id, stopTaskId: task.id, packageId: pkg.id, result, reason: result !== 'DELIVERED' ? 'Fixture reason' : null } }); results.push(attempt);
      }
    }
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');
  const file = await storage.uploadFile(png, 'fixture.png', 'image/png', 'pod');
  const pod = await db.podFile.create({ data: { deliveryAttemptId: results[1].id, ownerUserId: actor.id, assignmentId: assignment.id, tripStopId: stop.id, sourceSnapshotId: snapshot.id, storageKey: file.fileKey, checksum: file.checksum, mediaType: file.mimeType, sizeBytes: file.sizeBytes, uploadStatus: 'UPLOADED', uploadedAt: new Date() } });
  return { trip, stop, pickup, tasks, packages, pod, assignment, snapshot, a, vehicle, driver, actor };
}
module.exports = { monitorApp, fixture };
if (require.main === module) monitorApp(4019, true).then(() => console.log('Monitor browser fixtures ready.')).catch(e => { console.error(e.message); process.exitCode = 1; });
