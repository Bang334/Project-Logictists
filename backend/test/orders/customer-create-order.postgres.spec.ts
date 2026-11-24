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
import { CustomerOrdersService } from '../../src/orders/customer-orders.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('M2.2 Customer Create Order API (PostgreSQL)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let customerOrdersService: CustomerOrdersService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m22-${suffix}`;
  const tokens: Record<string, string> = {};
  const userIds: string[] = [];
  const ids = {
    activeBranch: '',
    inactiveBranch: '',
    customerUser: '',
    customerId: '',
  };

  const bearer = (token: string) => `Bearer ${token}`;
  const createPayload = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: randomUUID(),
    branchId: ids.activeBranch,
    pickup: {
      address: 'Hà Nội - ngoài khu vực chi nhánh mẫu',
      latitude: 21.0278,
      longitude: 105.8342,
      contactName: 'Người gửi M2.2',
      contactPhone: '090-111-2222',
    },
    delivery: {
      address: 'Đà Nẵng',
      latitude: 16.0544,
      longitude: 108.2022,
      contactName: 'Người nhận M2.2',
      contactPhone: '0912223333',
    },
    items: [
      {
        description: 'Kiện thiết bị công nghiệp',
        packageType: 'CRATE',
        quantity: 2,
        unitWeightKg: 780,
        lengthCm: 220,
        widthCm: 120,
        heightCm: 110,
      },
      {
        description: 'Thùng phụ kiện',
        quantity: 3,
        unitWeightKg: 20,
        lengthCm: 50,
        widthCm: 40,
        heightCm: 30,
      },
    ],
    notes: `${prefix} DRAFT chờ kiểm tra`,
    ...overrides,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = 'm22-customer-create-order-integration-secret';

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
    customerOrdersService = app.get(CustomerOrdersService);

    const [activeBranch, inactiveBranch] = await Promise.all([
      prisma.branch.create({
        data: {
          code: `${prefix}-ACTIVE`,
          name: 'M2.2 Active Branch',
          address: 'TP Hồ Chí Minh',
          latitude: 10.8231,
          longitude: 106.6297,
          active: true,
        },
      }),
      prisma.branch.create({
        data: {
          code: `${prefix}-INACTIVE`,
          name: 'M2.2 Inactive Branch',
          address: 'Integration test only',
          latitude: 10,
          longitude: 106,
          active: false,
        },
      }),
    ]);
    ids.activeBranch = activeBranch.id;
    ids.inactiveBranch = inactiveBranch.id;

    const userInputs = [
      { label: 'customer', role: Role.CUSTOMER, branchId: null },
      { label: 'customer-missing', role: Role.CUSTOMER, branchId: null },
      { label: 'admin', role: Role.ADMIN, branchId: null },
      { label: 'dispatcher', role: Role.DISPATCHER, branchId: activeBranch.id },
      { label: 'staff', role: Role.STAFF, branchId: activeBranch.id },
      { label: 'driver', role: Role.DRIVER, branchId: activeBranch.id },
    ];
    for (const input of userInputs) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: 'integration-test-not-a-real-credential',
          fullName: `M2.2 ${input.label}`,
          role: input.role,
          branchId: input.branchId,
        },
      });
      userIds.push(user.id);
      if (input.label === 'customer') ids.customerUser = user.id;
      tokens[input.label] = jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role,
      });
    }

    const phoneSuffix = suffix.replace(/[^0-9]/g, '').padEnd(7, '7').slice(0, 7);
    const customer = await prisma.customer.create({
      data: {
        code: `${prefix}-CUS`,
        userId: ids.customerUser,
        name: 'M2.2 Customer',
        phone: `093${phoneSuffix}`,
      },
    });
    ids.customerId = customer.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const orders = await prisma.order.findMany({
      where: { notes: { startsWith: prefix } },
      select: { id: true },
    });
    const orderIds = orders.map((order) => order.id);
    if (orderIds.length > 0) {
      await prisma.orderEvent.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await prisma.processedCommand.deleteMany({
      where: { actorUserId: { in: userIds } },
    });
    await prisma.customer.deleteMany({ where: { code: { startsWith: prefix } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { code: { startsWith: prefix } } });
    await app.close();
  });

  it('GET /customer/branches chỉ trả Branch active theo allowlist', async () => {
    const response = await request(app.getHttpServer())
      .get('/customer/branches')
      .set('Authorization', bearer(tokens.customer))
      .expect(200);

    const active = response.body.find(
      (branch: { id: string }) => branch.id === ids.activeBranch,
    );
    expect(active).toEqual({
      id: ids.activeBranch,
      code: `${prefix}-ACTIVE`,
      name: 'M2.2 Active Branch',
    });
    expect(
      response.body.some(
        (branch: { id: string }) => branch.id === ids.inactiveBranch,
      ),
    ).toBe(false);
    expect(JSON.stringify(active)).not.toContain('fuelPricePerLiter');
    const sorted = await prisma.branch.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
    expect(response.body).toEqual(sorted);
  });

  it.each(['admin', 'dispatcher', 'staff', 'driver'])(
    'chặn role %s khỏi Customer endpoints',
    async (label) => {
      await request(app.getHttpServer())
        .get('/customer/branches')
        .set('Authorization', bearer(tokens[label]))
        .expect(403);
      await request(app.getHttpServer())
        .post('/customer/orders')
        .set('Authorization', bearer(tokens[label]))
        .send(createPayload())
        .expect(403);
    },
  );

  it('chặn request thiếu JWT hoặc JWT sai', async () => {
    await request(app.getHttpServer()).get('/customer/branches').expect(401);
    await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', 'Bearer invalid-token')
      .send(createPayload())
      .expect(401);
  });

  it('tạo đúng một Order DRAFT với totals/stops/items/event do Backend kiểm soát', async () => {
    const payload = createPayload();
    const response = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(payload)
      .expect(201);

    expect(response.body).toMatchObject({
      status: OrderStatus.DRAFT,
      version: 1,
      branch: {
        id: ids.activeBranch,
        code: `${prefix}-ACTIVE`,
        name: 'M2.2 Active Branch',
      },
      totalPackages: 5,
      totalWeightKg: 1620,
      totalVolumeM3: 5.988,
    });
    expect(response.body.orderNumber).toMatch(/^ORD-CUS-\d{8}-\d{4,}$/);
    expect(JSON.stringify(response.body)).not.toContain('totalAmount');

    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: response.body.id },
      include: {
        stops: { orderBy: { sequence: 'asc' } },
        items: { orderBy: { createdAt: 'asc' } },
        events: true,
        packages: true,
      },
    });
    expect(stored).toMatchObject({
      customerId: ids.customerId,
      branchId: ids.activeBranch,
      status: OrderStatus.DRAFT,
      totalPackages: 5,
      totalWeightKg: 1620,
      totalVolumeM3: 5.988,
    });
    expect(Number(stored.totalAmount)).toBe(0);
    expect(stored.stops.map((stop) => [stop.type, stop.sequence])).toEqual([
      [StopType.PICKUP, 1],
      [StopType.DELIVERY, 2],
    ]);
    expect(stored.stops[0].contactPhone).toBe('0901112222');
    expect(stored.items[0]).toMatchObject({ weightKg: 1560, volumeM3: 5.808 });
    expect(stored.events).toHaveLength(1);
    expect(stored.events[0]).toMatchObject({
      eventType: 'ORDER_CREATED',
      toStatus: OrderStatus.DRAFT,
      actorUserId: ids.customerUser,
    });
    expect(stored.events[0].commandId).toBeTruthy();
    expect(stored.packages).toHaveLength(0);
  });

  it('cho phép Branch active dù pickup khác khu vực vì chưa có service-area mapping', async () => {
    const response = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(createPayload())
      .expect(201);
    expect(response.body.status).toBe(OrderStatus.DRAFT);
    expect(response.body.branch.id).toBe(ids.activeBranch);
  });

  it('từ chối Branch inactive hoặc không tồn tại mà không tạo dữ liệu mồ côi', async () => {
    for (const branchId of [ids.inactiveBranch, randomUUID()]) {
      const payload = createPayload({ branchId });
      await request(app.getHttpServer())
        .post('/customer/orders')
        .set('Authorization', bearer(tokens.customer))
        .send(payload)
        .expect(400);
      expect(
        await prisma.processedCommand.count({
          where: {
            actorUserId: ids.customerUser,
            commandType: 'CREATE_CUSTOMER_ORDER',
            idempotencyKey: payload.idempotencyKey,
          },
        }),
      ).toBe(0);
    }
  });

  it('trả convention hiện tại khi CUSTOMER thiếu Customer relation', async () => {
    const response = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens['customer-missing']))
      .send(createPayload())
      .expect(409);
    expect(response.body.errorCode).toBe('CUSTOMER_PROFILE_NOT_FOUND');
  });

  it('từ chối field đặc quyền và dữ liệu số/collection sai giới hạn', async () => {
    await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send({
        ...createPayload(),
        customerId: randomUUID(),
        status: OrderStatus.CONFIRMED,
        totalAmount: 1,
        orderNumber: 'INJECTED',
      })
      .expect(400);

    const invalid = createPayload();
    invalid.items[0].unitWeightKg = 1_001;
    await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(invalid)
      .expect(400);

    await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(createPayload({ items: [] }))
      .expect(400);
  });

  it('cùng key/cùng payload trả cùng Order và chỉ ghi một command/event', async () => {
    const payload = createPayload();
    const first = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(payload)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(payload)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(
      await prisma.processedCommand.count({
        where: {
          actorUserId: ids.customerUser,
          commandType: 'CREATE_CUSTOMER_ORDER',
          idempotencyKey: payload.idempotencyKey,
        },
      }),
    ).toBe(1);
    expect(await prisma.orderEvent.count({ where: { orderId: first.body.id } })).toBe(1);
  });

  it('cùng key nhưng payload khác trả conflict', async () => {
    const payload = createPayload();
    await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(payload)
      .expect(201);
    await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send({ ...payload, notes: `${prefix} changed payload` })
      .expect(409);
  });

  it('hai request đồng thời cùng key chỉ tạo một Order', async () => {
    const payload = createPayload();
    const responses = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post('/customer/orders')
          .set('Authorization', bearer(tokens.customer))
          .send(payload),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
  });

  it('nhiều request đồng thời dùng key khác nhau có orderNumber duy nhất', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app.getHttpServer())
          .post('/customer/orders')
          .set('Authorization', bearer(tokens.customer))
          .send(createPayload()),
      ),
    );
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(6);
    expect(new Set(responses.map((response) => response.body.orderNumber)).size).toBe(6);
  });

  it('rollback Order và ProcessedCommand nếu OrderEvent lỗi sau các bước create', async () => {
    const payload = createPayload({ notes: `${prefix} forced rollback ${randomUUID()}` });
    const originalTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = jest.spyOn(prisma, '$transaction');
    transactionSpy.mockImplementationOnce((async (callback: unknown) => {
      if (typeof callback !== 'function') {
        throw new Error('Expected interactive transaction');
      }
      return originalTransaction(async (tx) => {
        jest
          .spyOn(tx.orderEvent, 'create')
          .mockRejectedValueOnce(new Error('M2.2 forced event failure'));
        return callback(tx);
      });
    }) as typeof prisma.$transaction);

    await expect(
      customerOrdersService.createForUser(ids.customerUser, payload),
    ).rejects.toThrow('M2.2 forced event failure');
    transactionSpy.mockRestore();

    expect(
      await prisma.order.count({
        where: { notes: payload.notes as string },
      }),
    ).toBe(0);
    expect(
      await prisma.processedCommand.count({
        where: {
          actorUserId: ids.customerUser,
          commandType: 'CREATE_CUSTOMER_ORDER',
          idempotencyKey: payload.idempotencyKey,
        },
      }),
    ).toBe(0);
  });

  it('DRAFT không xuất hiện trong API nguồn điều phối/Optimizer', async () => {
    const created = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(createPayload())
      .expect(201);
    const available = await request(app.getHttpServer())
      .get('/orders/available-for-dispatch')
      .set('Authorization', bearer(tokens.dispatcher))
      .expect(200);
    expect(
      available.body.some((order: { id: string }) => order.id === created.body.id),
    ).toBe(false);
  });

  it('M2.1 list/detail đọc được Order vừa tạo và không lộ giá nội bộ', async () => {
    const created = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', bearer(tokens.customer))
      .send(createPayload())
      .expect(201);
    const list = await request(app.getHttpServer())
      .get('/customer/orders?status=DRAFT')
      .set('Authorization', bearer(tokens.customer))
      .expect(200);
    expect(list.body.items.some((order: { id: string }) => order.id === created.body.id)).toBe(true);
    const detail = await request(app.getHttpServer())
      .get(`/customer/orders/${created.body.id}`)
      .set('Authorization', bearer(tokens.customer))
      .expect(200);
    expect(detail.body.items[0]).toMatchObject({
      quantity: 2,
      unitWeightKg: 780,
      lineWeightKg: 1560,
    });
    expect(JSON.stringify(detail.body)).not.toContain('totalAmount');
  });
});
