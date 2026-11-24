import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OrderStatus, Role, StopType } from '@prisma/client';
import { randomUUID } from 'crypto';
import request = require('supertest');
import { AuthModule } from '../../src/auth/auth.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('M2.1 Customer Order Read API (PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m21-${suffix}`;
  const tokens: Record<string, string> = {};
  const ids = {
    branch: '',
    customerA: '',
    customerB: '',
    orderAOldDraft: '',
    orderAConfirmed: '',
    orderANewDraft: '',
    orderB: '',
  };

  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = 'm21-customer-orders-integration-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        OrdersModule,
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

    const branch = await prisma.branch.create({
      data: {
        code: `${prefix}-BR`,
        name: 'M2.1 Branch',
        address: 'Integration test only',
        latitude: 10,
        longitude: 106,
      },
    });
    ids.branch = branch.id;

    const userInputs = [
      { label: 'customer-a', role: Role.CUSTOMER },
      { label: 'customer-b', role: Role.CUSTOMER },
      { label: 'customer-missing', role: Role.CUSTOMER },
      { label: 'admin', role: Role.ADMIN },
      { label: 'dispatcher', role: Role.DISPATCHER },
      { label: 'staff', role: Role.STAFF },
      { label: 'driver', role: Role.DRIVER },
    ];

    const users: Record<string, string> = {};
    for (const input of userInputs) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: 'integration-test-not-a-real-credential',
          fullName: `M2.1 ${input.label}`,
          role: input.role,
          branchId:
            input.role === Role.ADMIN || input.role === Role.CUSTOMER
              ? null
              : branch.id,
        },
      });
      users[input.label] = user.id;
      tokens[input.label] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
    }

    const [customerA, customerB] = await Promise.all([
      prisma.customer.create({
        data: {
          code: `${prefix}-CUS-A`,
          userId: users['customer-a'],
          name: 'Customer A',
          phone: `091${suffix.replace(/[^0-9]/g, '').padEnd(7, '1').slice(0, 7)}`,
        },
      }),
      prisma.customer.create({
        data: {
          code: `${prefix}-CUS-B`,
          userId: users['customer-b'],
          name: 'Customer B',
          phone: `092${suffix.replace(/[^0-9]/g, '').padEnd(7, '2').slice(0, 7)}`,
        },
      }),
    ]);
    ids.customerA = customerA.id;
    ids.customerB = customerB.id;

    const createOrder = (
      label: string,
      customerId: string,
      status: OrderStatus,
      createdAt: Date,
    ) =>
      prisma.order.create({
        data: {
          orderNumber: `${prefix}-${label}`,
          customerId,
          branchId: branch.id,
          status,
          notes: `Notes ${label}`,
          totalPackages: 4,
          totalWeightKg: 50,
          totalVolumeM3: 0.12,
          orderedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
          stops: {
            create: [
              {
                type: StopType.DELIVERY,
                sequence: 2,
                address: `Delivery ${label}`,
                latitude: 11,
                longitude: 107,
                contactName: 'Receiver',
                contactPhone: '0900000002',
              },
              {
                type: StopType.PICKUP,
                sequence: 1,
                address: `Pickup ${label}`,
                latitude: 10,
                longitude: 106,
                contactName: 'Sender',
                contactPhone: '0900000001',
              },
            ],
          },
          items: {
            create: {
              description: `Carton ${label}`,
              packageType: 'CARTON',
              quantity: 4,
              weightKg: 50,
              lengthCm: 40,
              widthCm: 30,
              heightCm: 25,
              volumeM3: 0.12,
            },
          },
        },
      });

    const [oldDraft, confirmed, newDraft, orderB] = await Promise.all([
      createOrder(
        'A-OLD-DRAFT',
        customerA.id,
        OrderStatus.DRAFT,
        new Date('2026-11-15T01:00:00.000Z'),
      ),
      createOrder(
        'A-CONFIRMED',
        customerA.id,
        OrderStatus.CONFIRMED,
        new Date('2026-11-15T02:00:00.000Z'),
      ),
      createOrder(
        'A-NEW-DRAFT',
        customerA.id,
        OrderStatus.DRAFT,
        new Date('2026-11-15T03:00:00.000Z'),
      ),
      createOrder(
        'B-DRAFT',
        customerB.id,
        OrderStatus.DRAFT,
        new Date('2026-11-15T04:00:00.000Z'),
      ),
    ]);
    ids.orderAOldDraft = oldDraft.id;
    ids.orderAConfirmed = confirmed.id;
    ids.orderANewDraft = newDraft.id;
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

  it('CUSTOMER lấy list của mình với pagination mặc định và không lộ field nội bộ', async () => {
    const response = await request(app.getHttpServer())
      .get('/customer/orders')
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(200);

    expect(response.body).toMatchObject({
      page: 1,
      limit: 20,
      total: 3,
      totalPages: 1,
    });
    expect(response.body.items.map((order: { id: string }) => order.id)).toEqual([
      ids.orderANewDraft,
      ids.orderAConfirmed,
      ids.orderAOldDraft,
    ]);
    expect(response.body.items.map((order: { id: string }) => order.id)).not.toContain(
      ids.orderB,
    );
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('totalAmount');
    expect(serialized).not.toContain('customerId');
    expect(serialized).not.toContain('branchId');
    expect(serialized).not.toContain('paymentStatus');
  });

  it('lọc status và phân trang chính xác', async () => {
    const response = await request(app.getHttpServer())
      .get('/customer/orders?status=DRAFT&page=2&limit=1')
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(200);

    expect(response.body).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].id).toBe(ids.orderAOldDraft);
  });

  it('trả detail có stops đúng sequence và semantics khối lượng/thể tích', async () => {
    const response = await request(app.getHttpServer())
      .get(`/customer/orders/${ids.orderAConfirmed}`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(200);

    expect(response.body).toMatchObject({
      id: ids.orderAConfirmed,
      status: OrderStatus.CONFIRMED,
      totalPackages: 4,
      totalWeightKg: 50,
      totalVolumeM3: 0.12,
    });
    expect(response.body.stops.map((stop: { sequence: number }) => stop.sequence)).toEqual([
      1, 2,
    ]);
    expect(response.body.items[0]).toMatchObject({
      quantity: 4,
      lineWeightKg: 50,
      unitWeightKg: 12.5,
      lineVolumeM3: 0.12,
      unitVolumeM3: 0.03,
    });
    expect(response.body).not.toHaveProperty('totalAmount');
    expect(response.body).not.toHaveProperty('customerId');
    expect(response.body).not.toHaveProperty('branchId');
  });

  it('trả cùng 404 cho Order không tồn tại và Order của Customer khác', async () => {
    await request(app.getHttpServer())
      .get(`/customer/orders/${ids.orderB}`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(404);

    await request(app.getHttpServer())
      .get(`/customer/orders/${randomUUID()}`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(404);
  });

  it.each(['admin', 'dispatcher', 'staff', 'driver'])(
    'chặn role %s khỏi Customer endpoint',
    async (label) => {
      await request(app.getHttpServer())
        .get('/customer/orders')
        .set('Authorization', bearer(tokens[label]))
        .expect(403);
    },
  );

  it('từ chối JWT thiếu hoặc không hợp lệ', async () => {
    await request(app.getHttpServer()).get('/customer/orders').expect(401);
    await request(app.getHttpServer())
      .get('/customer/orders')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('trả CUSTOMER_PROFILE_NOT_FOUND khi User thiếu Customer relation', async () => {
    await request(app.getHttpServer())
      .get('/customer/orders')
      .set('Authorization', bearer(tokens['customer-missing']))
      .expect(409)
      .expect(({ body }) => {
        expect(body.errorCode).toBe('CUSTOMER_PROFILE_NOT_FOUND');
      });
  });

  it.each([
    '?page=0',
    '?page=1.5',
    '?limit=0',
    '?limit=101',
    '?status=UNKNOWN',
    '?customerId=injected',
    '?branchId=injected',
  ])('từ chối query không hợp lệ %s', async (query) => {
    await request(app.getHttpServer())
      .get(`/customer/orders${query}`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(400);
  });

  it('không làm hỏng endpoint Web Admin /orders', async () => {
    const response = await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', bearer(tokens.admin))
      .expect(200);
    const idsInResponse = response.body.map((order: { id: string }) => order.id);
    expect(idsInResponse).toEqual(
      expect.arrayContaining([ids.orderAConfirmed, ids.orderB]),
    );
  });
});
