require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaModule } = require('../dist/src/prisma/prisma.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { AuthModule } = require('../dist/src/auth/auth.module');
const { FleetModule } = require('../dist/src/fleet/fleet.module');
const { VehiclesModule } = require('../dist/src/vehicles/vehicles.module');
const { DriversModule } = require('../dist/src/drivers/drivers.module');
const { BranchesModule } = require('../dist/src/branches/branches.module');
const { LocationsModule } = require('../dist/src/locations/locations.module');
const { seedAuth } = require('../dist/prisma/seed-auth');
const { randomUUID } = require('node:crypto');
async function start() {
  const target = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(target.hostname) || target.pathname !== '/tms_fleet_test') throw new Error('Isolated fleet test DB required');
  process.env.JWT_SECRET = 'isolated-fleet-test-secret-at-least-32-characters';
  process.env.AUTH_DEMO_PASSWORD = 'Fleet-test-only-2026!';
  class FleetTestModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, FleetModule, VehiclesModule, DriversModule, BranchesModule, LocationsModule] })(FleetTestModule);
  const app = await NestFactory.create(FleetTestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableCors({ origin: 'http://127.0.0.1:5177' }); await app.init();
  const db = app.get(PrismaService); await seedAuth(db);
  const b = await db.branch.findUniqueOrThrow({ where: { code: 'DEMO-AUTH-A' } });
  await db.employee.create({ data: { employeeCode: 'UI-' + randomUUID(), fullName: 'Fleet UI Employee ' + Date.now(), phone: '111', citizenId: randomUUID(), branchId: b.id, joinedOn: new Date('2026-01-01') } });
  await db.vehicleType.upsert({ where: { code: 'FLEET-UI-TYPE' }, update: {}, create: { code: 'FLEET-UI-TYPE', name: 'Fleet UI Type', payloadCapacityKg: 1000, volumeCapacityM3: 8, lengthCm: 200, widthCm: 200, heightCm: 200 } });
  await app.listen(4017, '127.0.0.1');
}
start().catch(e => { console.error(e.name); process.exitCode = 1; });
