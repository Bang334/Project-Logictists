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
async function customerTestApp(port = 0) {
  const url = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.startsWith('/tms_customers_')) throw new Error('Refusing non-test DB');
  class CustomerTestModule {}
  Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, CustomersModule, OrdersModule, BranchesModule] })(CustomerTestModule);
  const app = await NestFactory.create(CustomerTestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true, exceptionFactory: validationException }));
  app.useGlobalInterceptors(new BigIntSerializationInterceptor());
  app.enableCors({ origin: 'http://127.0.0.1:5176' });
  await app.init();
  await seedAuth(app.get(PrismaService));
  await app.listen(port, '127.0.0.1');
  return app;
}
module.exports = { customerTestApp };
if (require.main === module) customerTestApp(4016).then(() => console.log('Customer test API listening on 127.0.0.1:4016')).catch(() => { console.error('Customer test server failed'); process.exitCode = 1; });
