import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  OrderStatus,
  Role,
  StopType,
  TaskAction,
  TripStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import request = require('supertest');
import { AuthModule } from '../../src/auth/auth.module';
import { OrdersModule } from '../../src/orders/orders.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('M3.6D.1 Customer Order Tracking API (PostgreSQL)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `m36d-${suffix}`;
  const tokens: Record<string, string> = {};
  const userIds: string[] = [];
  const customerIds: string[] = [];
  const orderIds: string[] = [];
  const tripIds: string[] = [];
  let branchId = '';
  let vehicleId = '';
  let ownedOrderId = '';
  let noTripOrderId = '';
  let otherOrderId = '';
  const plannedDeliveryTimes: string[] = [];

  const bearer = (token: string) => `Bearer ${token}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = 'm36d-customer-tracking-integration-secret';

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
        name: 'M3.6D Branch',
        address: 'Integration test only',
        latitude: 10,
        longitude: 106,
      },
    });
    branchId = branch.id;

    const users: Record<string, string> = {};
    for (const input of [
      { label: 'customer-a', role: Role.CUSTOMER },
      { label: 'customer-b', role: Role.CUSTOMER },
      { label: 'customer-missing', role: Role.CUSTOMER },
      { label: 'admin', role: Role.ADMIN },
      { label: 'dispatcher', role: Role.DISPATCHER },
      { label: 'staff', role: Role.STAFF },
      { label: 'driver', role: Role.DRIVER },
    ]) {
      const user = await prisma.user.create({
        data: {
          username: `${prefix}-${input.label}`,
          password: 'integration-test-not-a-real-credential',
          fullName: `M3.6D ${input.label}`,
          role: input.role,
          branchId:
            input.role === Role.CUSTOMER || input.role === Role.ADMIN
              ? null
              : branch.id,
        },
      });
      users[input.label] = user.id;
      userIds.push(user.id);
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
          phone: `${prefix}-PHONE-A`,
        },
      }),
      prisma.customer.create({
        data: {
          code: `${prefix}-CUS-B`,
          userId: users['customer-b'],
          name: 'Customer B',
          phone: `${prefix}-PHONE-B`,
        },
      }),
    ]);
    customerIds.push(customerA.id, customerB.id);

    const createOrder = async (label: string, customerId: string) => {
      const order = await prisma.order.create({
        data: {
          orderNumber: `${prefix}-${label}`,
          customerId,
          branchId,
          status: OrderStatus.IN_TRANSIT,
          totalPackages: 1,
          totalWeightKg: 10,
          totalVolumeM3: 0.1,
        },
      });
      orderIds.push(order.id);
      return order;
    };
    const [ownedOrder, noTripOrder, otherOrder] = await Promise.all([
      createOrder('OWNED', customerA.id),
      createOrder('NO-TRIP', customerA.id),
      createOrder('OTHER', customerB.id),
    ]);
    ownedOrderId = ownedOrder.id;
    noTripOrderId = noTripOrder.id;
    otherOrderId = otherOrder.id;

    const vehicle = await prisma.vehicle.create({
      data: {
        plateNumber: `${prefix}-PLATE`,
        model: 'Tracking test vehicle',
        vehicleType: 'Truck',
        homeBranchId: branch.id,
        payloadCapacityKg: 5000,
        volumeCapacityM3: 20,
        lengthCm: 600,
        widthCm: 240,
        heightCm: 250,
        currentLatitude: 99,
        currentLongitude: 99,
        lastLocationAt: new Date(),
      },
    });
    vehicleId = vehicle.id;

    const now = Date.now();
    const tripInputs = [
      {
        label: 'ACTIVE',
        status: TripStatus.IN_PROGRESS,
        start: new Date(now - 60 * 60_000),
        gps: [
          { ageMs: 90_000, latitude: 10.1 },
          { ageMs: 20_000, latitude: 10.2 },
        ],
      },
      {
        label: 'NO-GPS',
        status: TripStatus.DISPATCHED,
        start: new Date(now + 60 * 60_000),
        gps: [],
      },
      {
        label: 'COMPLETED',
        status: TripStatus.COMPLETED,
        start: new Date(now - 4 * 60 * 60_000),
        gps: [{ ageMs: 3 * 60_000, latitude: 10.3 }],
      },
    ];

    for (const [index, input] of tripInputs.entries()) {
      const plannedDeliveryAt = new Date(input.start.getTime() + 45 * 60_000);
      plannedDeliveryTimes.push(plannedDeliveryAt.toISOString());
      const trip = await prisma.trip.create({
        data: {
          tripNumber: `${prefix}-${input.label}`,
          vehicleId,
          managingBranchId: branchId,
          status: input.status,
          plannedStartTime: input.start,
          plannedEndTime: new Date(input.start.getTime() + 2 * 60 * 60_000),
          actualStartTime:
            input.status === TripStatus.DISPATCHED ? null : input.start,
          actualEndTime:
            input.status === TripStatus.COMPLETED
              ? new Date(now - 2 * 60_000)
              : null,
          version: index + 1,
          routeGeometry: `PRIVATE-ROUTE-${input.label}`,
          stops: {
            create: {
              sequence: 1,
              stopType: StopType.DELIVERY,
              address: `Delivery ${input.label}`,
              latitude: 10.5,
              longitude: 106.5,
              contactName: `PRIVATE-CONTACT-${input.label}`,
              plannedArrivalTime: plannedDeliveryAt,
              tasks: {
                create: {
                  orderId: ownedOrder.id,
                  action: TaskAction.UNLOAD,
                  plannedQuantity: 1,
                },
              },
            },
          },
        },
      });
      tripIds.push(trip.id);
      for (const [pointIndex, point] of input.gps.entries()) {
        const measuredAt = new Date(now - point.ageMs);
        await prisma.gpsEvent.create({
          data: {
            deviceCode: randomUUID(),
            deviceSessionId: randomUUID(),
            sequence: BigInt(pointIndex + 1),
            vehicleId,
            tripId: trip.id,
            measuredAt,
            receivedAt: new Date(measuredAt.getTime() + 2_000),
            latitude: point.latitude,
            longitude: 106.7,
            accuracyM: 9,
          },
        });
      }
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.gpsEvent.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await app.close();
  });

  it('CUSTOMER đọc đầy đủ nhiều Trip và latest GPS của từng Trip', async () => {
    const response = await request(app.getHttpServer())
      .get(`/customer/orders/${ownedOrderId}/tracking`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(200);

    expect(response.body).toMatchObject({
      orderId: ownedOrderId,
      orderStatus: OrderStatus.IN_TRANSIT,
      trackingStatus: 'AVAILABLE',
    });
    expect(response.body.trips).toHaveLength(3);
    const active = response.body.trips.find(
      (trip: { tripNumber: string }) => trip.tripNumber === `${prefix}-ACTIVE`,
    );
    expect(active).toMatchObject({
      status: TripStatus.IN_PROGRESS,
      plannedDeliveryAt: plannedDeliveryTimes[0],
      etaSource: 'PLANNED',
      vehicleLocation: {
        latitude: 10.2,
        longitude: 106.7,
        accuracyM: 9,
        isStale: false,
      },
    });
    const withoutGps = response.body.trips.find(
      (trip: { tripNumber: string }) => trip.tripNumber === `${prefix}-NO-GPS`,
    );
    expect(withoutGps.vehicleLocation).toBeNull();
    const completed = response.body.trips.find(
      (trip: { tripNumber: string }) => trip.tripNumber === `${prefix}-COMPLETED`,
    );
    expect(completed.vehicleLocation).toMatchObject({
      latitude: 10.3,
      isStale: true,
    });
  });

  it('không lộ dữ liệu Driver, device/session, route, stop khác hoặc Vehicle.currentLocation', async () => {
    const response = await request(app.getHttpServer())
      .get(`/customer/orders/${ownedOrderId}/tracking`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(200);
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      'deviceCode',
      'deviceSessionId',
      'routeGeometry',
      'PRIVATE-ROUTE',
      'PRIVATE-CONTACT',
      'driverId',
      'currentLatitude',
      '"latitude":99',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('Order chưa có Trip trả 200 NOT_ASSIGNED', async () => {
    await request(app.getHttpServer())
      .get(`/customer/orders/${noTripOrderId}/tracking`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          orderId: noTripOrderId,
          trackingStatus: 'NOT_ASSIGNED',
          trips: [],
        });
      });
  });

  it('Order khác Customer và Order không tồn tại đều trả 404', async () => {
    await request(app.getHttpServer())
      .get(`/customer/orders/${otherOrderId}/tracking`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/customer/orders/${randomUUID()}/tracking`)
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(404);
  });

  it('thiếu Customer profile trả CUSTOMER_PROFILE_NOT_FOUND', async () => {
    await request(app.getHttpServer())
      .get(`/customer/orders/${ownedOrderId}/tracking`)
      .set('Authorization', bearer(tokens['customer-missing']))
      .expect(409)
      .expect(({ body }) => {
        expect(body.errorCode).toBe('CUSTOMER_PROFILE_NOT_FOUND');
      });
  });

  it.each(['admin', 'dispatcher', 'staff', 'driver'])(
    'chặn role %s khỏi Customer tracking endpoint',
    async (label) => {
      await request(app.getHttpServer())
        .get(`/customer/orders/${ownedOrderId}/tracking`)
        .set('Authorization', bearer(tokens[label]))
        .expect(403);
    },
  );

  it('từ chối JWT thiếu/không hợp lệ và order ID không phải UUID', async () => {
    await request(app.getHttpServer())
      .get(`/customer/orders/${ownedOrderId}/tracking`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/customer/orders/${ownedOrderId}/tracking`)
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
    await request(app.getHttpServer())
      .get('/customer/orders/not-a-uuid/tracking')
      .set('Authorization', bearer(tokens['customer-a']))
      .expect(400);
  });
});
