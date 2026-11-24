import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OrderStatus, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import request = require('supertest');
import { AuthModule } from '../../src/auth/auth.module';
import { BranchesModule } from '../../src/branches/branches.module';
import { CustomersModule } from '../../src/customers/customers.module';
import { DriversModule } from '../../src/drivers/drivers.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OptimizationJobsService } from '../../src/trips/optimization-jobs.service';
import { TripsController } from '../../src/trips/trips.controller';
import { TripsService } from '../../src/trips/trips.service';
import { VehiclesModule } from '../../src/vehicles/vehicles.module';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('M2.0 transport authorization (PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m20-${suffix}`;
  const ids = {
    branchA: '',
    branchB: '',
    orderA: '',
    orderB: '',
  };
  const tokens: Partial<Record<Role | 'DISPATCHER_NO_BRANCH', string>> = {};

  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = 'm2-authorization-integration-secret-32chars';

    const tripsService = {
      findAll: jest.fn().mockResolvedValue([]),
      getLoadProfile: jest.fn(),
      getLoadPlan: jest.fn(),
      findOneAuthorized: jest.fn(),
      create: jest.fn(),
      runOptimization: jest.fn(),
      publish: jest.fn(),
      updatePlan: jest.fn(),
    };
    const optimizationJobs = {
      create: jest.fn(),
      list: jest.fn(),
      get: jest.fn(),
      cancel: jest.fn(),
      apply: jest.fn(),
      getCandidate: jest.fn(),
      exportCandidates: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        OrdersModule,
        CustomersModule,
        BranchesModule,
        VehiclesModule,
        DriversModule,
      ],
      controllers: [TripsController],
      providers: [
        { provide: TripsService, useValue: tripsService },
        { provide: OptimizationJobsService, useValue: optimizationJobs },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);

    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `${prefix}-A`,
          name: 'M2.0 Branch A',
          address: 'Integration test A',
          latitude: 10,
          longitude: 106,
        },
      }),
      prisma.branch.create({
        data: {
          code: `${prefix}-B`,
          name: 'M2.0 Branch B',
          address: 'Integration test B',
          latitude: 11,
          longitude: 107,
        },
      }),
    ]);
    ids.branchA = branchA.id;
    ids.branchB = branchB.id;

    const userInputs = [
      { label: 'admin', role: Role.ADMIN, branchId: null },
      { label: 'dispatcher-a', role: Role.DISPATCHER, branchId: branchA.id },
      { label: 'dispatcher-b', role: Role.DISPATCHER, branchId: branchB.id },
      { label: 'dispatcher-none', role: Role.DISPATCHER, branchId: null },
      { label: 'customer', role: Role.CUSTOMER, branchId: null },
      { label: 'staff', role: Role.STAFF, branchId: branchA.id },
    ] as const;

    for (const input of userInputs) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: 'integration-test-not-a-real-credential',
          fullName: `M2.0 ${input.label}`,
          role: input.role,
          branchId: input.branchId,
        },
      });
      const key =
        input.label === 'dispatcher-none'
          ? 'DISPATCHER_NO_BRANCH'
          : input.role;
      tokens[key] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
      if (input.role === Role.CUSTOMER) {
        await prisma.customer.create({
          data: {
            code: `${prefix}-CUS`,
            userId: user.id,
            name: 'M2.0 Customer',
            phone: `09${suffix.replace(/[^0-9]/g, '').padEnd(8, '7').slice(0, 8)}`,
          },
        });
      }
    }

    const customer = await prisma.customer.findUniqueOrThrow({
      where: { code: `${prefix}-CUS` },
    });
    const [orderA, orderB] = await Promise.all([
      prisma.order.create({
        data: {
          orderNumber: `${prefix}-ORD-A`,
          customerId: customer.id,
          branchId: branchA.id,
          status: OrderStatus.DRAFT,
        },
      }),
      prisma.order.create({
        data: {
          orderNumber: `${prefix}-ORD-B`,
          customerId: customer.id,
          branchId: branchB.id,
          status: OrderStatus.DRAFT,
        },
      }),
    ]);
    ids.orderA = orderA.id;
    ids.orderB = orderB.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.order.deleteMany({
      where: { orderNumber: { startsWith: prefix } },
    });
    await prisma.customer.deleteMany({
      where: { code: { startsWith: prefix } },
    });
    await prisma.user.deleteMany({
      where: { username: { startsWith: prefix } },
    });
    await prisma.branch.deleteMany({
      where: { code: { startsWith: prefix } },
    });
    await app.close();
  });

  it('yêu cầu JWT cho API vận hành', async () => {
    await request(app.getHttpServer()).get('/orders').expect(401);
  });

  it.each([
    '/orders',
    '/customers',
    '/trips',
    '/branches',
    '/vehicles',
    '/drivers',
  ])('CUSTOMER không truy cập được %s', async (path) => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', bearer(tokens[Role.CUSTOMER]!))
      .expect(403);
  });

  it('STAFF không được cấp quyền Transport Order', async () => {
    await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', bearer(tokens[Role.STAFF]!))
      .expect(403);
  });

  it('từ chối DISPATCHER thiếu branch thay vì truy vấn không filter', async () => {
    await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', bearer(tokens.DISPATCHER_NO_BRANCH!))
      .expect(403);
  });

  it('DISPATCHER chỉ liệt kê Order thuộc branch của mình', async () => {
    const response = await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .expect(200);

    expect(response.body.map((order: { id: string }) => order.id)).toContain(
      ids.orderB,
    );
    expect(response.body.map((order: { id: string }) => order.id)).not.toContain(
      ids.orderA,
    );
  });

  it('DISPATCHER không thể ép query sang branch khác', async () => {
    await request(app.getHttpServer())
      .get(`/orders?branchId=${ids.branchA}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .expect(403);
  });

  it('kiểm tra branch scope khi đọc Order theo ID', async () => {
    await request(app.getHttpServer())
      .get(`/orders/${ids.orderB}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .expect(200);

    await request(app.getHttpServer())
      .get(`/orders/${ids.orderA}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .expect(403);

    await request(app.getHttpServer())
      .get(`/orders/${ids.orderA}`)
      .set('Authorization', bearer(tokens[Role.ADMIN]!))
      .expect(200);
  });

  it('generic PATCH từ chối chuyển status và không đổi dữ liệu', async () => {
    await request(app.getHttpServer())
      .patch(`/orders/${ids.orderB}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .send({ status: OrderStatus.CONFIRMED })
      .expect(400);

    await expect(
      prisma.order.findUniqueOrThrow({ where: { id: ids.orderB } }),
    ).resolves.toMatchObject({ status: OrderStatus.DRAFT });
  });

  it('generic PATCH kiểm tra branch nhưng giữ luồng sửa hợp lệ', async () => {
    await request(app.getHttpServer())
      .patch(`/orders/${ids.orderA}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .send({ notes: 'cross-branch attempt' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/orders/${ids.orderB}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .send({ notes: 'same-branch update' })
      .expect(200)
      .expect(({ body }) => {
        expect(body.notes).toBe('same-branch update');
      });
  });

  it('giới hạn Branch list/detail theo branch của DISPATCHER', async () => {
    const response = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].id).toBe(ids.branchB);

    await request(app.getHttpServer())
      .get(`/branches/${ids.branchA}`)
      .set('Authorization', bearer(tokens[Role.DISPATCHER]!))
      .expect(403);
  });
});
