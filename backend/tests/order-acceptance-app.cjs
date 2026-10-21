require('reflect-metadata');
const { Module, ValidationPipe } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { PrismaModule } = require('../dist/src/prisma/prisma.module');
const { AuthModule } = require('../dist/src/auth/auth.module');
const { CustomersModule } = require('../dist/src/customers/customers.module');
const { OrdersModule } = require('../dist/src/orders/orders.module');
const { BranchesModule } = require('../dist/src/branches/branches.module');
const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { validationException } = require('../dist/src/orders/validation-errors');
const { BigIntSerializationInterceptor } = require('../dist/src/common/interceptors/bigint-serialization.interceptor');
const { seedAuth } = require('../dist/prisma/seed-auth');
const { createHmac } = require('node:crypto');
async function orderAcceptanceApp(port = 0) {
  const target = new URL(process.env.DATABASE_URL);
  if (!['localhost','127.0.0.1'].includes(target.hostname) || target.pathname !== '/tms_order_acceptance_20261018') throw new Error('Isolated order acceptance DB required');
  class OrderAcceptanceModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, CustomersModule, OrdersModule, BranchesModule] })(OrderAcceptanceModule);
  const app = await NestFactory.create(OrderAcceptanceModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true, exceptionFactory: validationException }));
  app.useGlobalInterceptors(new BigIntSerializationInterceptor());
  app.enableCors({ origin: 'http://127.0.0.1:5178' });
  await app.init(); const db = app.get(PrismaService); await seedAuth(db);
  // Only expire this suite's demo counters between runs. Production rate limits stay unchanged.
  const keys = ['account:demo_auth_a', 'account:demo_auth_b', 'account:demo_auth_admin', 'ip:127.0.0.1'].map(value => createHmac('sha256', process.env.JWT_SECRET).update(value).digest('hex'));
  await db.authLoginLimit.updateMany({ where: { key: { in: keys } }, data: { expiresAt: new Date(0) } });
  await app.listen(port, '127.0.0.1');
  return app;
}
module.exports = { orderAcceptanceApp };
if (require.main === module) orderAcceptanceApp(4018).then(() => console.log('Order acceptance API ready')).catch(() => { console.error('Order acceptance API failed'); process.exitCode = 1; });
