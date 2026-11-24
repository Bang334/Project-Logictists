import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { OrderStatus, Prisma, Role } from '@prisma/client';
import axios from 'axios';
import { randomUUID } from 'crypto';
import request = require('supertest');
import type { Response } from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { OutboxService } from '../../src/common/services/outbox.service';
import { MapboxService } from '../../src/mapbox/mapbox.service';
import { OrdersModule } from '../../src/orders/orders.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { signOptimizationProposal } from '../../src/trips/optimization-proposal';
import { TripsService } from '../../src/trips/trips.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('M2.3 Customer Order confirmation (PostgreSQL)', () => {
  jest.setTimeout(40_000);
  const prefix = `g1-${randomUUID()}`;
  const plannerSecret = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const branchInactive = randomUUID();
  const branches = [branchA, branchB, branchInactive];
  const customerId = randomUUID();
  const userIds: string[] = [];
  const actors: Record<string, { id: string; token: string }> = {};
  const matrix = jest.fn(async (coords: [number, number][]) => {
    const values = coords.map((_, i) => coords.map((__, j) => (i === j ? 0 : 100)));
    return { distancesMeters: values, durationsSeconds: values };
  });
  const mapbox = { getRoadMatrix: matrix };
  let app: INestApplication;
  let prisma: PrismaService;
  let writeHook: Prisma.Middleware | undefined;

  const stop = {
    address: 'Địa chỉ QA',
    latitude: 10.8,
    longitude: 106.7,
    contactName: 'Liên hệ QA',
    contactPhone: '0901234567',
  };
  const item = {
    description: 'Kiện QA',
    quantity: 2,
    lengthCm: 33,
    widthCm: 31,
    heightCm: 32,
  };

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (
      target.host !== '127.0.0.1:55433' ||
      target.pathname !== '/tms_auth_test' ||
      (target.searchParams.get('schema') ?? 'public') !== 'public'
    ) {
      throw new Error('M2.3 requires the dedicated local QA database');
    }
    process.env.DATABASE_URL = databaseUrl;
    process.env.JWT_SECRET = randomUUID();
    process.env.OPTIMIZATION_PROPOSAL_SECRET = plannerSecret;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        OrdersModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    prisma.$use((params, next) => (writeHook ? writeHook(params, next) : next(params)));
    const jwt = app.get(JwtService);
    await prisma.branch.createMany({
      data: branches.map((id) => ({
        id,
        code: `${prefix}-${id}`,
        name: 'Chi nhánh QA',
        address: 'Địa chỉ QA',
        latitude: 10.8,
        longitude: 106.7,
      })),
    });
    for (const [name, role, branchId] of [
      ['customer', Role.CUSTOMER, null],
      ['otherCustomer', Role.CUSTOMER, null],
      ['admin', Role.ADMIN, null],
      ['second', Role.ADMIN, null],
      ['inactive', Role.ADMIN, null],
      ['dispatcher', Role.DISPATCHER, branchA],
      ['otherBranch', Role.DISPATCHER, branchB],
      ['noBranch', Role.DISPATCHER, null],
      ['driver', Role.DRIVER, branchA],
      ['staff', Role.STAFF, branchA],
    ] as const) {
      const user = await prisma.user.create({
        data: { username: `${prefix}-${name}`, password: randomUUID(), fullName: name, role, branchId, active: name !== 'inactive' },
      });
      userIds.push(user.id);
      actors[name] = { id: user.id, token: jwt.sign({ sub: user.id, username: user.username, role }) };
    }
    await prisma.customer.createMany({
      data: [
        { id: customerId, code: prefix, name: 'Customer QA', userId: actors.customer.id, phone: randomUUID() },
        { code: `${prefix}-other`, name: 'Customer QA 2', userId: actors.otherCustomer.id, phone: randomUUID() },
      ],
    });
  });

  afterEach(() => {
    writeHook = undefined;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (!prisma) return;
    const scope = { in: branches };
    await prisma.optimizationJob.deleteMany({ where: { branchId: scope } });
    await prisma.orderEvent.deleteMany({ where: { order: { branchId: scope } } });
    await prisma.package.deleteMany({ where: { order: { branchId: scope } } });
    await prisma.order.deleteMany({ where: { branchId: scope } });
    await prisma.processedCommand.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.vehicle.deleteMany({ where: { homeBranchId: scope } });
    await prisma.driver.deleteMany({ where: { homeBranchId: scope } });
    await prisma.location.deleteMany({ where: { managingBranchId: scope } });
    await prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: scope } });
    await app.close();
  });

  const auth = (name: string) => `Bearer ${actors[name].token}`;

  async function draft(branchId = branchA) {
    const response = await request(app.getHttpServer())
      .post('/customer/orders')
      .set('Authorization', auth('customer'))
      .send({
        branchId,
        idempotencyKey: randomUUID(),
        pickup: stop,
        delivery: { ...stop, latitude: 10.82 },
        items: [{ ...item, unitWeightKg: 11.23 }],
      })
      .expect(201);
    expect(response.body.status).toBe('DRAFT');
    return response.body as { id: string; version: number };
  }

  function confirm(id: string, version: number, actor = 'admin', key = randomUUID()) {
    return request(app.getHttpServer())
      .post(`/orders/${id}/confirm`)
      .set('Authorization', auth(actor))
      .send({ expectedVersion: version, idempotencyKey: key });
  }

  function patch(id: string, body: object) {
    return request(app.getHttpServer()).patch(`/orders/${id}`).set('Authorization', auth('admin')).send(body);
  }

  async function confirmationEvents(orderId: string) {
    return prisma.orderEvent.findMany({ where: { orderId, eventType: 'ORDER_CONFIRMED' } });
  }

  it('enforces JWT, roles, Branch, input and missing Order', async () => {
    const order = await draft();
    const endpoint = `/orders/${order.id}/confirm`;
    await request(app.getHttpServer()).post(endpoint).expect(401);
    await request(app.getHttpServer()).post(endpoint).set('Authorization', 'Bearer invalid').expect(401);
    await confirm(order.id, order.version, 'inactive').expect(401);
    for (const actor of ['customer', 'driver', 'staff', 'otherBranch', 'noBranch']) {
      await confirm(order.id, order.version, actor).expect(403);
    }
    await confirm(randomUUID(), order.version).expect(404);
    await confirm('invalid', order.version).expect(400);
    await request(app.getHttpServer()).post(endpoint).set('Authorization', auth('admin'))
      .send({ expectedVersion: '1', idempotencyKey: randomUUID(), status: 'CONFIRMED' }).expect(400);
    expect(await confirmationEvents(order.id)).toHaveLength(0);
  });

  it('confirms once, records audit and replays the receipt after state progression only with current access', async () => {
    const order = await draft();
    const key = randomUUID();
    const submitted = await confirm(order.id, order.version, 'dispatcher', key).expect(200);
    const [event] = await confirmationEvents(order.id);
    expect(event).toMatchObject({ actorUserId: actors.dispatcher.id, fromStatus: 'DRAFT', toStatus: 'CONFIRMED', payload: {
      branchId: branchA, previousVersion: order.version, version: order.version + 1,
    } });
    expect(submitted.body).toEqual({
      orderId: order.id,
      orderNumber: expect.any(String),
      status: 'CONFIRMED',
      version: order.version + 1,
      confirmedAt: event.occurredAt.toISOString(),
    });
    const commands = await prisma.processedCommand.findMany({
      where: { actorUserId: actors.dispatcher.id, commandType: 'CONFIRM_CUSTOMER_ORDER', idempotencyKey: key },
    });
    expect(commands).toEqual([expect.objectContaining({ id: event.commandId, status: 'COMPLETED', result: submitted.body })]);
    await request(app.getHttpServer()).get(`/customer/orders/${order.id}`).set('Authorization', auth('customer'))
      .expect(200).expect(({ body }) => expect(body.status).toBe('CONFIRMED'));
    await request(app.getHttpServer()).get('/customer/orders?status=CONFIRMED').set('Authorization', auth('customer'))
      .expect(200).expect(({ body }) => expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: order.id })])));
    await request(app.getHttpServer()).get(`/customer/orders/${order.id}`).set('Authorization', auth('otherCustomer')).expect(404);

    await prisma.order.update({ where: { id: order.id }, data: { status: 'ASSIGNED', version: { increment: 1 } } });
    await confirm(order.id, order.version, 'dispatcher', key).expect(200, submitted.body);
    await confirm(order.id, order.version + 1, 'dispatcher', key).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_CONFIRM_IDEMPOTENCY_CONFLICT'));
    const otherOrder = await draft();
    await confirm(otherOrder.id, otherOrder.version, 'dispatcher', key).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_CONFIRM_IDEMPOTENCY_CONFLICT'));
    await prisma.user.update({ where: { id: actors.dispatcher.id }, data: { branchId: branchB } });
    try {
      await confirm(order.id, order.version, 'dispatcher', key).expect(403);
    } finally {
      await prisma.user.update({ where: { id: actors.dispatcher.id }, data: { branchId: branchA } });
    }
    expect(await confirmationEvents(order.id)).toHaveLength(1);
  });

  it('serializes duplicate retries and concurrent approval by two ADMIN actors', async () => {
    const replayOrder = await draft();
    const key = randomUUID();
    const [first, retry] = await Promise.all([
      confirm(replayOrder.id, replayOrder.version, 'admin', key).expect(200),
      confirm(replayOrder.id, replayOrder.version, 'admin', key).expect(200),
    ]);
    expect(first.body).toEqual(retry.body);
    expect(await confirmationEvents(replayOrder.id)).toHaveLength(1);
    expect(await prisma.processedCommand.count({ where: { commandType: 'CONFIRM_CUSTOMER_ORDER', idempotencyKey: key } })).toBe(1);

    const order = await draft();
    const keys = [randomUUID(), randomUUID()];
    const outcomes = await Promise.all([
      confirm(order.id, order.version, 'admin', keys[0]),
      confirm(order.id, order.version, 'second', keys[1]),
    ]);
    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(outcomes.find(({ status }) => status === 409)?.body.errorCode).toBe('ORDER_STATE_CONFLICT');
    expect(await confirmationEvents(order.id)).toHaveLength(1);
    expect(await prisma.processedCommand.count({ where: { commandType: 'CONFIRM_CUSTOMER_ORDER', idempotencyKey: { in: keys } } })).toBe(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ version: order.version + 1 });
  });

  it('rejects inactive branch, missing Customer origin, physical Package and invalid stored totals', async () => {
    const inactive = await draft(branchInactive);
    await prisma.branch.update({ where: { id: branchInactive }, data: { active: false } });
    await confirm(inactive.id, inactive.version).expect(422)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_BRANCH_INACTIVE'));

    const legacy = await prisma.order.create({ data: {
      orderNumber: prefix, customerId, branchId: branchA, status: 'DRAFT',
    } });
    await confirm(legacy.id, legacy.version).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_NOT_CONFIRMABLE'));

    const hasPackage = await draft();
    await prisma.package.create({ data: {
      packageCode: prefix, orderId: hasPackage.id, status: 'CANCELLED',
      lengthMm: 100, widthMm: 100, heightMm: 100, weightG: 100n, allowedOrientations: ['DEFAULT'], measurementSource: 'INTEGRATION_TEST',
    } });
    await confirm(hasPackage.id, hasPackage.version).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_NOT_CONFIRMABLE'));

    const invalid = await draft();
    await prisma.order.update({ where: { id: invalid.id }, data: { totalWeightKg: 999 } });
    await confirm(invalid.id, invalid.version).expect(422)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_VALIDATION_FAILED'));
    expect(await prisma.order.findUniqueOrThrow({ where: { id: invalid.id } })).toMatchObject({
      status: 'DRAFT', version: invalid.version,
    });
    expect(await confirmationEvents(invalid.id)).toHaveLength(0);
  });

  it.each(['event', 'command'] as const)('rolls back the transition when the %s write fails in PostgreSQL', async (failure) => {
    const order = await draft();
    const key = randomUUID();
    const originalEvent = await prisma.orderEvent.findFirstOrThrow({ where: { orderId: order.id } });
    writeHook = (params, next) => {
      if (failure === 'event' && params.model === 'OrderEvent' && params.action === 'create') {
        params.args.data.commandId = originalEvent.commandId;
      }
      if (failure === 'command' && params.model === 'ProcessedCommand' && params.action === 'update') {
        params.args.data.actorUserId = randomUUID(); // FK violation at receipt persistence
      }
      return next(params);
    };

    await confirm(order.id, order.version, 'admin', key).expect(500);
    writeHook = undefined;
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'DRAFT', version: order.version,
    });
    expect(await confirmationEvents(order.id)).toHaveLength(0);
    expect(await prisma.processedCommand.count({ where: { idempotencyKey: key } })).toBe(0);
    await confirm(order.id, order.version, 'admin', key).expect(200);
  });

  it.each(['patch', 'confirm'] as const)('serializes concurrent writes when %s obtains the Order lock first', async (first) => {
    const order = await draft();
    let signalFirstWrite!: () => void;
    let releaseFirstWrite!: () => void;
    let signalSecondLock!: () => void;
    const firstWrite = new Promise<void>((resolve) => { signalFirstWrite = resolve; });
    const holdWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const secondLock = new Promise<void>((resolve) => { signalSecondLock = resolve; });
    let firstWriteHeld = false;
    let waitingCalls = 0;
    writeHook = async (params, next) => {
      if (firstWriteHeld && params.action === 'executeRaw') {
        waitingCalls += 1;
        // Confirm acquires its command lock before competing for the Order lock.
        if (waitingCalls === (first === 'patch' ? 2 : 1)) signalSecondLock();
      }
      const result = await next(params);
      if (params.model === 'Order' && params.action === (first === 'patch' ? 'update' : 'updateMany')) {
        firstWriteHeld = true;
        signalFirstWrite();
        await holdWrite;
      }
      return result;
    };
    const edit = () => patch(order.id, { notes: 'Đã sửa', items: [{ ...item, weightKg: 27.345 }] });
    const approve = () => confirm(order.id, order.version);
    const winner = (first === 'patch' ? edit() : approve()).then((response) => response);
    let loser: Promise<Response> | undefined;
    try {
      await Promise.race([firstWrite, winner.then(({ status }) => { throw new Error(`First write ended early: ${status}`); })]);
      loser = (first === 'patch' ? approve() : edit()).then((response) => response);
      await Promise.race([secondLock, loser.then(({ status }) => {
        throw new Error(`Second write ended before contending for lock: ${status}`);
      })]);
    } finally {
      releaseFirstWrite();
    }
    expect((await winner).status).toBe(200);
    expect(await loser).toMatchObject({ status: 409, body: { errorCode: 'ORDER_VERSION_CONFLICT' } });
    const saved = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(saved.version).toBe(order.version + 1);
    if (first === 'patch') {
      expect(saved).toMatchObject({ status: 'DRAFT', notes: 'Đã sửa', items: [{ weightKg: 27.345 }] });
      expect(await confirmationEvents(order.id)).toHaveLength(0);
      await confirm(order.id, saved.version).expect(200);
    } else {
      expect(saved).toMatchObject({ status: 'CONFIRMED', notes: null, items: [{ weightKg: 22.46 }] });
      expect(await confirmationEvents(order.id)).toHaveLength(1);
    }
  });

  it('preserves Web create and PATCH compatibility with optional expectedVersion', async () => {
    const created = await request(app.getHttpServer()).post('/orders').set('Authorization', auth('admin'))
      .send({
        orderedAt: new Date(), customerId, branchId: branchA,
        items: [{ ...item, weightKg: 10 }],
        stops: [
          { ...stop, type: 'PICKUP', sequence: 1 },
          { ...stop, type: 'DELIVERY', sequence: 2 },
        ],
      }).expect(201);
    const { id, version } = created.body;
    expect(created.body.status).toBe('CONFIRMED');
    await patch(id, { status: 'DRAFT' }).expect(400);
    await patch(id, { expectedVersion: null }).expect(400);
    await patch(id, { expectedVersion: version }).expect(200)
      .expect(({ body }) => expect(body.version).toBe(version));
    await patch(id, {
      items: [{ ...item, weightKg: 10 }],
      stops: [
        { ...stop, type: 'PICKUP', sequence: 1 },
        { ...stop, type: 'DELIVERY', sequence: 2 },
      ],
    }).expect(200).expect(({ body }) => {
      expect(body.version).toBe(version);
      expect(body.items[0].id).toBe(created.body.items[0].id);
      expect(body.stops.map(({ id: stopId }: { id: string }) => stopId)).toEqual(created.body.stops.map(({ id: stopId }: { id: string }) => stopId));
    });
    await patch(id, { notes: 'Legacy client' }).expect(200)
      .expect(({ body }) => expect(body.version).toBe(version + 1));
    await patch(id, { notes: 'Old client snapshot', expectedVersion: version }).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_VERSION_CONFLICT'));
    await patch(id, { notes: 'Legacy client', expectedVersion: version + 1 }).expect(200)
      .expect(({ body }) => expect(body.version).toBe(version + 1));
    await confirm(id, version + 1).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_STATE_CONFLICT'));
  });
  it('includes the same confirmed Order and version in a new planner snapshot, and rejects stale apply', async () => {
    const order = await draft();
    const otherBranchOrder = await draft(branchB);
    await confirm(otherBranchOrder.id, otherBranchOrder.version).expect(200);
    const depot = await prisma.location.create({ data: {
      address: stop.address, latitude: stop.latitude, longitude: stop.longitude,
      code: prefix, name: 'Kho QA', type: 'CENTRAL_WAREHOUSE', managingBranchId: branchA,
    } });
    const vehicle = await prisma.vehicle.create({ data: {
      plateNumber: prefix, model: 'QA', vehicleType: 'TRUCK', homeBranchId: branchA,
      homeDepotLocationId: depot.id, payloadCapacityKg: 1000, volumeCapacityM3: 10,
      lengthCm: 300, widthCm: 180, heightCm: 180,
    } });
    const driver = await prisma.driver.create({ data: {
      fullName: 'Driver QA', phone: prefix, citizenId: prefix, licenseNumber: prefix,
      licenseClass: 'C', licenseExpiry: new Date('2099-01-01T00:00:00Z'), homeBranchId: branchA,
    } });
    const actor = { id: actors.admin.id, role: Role.ADMIN, branchId: branchA };
    const planner = new TripsService(prisma, mapbox as unknown as MapboxService, new OutboxService(prisma));
    // The production planner persists the snapshot before requesting solver results.
    const solver = jest.spyOn(axios, 'post').mockRejectedValue(new Error('Stop at external solver boundary'));
    async function captureSnapshot() {
      const job = await prisma.optimizationJob.create({ data: {
        branchId: branchA, createdById: actor.id, idempotencyKey: randomUUID(),
        requestHash: '', requestSnapshot: {},
      } });
      await expect(planner.executeAutomaticOptimization(actor, undefined, job.id))
        .rejects.toMatchObject({ status: 503, message: 'Stop at external solver boundary' });
      return prisma.optimizationJob.findUniqueOrThrow({ where: { id: job.id } });
    }

    const control = await draft();
    await confirm(control.id, control.version).expect(200);
    const before = await captureSnapshot();
    expect(before.requestSnapshot).toMatchObject({ resources: { orders: expect.arrayContaining([{ id: control.id, version: control.version + 1 }]) } });
    expect(JSON.stringify(before.requestSnapshot)).not.toContain(order.id);
    expect(JSON.stringify(before.requestSnapshot)).not.toContain(otherBranchOrder.id);

    await patch(order.id, { expectedVersion: order.version, notes: 'Reviewed revision' }).expect(200);
    await confirm(order.id, order.version).expect(409)
      .expect(({ body }) => expect(body.errorCode).toBe('ORDER_VERSION_CONFLICT'));
    const confirmation = await confirm(order.id, order.version + 1).expect(200);
    const after = await captureSnapshot();
    expect(solver).toHaveBeenCalledTimes(2);
    expect(after.requestSnapshot).toMatchObject({
      resources: { orders: expect.arrayContaining([{ id: order.id, version: confirmation.body.version }]) },
      optimizerPayload: { orders: expect.arrayContaining([
        expect.objectContaining({ source_order_id: order.id, items: expect.arrayContaining([expect.objectContaining({ weight_kg: 11.23 })]) }),
      ]) },
    });
    expect(JSON.stringify(after.requestSnapshot)).not.toContain(otherBranchOrder.id);
    expect((await prisma.optimizationJob.findUniqueOrThrow({ where: { id: before.id } })).requestSnapshot).toEqual(before.requestSnapshot);

    const persisted = await prisma.order.findUniqueOrThrow({
      where: { id: order.id }, include: { stops: { orderBy: { sequence: 'asc' } } },
    });
    expect(await prisma.package.count({ where: { orderId: order.id } })).toBe(0);
    const proposal = {
      branchId: branchA,
      planningEpochIso: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resources: {
        orders: [{ id: order.id, version: confirmation.body.version }],
        vehicles: [{ id: vehicle.id, updatedAt: vehicle.updatedAt.toISOString() }],
        drivers: [{ id: driver.id, updatedAt: driver.updatedAt.toISOString() }],
      },
      result: {
        job_id: after.id, status: 'SUCCESS' as const,
        routes: [{
          route_id: 'qa', vehicle_id: vehicle.id, driver_id: driver.id,
          service_day_index: 0, start_time_sec: 0, end_time_sec: 300,
          plate_number: vehicle.plateNumber, vehicle_length_cm: vehicle.lengthCm,
          vehicle_width_cm: vehicle.widthCm, total_distance_km: 1, total_duration_minutes: 5,
          stops: persisted.stops.map((row) => ({
            sequence: row.sequence, location_id: row.id, location_name: row.address,
            stop_type: row.type === 'PICKUP' ? 'PICKUP' as const : 'DELIVERY' as const,
            order_id: order.id, allocation_id: order.id, order_stop_id: row.id,
            latitude: row.latitude, longitude: row.longitude,
            arrival_time_sec: row.sequence * 60, departure_time_sec: row.sequence * 60 + 30,
            items_loaded: [], items_unloaded: [], current_weight_kg: 0,
          })),
          spatial_validation: { is_valid: true, max_weight_kg: 0, max_area_cm2: 0, step_states: [] },
          cost: {
            base_fuel_cost_vnd: 0, load_fuel_surcharge_vnd: 0, fuel_cost_vnd: 0,
            cargo_holding_cost_vnd: 0, late_delivery_penalty_vnd: 0, cargo_distance_ton_km: 0,
            cargo_time_ton_hours: 0, vehicle_fixed_cost_vnd: 0,
            driver_fixed_salary_allocation_vnd: 0, driver_trip_pay_vnd: 0, total_cost_vnd: 0,
          },
        }],
        unassigned_orders: [], total_distance_km: 1, total_duration_minutes: 5,
        total_cost_vnd: 0, diagnostics: [],
      },
    };
    await patch(order.id, { expectedVersion: confirmation.body.version, notes: 'Changed after snapshot' }).expect(200);
    await expect(planner.applyAutomaticOptimization({
      proposal, signature: signOptimizationProposal(proposal, plannerSecret),
    }, actor)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('đã thay đổi sau khi tối ưu') });
    expect(await prisma.trip.count({ where: { vehicleId: vehicle.id } })).toBe(0);
  });

});
