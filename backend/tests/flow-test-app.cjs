require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { seedAuth } = require('../dist/prisma/seed-auth');
const { createHmac } = require('node:crypto');
const modules = [
  ['prisma/prisma.module', 'PrismaModule'], ['auth/auth.module', 'AuthModule'],
  ['common/common.module', 'CommonModule'], ['events/events.module', 'EventsModule'],
  ['customers/customers.module', 'CustomersModule'], ['orders/orders.module', 'OrdersModule'],
  ['branches/branches.module', 'BranchesModule'], ['fleet/fleet.module', 'FleetModule'],
  ['vehicles/vehicles.module', 'VehiclesModule'], ['drivers/drivers.module', 'DriversModule'],
  ['trips/trips.module', 'TripsModule'], ['dashboard/dashboard.module', 'DashboardModule'],
  ['audit-logs/audit.module', 'AuditModule'], ['trip-monitoring/monitoring.module', 'MonitoringModule'],
];
async function flowTestApp(port = 0) {
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/tms_flow_test_20261105') throw new Error('Isolated flow test database required');
  class FlowModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ...modules.map(([path, name]) => require('../dist/src/' + path)[name])] })(FlowModule);
  const app = await NestFactory.create(FlowModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true,
    exceptionFactory: require('../dist/src/orders/validation-errors').validationException }));
  app.useGlobalInterceptors(new (require('../dist/src/common/interceptors/bigint-serialization.interceptor').BigIntSerializationInterceptor)());
  app.enableCors({ origin: 'http://127.0.0.1:5175' });
  await app.init();
  const db = app.get(PrismaService); await seedAuth(db);
  const keys = ['account:demo_auth_a', 'account:demo_auth_b', 'account:demo_auth_admin', 'ip:127.0.0.1'].map(v => createHmac('sha256', process.env.JWT_SECRET).update(v).digest('hex'));
  await db.authLoginLimit.updateMany({ where: { key: { in: keys } }, data: { expiresAt: new Date(0) } });
  await app.listen(port, '127.0.0.1'); return app;
}
module.exports = { flowTestApp };
if (require.main === module) flowTestApp(4015).then(() => console.log('Flow test API ready')).catch(() => { console.error('Flow test API failed'); process.exitCode = 1; });
