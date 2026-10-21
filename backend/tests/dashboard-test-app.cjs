require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaModule } = require('../dist/src/prisma/prisma.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthModule } = require('../dist/src/auth/auth.module');
const { EventsModule } = require('../dist/src/events/events.module');
const { EventsGateway } = require('../dist/src/events/events.gateway');
const { DashboardModule } = require('../dist/src/dashboard/dashboard.module');
const { MonitoringModule } = require('../dist/src/trip-monitoring/monitoring.module');
const { FleetModule } = require('../dist/src/fleet/fleet.module');
const { OrdersModule } = require('../dist/src/orders/orders.module');
const { BranchesModule } = require('../dist/src/branches/branches.module');
const { seedAuth } = require('../dist/prisma/seed-auth');
const { randomUUID } = require('node:crypto');

async function dashboardApp(port = 0, browser = false) {
  const target = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(target.hostname) || target.pathname !== '/tms_dashboard_test') throw new Error('Isolated dashboard DB required');
  class TestModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, EventsModule, DashboardModule, MonitoringModule, FleetModule, OrdersModule, BranchesModule] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableCors({ origin: 'http://127.0.0.1:5180' });
  const db = app.get(PrismaService); await seedAuth(db);
  const data = await fixture(db);
  if (browser) {
    // Loopback-only fixture controls; never imported by the production application.
    app.getHttpAdapter().get('/__test/profile', (_req, res) => res.json({ username: data.viewer.username, otherUsername: data.other.username, multiUsername: data.multi.username, a: data.a.id, b: data.b.id, trip: data.trips[2].id, candidate: data.orders[0].orderNumber }));
    app.getHttpAdapter().post('/__test/notify', async (_req, res) => {
      const trip = await db.trip.update({ where: { id: data.trips[2].id }, data: { status: 'DISPATCHED', version: { increment: 1 } } });
      const gateway = app.get(EventsGateway);
      await gateway.emitTripUpdate(trip); await gateway.emitTripUpdate(trip);
      gateway.server.to('branch:' + data.a.id).emit('trip:updated', { id: trip.id, version: 1 });
      res.json({ ok: true });
    });
    app.getHttpAdapter().post('/__test/revoke', async (_req, res) => {
      await db.userRoleScope.updateMany({ where: { userId: data.viewer.id }, data: { active: false } });
      await app.get(EventsGateway).emitTripUpdate(data.trips[2]);
      res.json({ ok: true });
    });
  }
  await app.init();
  await app.listen(port, '127.0.0.1'); return { app, db, data };
}
async function fixture(db) {
  const suffix = randomUUID(), password = await require('bcryptjs').hash(process.env.AUTH_DEMO_PASSWORD, 12);
  const role = await db.accessRole.findUniqueOrThrow({ where: { code: 'DISPATCHER' } });
  // Read-only across all TMS lists; no planning/publish rights.
  const permissions = await db.permission.findMany({ where: { code: { in: ['orders.read','trips.read','vehicles.read','drivers.read','branches.read'] } } });
  await db.rolePermission.deleteMany({ where: { roleId: role.id } });
  await db.rolePermission.createMany({ data: permissions.map(p => ({ roleId: role.id, permissionId: p.id })) });
  const branch = async letter => db.branch.create({ data: { code: 'DASH-' + letter + '-' + suffix, name: '[DASH TEST] ' + letter + ' ' + suffix, address: 'Fixture only', latitude: 21, longitude: 105 } });
  const a = await branch('A'), b = await branch('B');
  const account = async (name, branches) => {
    const u = await db.user.create({ data: { username: 'dash_' + name + '_' + suffix, password, fullName: '[DASH TEST] ' + name, role: 'DISPATCHER', branchId: branches[0]?.id } });
    await db.userRoleScope.createMany({ data: branches.map(branch => ({ userId: u.id, roleId: role.id, scopeType: 'BRANCH', branchId: branch.id })) });
    return u;
  };
  const viewer = await account('viewer', [a]), other = await account('other', [b]), multi = await account('multi', [a,b]), noScope = await account('none', []);
  const type = await db.vehicleType.findUniqueOrThrow({ where: { code: 'DEMO-AUTH' } });
  const vehicle = await db.vehicle.create({ data: { plateNumber: 'DASH-A-' + suffix, model: '[TEST]', homeBranchId: a.id, vehicleTypeId: type.id } });
  const vehicleB = await db.vehicle.create({ data: { plateNumber: 'DASH-B-' + suffix, model: '[TEST]', homeBranchId: b.id, vehicleTypeId: type.id } });
  const driverData = { phone: '0000000000', licenseClass: 'C', licenseExpiry: new Date('2000-01-01'), homeBranchId: a.id };
  const driver = await db.driver.create({ data: { ...driverData, fullName: '[DASH TEST] Expired', citizenId: suffix, licenseNumber: suffix } });
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0,10);
  const validDriver = await db.driver.create({ data: { ...driverData, fullName: '[DASH TEST] Valid today', citizenId: suffix + '-2', licenseNumber: suffix + '-2', licenseExpiry: new Date(today) } });
  for (let i = 0; i < 2; i++) await db.vehicleUnavailability.create({ data: { vehicleId: vehicle.id, startsAt: new Date('2020-01-01'), reason: '[TEST] Breakdown ' + i, kind: 'BREAKDOWN' } });
  const customer = await db.customer.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-CUSTOMER-A' } });
  await db.customerBranch.createMany({ data: [a,b].map(branch => ({ customerId: customer.id, branchId: branch.id })) });
  const orders = [];
  for (const [index, status, packageDataStatus, branch] of [
    [0,'CONFIRMED','COMPLETE',a], [1,'CONFIRMED','COMPLETE',a], [2,'DRAFT','COMPLETE',a],
    [3,'CONFIRMED','LEGACY_REVIEW',a], [4,'ASSIGNED','COMPLETE',a], [5,'CONFIRMED','COMPLETE',b],
    [6,'CONFIRMED','COMPLETE',a],
  ]) {
    orders.push(await db.order.create({ data: {
      orderNumber: 'DASH-ORDER-' + index + '-' + suffix, customerId: customer.id, branchId: branch.id, status, packageDataStatus,
      createdAt: new Date('2019-01-01'), stops: { create: ['PICKUP','DELIVERY'].map((type,i) => ({ type, sequence: i+1, address: '[TEST]', latitude: 21, longitude: 105, contactName: '[TEST]', contactPhone: '0000000000', windowBasis: 'SERVICE_START', windowStart: new Date('2031-01-01T17:00:00Z'), windowEnd: new Date('2031-01-02T17:00:00Z') })) },
      items: { create: { description: '[TEST]', quantity: 2, weightKg: 2, volumeM3: 0.002, packages: { create: [0,1].map(j => ({ packageCode: `DASH-${suffix}-${index}-${j}`, lengthMm: 100, widthMm: 100, heightMm: 100, weightG: 1000, measurementSource: 'TEST', status: 'READY' })) } } },
    }, include: { items: { include: { packages: true } } } }));
  }
  const trips = [];
  for (const [index, status, start, end, branch, v] of [
    [0,'PLANNED',null,null,a,vehicle], [1,'DISPATCHED',null,null,a,vehicle],
    [2,'IN_PROGRESS','2031-01-01T17:00:00Z',null,a,vehicle],
    [3,'COMPLETED','2031-01-01T18:00:00Z','2031-01-02T16:59:59.999Z',a,vehicle],
    [4,'COMPLETED','2031-01-02T17:00:00Z','2031-01-02T17:00:00Z',a,vehicle],
    [5,'COMPLETED',null,null,a,vehicle],
    [6,'IN_PROGRESS','2031-01-01T17:00:00Z',null,b,vehicleB],
    [7,'CANCELLED',null,null,a,vehicle],
  ]) trips.push(await db.trip.create({ data: { tripNumber: `DASH-TRIP-${index}-${suffix}`, managingBranchId: branch.id, vehicleId: v.id, status, plannedStartTime: new Date('2031-01-01T01:00:00Z'), plannedEndTime: new Date('2031-01-03T01:00:00Z'), actualStartTime: start ? new Date(start) : null, actualEndTime: end ? new Date(end) : null } }));
  // Two assignments on one trip and a split order on two trips must not multiply totals.
  for (const d of [driver,validDriver]) await db.driverAssignment.create({ data: { tripId: trips[2].id, driverId: d.id, startTime: trips[2].plannedStartTime, endTime: trips[2].plannedEndTime } });
  for (let i = 0; i < 2; i++) {
    const item = orders[4].items[0], pkg = item.packages[i], t = trips[i];
    await db.allocation.create({ data: { tripId: t.id, orderItemId: item.id, packageId: pkg.id, allocatedQuantity: 1 } });
  }
  // A CONFIRMED order with package-only task history is not a new candidate.
  const stop = await db.tripStop.create({ data: { tripId: trips[0].id, sequence: 1, stopType: 'PICKUP', address: '[TEST]', latitude: 21, longitude: 105 } });
  const historyTask = await db.stopTask.create({ data: { tripStopId: stop.id, packageId: orders[6].items[0].packages[0].id, orderId: orders[6].id, action: 'LOAD', plannedQuantity: 1 } });
  return { a,b,viewer,other,multi,noScope,vehicle,driver,validDriver,orders,trips,historyTask };
}
module.exports = { dashboardApp };
if (require.main === module) dashboardApp(4020, true).then(() => console.log('Dashboard isolated fixtures ready.')).catch(e => { console.error(e.message); process.exitCode = 1; });
