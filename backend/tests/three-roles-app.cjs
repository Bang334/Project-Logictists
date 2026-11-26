// Isolated HTTP/PostgreSQL fixture for the Person 2 authorization slice.
require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaClient } = require('@prisma/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const bcrypt = require('bcryptjs');
const { migrationStatements } = require('../scripts/sql-migration-statements.cjs');
const { PrismaModule } = require('../dist/src/prisma/prisma.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthModule } = require('../dist/src/auth/auth.module');
const { UsersModule } = require('../dist/src/users/users.module');
const { EventsModule } = require('../dist/src/events/events.module');
const { FleetModule } = require('../dist/src/fleet/fleet.module');
const { VehiclesModule } = require('../dist/src/vehicles/vehicles.module');
const { DriversModule } = require('../dist/src/drivers/drivers.module');
const { BranchesModule } = require('../dist/src/branches/branches.module');
const { CustomersModule } = require('../dist/src/customers/customers.module');
const { LocationsModule } = require('../dist/src/locations/locations.module');
const { OrdersModule } = require('../dist/src/orders/orders.module');
const { MonitoringModule } = require('../dist/src/trip-monitoring/monitoring.module');
const { DashboardModule } = require('../dist/src/dashboard/dashboard.module');
const { BigIntSerializationInterceptor } = require('../dist/src/common/interceptors/bigint-serialization.interceptor');

const testUrl = 'postgresql://tms_test:isolated_roles_test_only@127.0.0.1:55432/tms_roles_test';
const password = 'Roles-test-only-2026!';
function configure() {
  const target = new URL(process.env.DATABASE_URL || testUrl);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== '55432' || target.pathname !== '/tms_roles_test') throw new Error('Only isolated localhost:55432/tms_roles_test is allowed');
  Object.assign(process.env, { DATABASE_URL: target.toString(), DIRECT_URL: target.toString(),
    JWT_SECRET: 'isolated-three-roles-secret-at-least-32-characters', CORS_ORIGIN: 'http://127.0.0.1:5182',
    REDIS_URL: 'redis://127.0.0.1:56379', MAPBOX_ACCESS_TOKEN: '',
    CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '', OUTBOX_WORKER_ENABLED: 'false',
    AUTH_LOGIN_MAX_ATTEMPTS: '100', AUTH_LOGIN_IP_MAX_ATTEMPTS: '1000', AUTH_LOGIN_WINDOW_SECONDS: '60' });
}
async function executeSql(db, sql) {
  await db.$transaction(async tx => {
    for (const statement of migrationStatements(sql)) {
      if (!/^(BEGIN|COMMIT);?$/i.test(statement)) await tx.$executeRawUnsafe(statement);
    }
  }, { timeout: 30000 });
}
function roleMigration() { return readFileSync(join(__dirname, '../prisma/migrations/20261122100000_three_branch_roles/migration.sql'), 'utf8'); }
async function fixtures(db) {
  const branches = [];
  for (const code of ['ROLE-A', 'ROLE-B']) branches.push(await db.branch.upsert({ where: { code }, update: {}, create: { code, name: 'Chi nhánh ' + code, address: 'Test', latitude: 10, longitude: 106 } }));
  const roles = {};
  for (const code of ['ADMIN', 'DRIVER', 'BRANCH_DISPATCH_LEAD', 'RESOURCE_MANAGER', 'TRANSPORT_DISPATCHER', 'ORDER_SCHEDULER']) roles[code] = await db.accessRole.upsert({ where: { code }, update: { active: true }, create: { code, name: code } });
  const hash = await bcrypt.hash(password, 4);
  const users = {};
  for (const [key, role, branch] of [['admin','ADMIN',null], ['lead','BRANCH_DISPATCH_LEAD',branches[0]], ['resource','RESOURCE_MANAGER',branches[0]], ['transport','TRANSPORT_DISPATCHER',branches[0]], ['legacy','ORDER_SCHEDULER',branches[0]], ['other','TRANSPORT_DISPATCHER',branches[1]]]) {
    users[key] = await db.user.upsert({ where: { username: 'roles_test_' + key }, update: { active: true, password: hash, role: key === 'admin' ? 'ADMIN' : key === 'legacy' ? 'STAFF' : 'DISPATCHER' }, create: { username: 'roles_test_' + key, fullName: key, password: hash, role: key === 'admin' ? 'ADMIN' : key === 'legacy' ? 'STAFF' : 'DISPATCHER' } });
    // Reset only this isolated suite's named fixture scopes between runs.
    await db.userRoleScope.updateMany({ where: { userId: users[key].id }, data: { active: false } });
    const existing = await db.userRoleScope.findFirst({ where: { userId: users[key].id, roleId: roles[role].id, scopeType: branch ? 'BRANCH' : 'COMPANY', branchId: branch?.id ?? null } });
    if (existing) await db.userRoleScope.update({ where: { id: existing.id }, data: { active: true } });
    else await db.userRoleScope.create({ data: { userId: users[key].id, roleId: roles[role].id, scopeType: branch ? 'BRANCH' : 'COMPANY', branchId: branch?.id } });
  }
  const { PERMISSIONS } = require('../dist/src/auth/access');
  for (const code of PERMISSIONS) {
    const permission = await db.permission.upsert({ where: { code }, update: {}, create: { code, description: code } });
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: roles.ADMIN.id, permissionId: permission.id } }, update: {}, create: { roleId: roles.ADMIN.id, permissionId: permission.id } });
  }
  const type = await db.vehicleType.upsert({ where: { code: 'ROLE-TYPE' }, update: {}, create: { code: 'ROLE-TYPE', name: 'Role test truck', lengthCm: 300, widthCm: 200, heightCm: 200, payloadCapacityKg: 1000, volumeCapacityM3: 12 } });
  const vehicles = [], drivers = [], customers = [], orders = [], trips = [], locations = [];
  for (const [i, branch] of branches.entries()) {
    locations.push(await db.location.upsert({ where: { code: 'ROLE-LOCATION-' + i }, update: {}, create: { code: 'ROLE-LOCATION-' + i, name: 'Role location ' + i, type: 'CENTRAL_WAREHOUSE', managingBranchId: branch.id, address: 'Test', latitude: 10, longitude: 106 } }));
    const employee = await db.employee.upsert({ where: { employeeCode: 'ROLE-EMP-' + i }, update: {}, create: { employeeCode: 'ROLE-EMP-' + i, branchId: branch.id, fullName: 'Driver ' + i, citizenId: 'ROLE-EMP-CIT-' + i, phone: '000', joinedOn: new Date('2026-01-01') } });
    const vehicle = await db.vehicle.upsert({ where: { plateNumber: 'ROLE-VEH-' + i }, update: {}, create: { plateNumber: 'ROLE-VEH-' + i, model: 'Test', vehicleTypeId: type.id, homeBranchId: branch.id } }); vehicles.push(vehicle);
    const driver = await db.driver.upsert({ where: { citizenId: 'ROLE-CIT-' + i }, update: {}, create: { fullName: 'Driver ' + i, citizenId: 'ROLE-CIT-' + i, phone: '000', licenseNumber: 'ROLE-LIC-' + i, licenseClass: 'C', licenseExpiry: new Date('2035-12-31'), homeBranchId: branch.id, employeeId: employee.id } }); drivers.push(driver);
    const customer = await db.customer.upsert({ where: { code: 'ROLE-CUSTOMER-' + i }, update: {}, create: { code: 'ROLE-CUSTOMER-' + i, name: 'Customer ' + i, phone: '000', branches: { create: { branchId: branch.id } } } }); customers.push(customer);
    const order = await db.order.upsert({ where: { orderNumber: 'ROLE-ORDER-' + i }, update: { status: 'DRAFT', version: 1 }, create: { orderNumber: 'ROLE-ORDER-' + i, customerId: customer.id, branchId: branch.id, packageDataStatus: 'COMPLETE', status: 'DRAFT', orderType: 'B2B_TRANSPORT', items: { create: { description: 'Test cargo', packageType: 'CARTON', quantity: 1, weightKg: 1, volumeM3: 0.001, packages: { create: { packageCode: 'ROLE-PKG-' + i, lengthMm: 100, widthMm: 100, heightMm: 100, weightG: 1000n, measurementSource: 'USER_DECLARED' } } } }, stops: { create: ['PICKUP','DELIVERY'].map((type, index) => ({ type, sequence: index + 1, address: 'Test', latitude: 10, longitude: 106, contactName: 'Test', contactPhone: '000' })) } } }); orders.push(order);
    await db.package.updateMany({ where: { orderItem: { orderId: order.id } }, data: { status: 'DRAFT' } });
    const trip = await db.trip.upsert({ where: { tripNumber: 'ROLE-TRIP-' + i }, update: {}, create: { tripNumber: 'ROLE-TRIP-' + i, vehicleId: vehicle.id, managingBranchId: branch.id, status: 'DISPATCHED', plannedStartTime: new Date('2026-12-07T01:00:00Z'), plannedEndTime: new Date('2026-12-07T03:00:00Z') } }); trips.push(trip);
  }
  await db.driverShift.deleteMany({ where: { driverId: { in: drivers.map(d => d.id) }, reason: { in: ['Role authorization test', 'Role browser shift'] } } });
  await db.vehicleUnavailability.deleteMany({ where: { vehicleId: { in: vehicles.map(v => v.id) }, reason: { in: ['Actual breakdown', 'Conflicts with dispatched trip'] } } });
  return { branches, roles, users, vehicles, drivers, customers, orders, trips, locations };
}
async function installFleetGuards(db) {
  const found = await db.$queryRaw`SELECT 1 FROM pg_proc WHERE proname = 'fleet_schedule_guard'`;
  if (found.length) return;
  // Full Prisma schema is a test snapshot. Reuse the real migration's functions/triggers.
  const sql = readFileSync(join(__dirname, '../prisma/migrations/20261017120000_fleet_schedules/migration.sql'), 'utf8');
  await executeSql(db, sql.slice(sql.indexOf('CREATE FUNCTION fleet_driver_window_ok')).replace(/COMMIT;\s*$/, ''));
  await db.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS btree_gist');
  await db.$executeRawUnsafe(`ALTER TABLE driver_shifts ADD CONSTRAINT driver_shifts_overlap EXCLUDE USING gist ("driverId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE (status='ACTIVE')`);
}
async function start(port = 0, full = false) {
  configure();
  class RolesTestModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, EventsModule, UsersModule, FleetModule, VehiclesModule, DriversModule, BranchesModule, CustomersModule, LocationsModule, OrdersModule, MonitoringModule, DashboardModule] })(RolesTestModule);
  const app = await NestFactory.create(full ? require('../dist/src/app.module').AppModule : RolesTestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.useGlobalInterceptors(new BigIntSerializationInterceptor());
  app.enableCors({ origin: 'http://127.0.0.1:5182' });
  await app.listen(port, '127.0.0.1');
  return { app, db: app.get(PrismaService), base: await app.getUrl() };
}
module.exports = { start, fixtures, configure, executeSql, roleMigration, installFleetGuards, password, PrismaClient };
if (require.main === module) (async () => {
  configure(); const db = new PrismaClient(); await fixtures(db); await executeSql(db, roleMigration()); await installFleetGuards(db); await db.$disconnect();
  await start(4022, true); console.log('Isolated three-role API ready');
})().catch(error => { console.error(error); process.exitCode = 1; });
