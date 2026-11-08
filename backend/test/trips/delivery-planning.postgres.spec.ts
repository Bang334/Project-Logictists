import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { PrismaService } from '../../src/prisma/prisma.service';
import { DeliveryPlanningService } from '../../src/trips/delivery-planning.service';
import { TripsService } from '../../src/trips/trips.service';
import { OptimizationJobsService } from '../../src/trips/optimization-jobs.service';
import { OutboxService } from '../../src/common/services/outbox.service';
import { ResourceAccess } from '../../src/auth/resource-access.service';
import { Principal } from '../../src/auth/access';
import { assertOptimizationProposal, signOptimizationProposal } from '../../src/trips/optimization-proposal';
import { OptimizationProposal } from '../../src/trips/optimization-proposal';
import { assertFleetOptimizationResult } from '../../src/trips/optimizer-contract';
import { DeliveryResponse } from '../../src/trips/dto/delivery-planning.dto';

const url = process.env.DELIVERY_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('Delivery planning — PostgreSQL, real solver and transaction guards', () => {
  const baseDb = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  const db = new Proxy(baseDb, {
    get(target, property, receiver) {
      if (property === '$transaction') return (
        operation: Prisma.PrismaPromise<unknown>[] | ((tx: Prisma.TransactionClient) => Promise<unknown>),
        options?: { timeout?: number; maxWait?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
      ) => {
        if (Array.isArray(operation)) return target.$transaction(operation, options);
        return target.$transaction(async tx => {
          const schema = new URL(url ?? '').searchParams.get('schema');
          if (!schema || !/^tms_delivery_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid isolated schema');
          await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
          return operation(tx);
        }, options);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const outbox = new OutboxService(db as PrismaService);
  const access = new ResourceAccess(db as PrismaService);
  const trips = new TripsService(db as PrismaService, {} as never, outbox, access);
  const jobs = new OptimizationJobsService(db as PrismaService, {} as never, trips, outbox);
  const service = new DeliveryPlanningService(db as PrismaService, trips, jobs, access, outbox);
  const sourceRequests = new Map<string, { input: string; proposal: OptimizationProposal }>();
  let branchId: string, vehicleId: string, driverId: string, customerId: string, owner: Principal, customer: Principal;
  const epoch = '2031-01-02T17:00:00.000Z';
  const secret = 'delivery-planning-integration-secret-at-least-32-characters';
  beforeAll(async () => {
    if (!url || !/^tms_delivery_test_[a-f0-9]{32}$/.test(new URL(url).searchParams.get('schema') ?? '')) throw new Error('Only an isolated delivery test schema is allowed');
    process.env.JWT_SECRET = secret;
    process.env.OPTIMIZATION_PROPOSAL_SECRET = secret;
    const branch = await db.branch.create({ data: { code: randomUUID(), name: 'Delivery test', address: 'test', latitude: 10, longitude: 106 } });
    branchId = branch.id;
    const user = await db.user.create({ data: { username: randomUUID(), password: 'test-not-a-credential', fullName: 'Dispatcher' } });
    owner = { id: user.id, username: user.username, fullName: user.fullName, sessionId: 'test', branchId, role: 'DISPATCHER', grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId, permissions: ['trips.plan','trips.read'] }] };
    const customerUser = await db.user.create({ data: { username: randomUUID(), password: 'test-not-a-credential', fullName: 'Customer', role: 'CUSTOMER' } });
    customer = { id: customerUser.id, username: customerUser.username, fullName: 'Customer', sessionId: 'test', role: 'CUSTOMER', grants: [] };
    customerId = (await db.customer.create({ data: { code: randomUUID(), name: 'Test', phone: randomUUID(), userId: customer.id } })).id;
    const type = await db.vehicleType.create({ data: { code: randomUUID(), name: 'Test van', payloadCapacityKg: 1000, volumeCapacityM3: 10, lengthCm: 400, widthCm: 200, heightCm: 200 } });
    const vehicle = await db.vehicle.create({ data: { plateNumber: randomUUID(), model: 'Test', homeBranchId: branchId, vehicleTypeId: type.id } });
    vehicleId = vehicle.id;
    const driver = await db.driver.create({ data: { fullName: 'Test', citizenId: randomUUID(), phone: randomUUID(), licenseNumber: randomUUID(), licenseClass: 'C', licenseExpiry: new Date('2035-01-01'), homeBranchId: branchId } });
    driverId = driver.id;
  }, 60000);
  afterAll(async () => { service.onModuleDestroy(); await db.$disconnect(); });

  async function candidate(day = 0) {
    const order = await db.order.create({ data: { orderNumber: randomUUID(), customerId, branchId, packageDataStatus: 'COMPLETE', orderedAt: new Date('2031-01-01'),
      stops: { create: (['PICKUP','DELIVERY'] as const).map((type, index) => ({ type, sequence: index + 1, address: 'test', latitude: 10, longitude: 106, contactName: 'Test', contactPhone: '000', serviceDurationMinutes: 1 })) },
      items: { create: { description: 'Test', quantity: 1, weightKg: 1, volumeM3: 0.001, packages: { create: { packageCode: randomUUID(), lengthMm: 100, widthMm: 100, heightMm: 100, weightG: 1000n, status: 'READY', measurementSource: 'SEED_DEMO' } } } },
    }, include: { stops: true, items: { include: { packages: true } } } });
    const vehicle = await db.vehicle.findUniqueOrThrow({ where: { id: vehicleId }, include: { vehicleTypeRecord: true } });
    const driver = await db.driver.findUniqueOrThrow({ where: { id: driverId } });
    const job = await db.optimizationJob.create({ data: { branchId, createdById: owner.id, requestHash: 'test', requestSnapshot: {}, idempotencyKey: randomUUID(), status: 'SUCCEEDED' } });
    const payload = {
      job_id: job.id, vehicles: [{ id: vehicleId, source_vehicle_id: vehicleId, service_day_index: 0, plate_number: 'TEST', length_cm: 400, width_cm: 200, height_cm: 200, payload_limit_kg: 1000,
        depot: { id: 'depot', name: 'test', latitude: 10, longitude: 106 }, fuel_consumption_liters_per_100_km: 10, fixed_operating_cost_vnd: 0, available_start_sec: 28800, available_end_sec: 61200 }],
      drivers: [{ id: driverId, source_driver_id: driverId, service_day_index: 0, full_name: 'Test', license_class: 'C', fixed_salary_monthly_vnd: 0, trip_base_pay_vnd: 0, per_km_pay_vnd: 0 }],
      orders: [{ id: order.id, order_number: order.orderNumber,
        pickup_location: { id: order.stops[0].id, name: 'test', latitude: 10, longitude: 106 }, delivery_location: { id: order.stops[1].id, name: 'test', latitude: 10, longitude: 106 },
        items: [{ id: order.items[0].packages[0].id, order_id: order.id, length_cm: 10, width_cm: 10, height_cm: 10, weight_kg: 1 }],
        pickup_service_time_sec: 60, delivery_service_time_sec: 60, pickup_window_end_sec: 604800, delivery_window_end_sec: 604800,
      }], policy: { fuel_price_per_liter_vnd: 23000, monthly_working_minutes: 10560 },
      distance_matrix_meters: [[0,100,100],[100,0,100],[100,100,0]], duration_matrix_seconds: [[0,60,60],[60,0,60],[60,60,0]],
    };
    const run = spawnSync(resolve('../optimizer/.venv/Scripts/python.exe'), ['-X','utf8','-c', 'import sys,json;from app.models import FleetOptimizationRequest;from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer;q=FleetOptimizationRequest.model_validate(json.load(sys.stdin));print(PackingAwareHybridALNSOptimizer(q,time_budget_seconds=2).solve().model_dump_json())'], {
      cwd: resolve('../optimizer'), input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    });
    if (run.status !== 0) throw new Error(run.stderr);
    const proposal: unknown = { branchId, scheduleMode: 'NEXT_DAY', planningEpochIso: new Date(Date.parse(epoch) + day * 86400000).toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString(), resources: {
      orders: [{ id: order.id, version: order.version }], vehicles: [{ id: vehicleId, updatedAt: vehicle.updatedAt.toISOString(), vehicleTypeUpdatedAt: vehicle.vehicleTypeRecord.updatedAt.toISOString() }],
      drivers: [{ id: driverId, updatedAt: driver.updatedAt.toISOString() }],
    }, result: JSON.parse(run.stdout) };
    assertOptimizationProposal(proposal);
    sourceRequests.set(job.id, { input: JSON.stringify(payload), proposal });
    await db.optimizationResult.create({ data: { optimizationJobId: job.id, candidateNumber: 1, resultSnapshot: { proposal, signature: signOptimizationProposal(proposal, secret) }, feasibilityStatus: 'FEASIBLE', objectiveBreakdown: {} } });
    return { jobId: job.id, candidateNumber: 1, windowMinutes: 120, expiresAt: new Date(Date.now() + 3600000).toISOString(), idempotencyKey: randomUUID() };
  }

  it('hai đề xuất cùng năng lực chỉ một đợt được giữ; inbox bền vững, xác nhận retry không trùng, trái tài khoản bị chặn', async () => {
    const [first, second] = [await candidate(), await candidate()];
    const attempts = await Promise.allSettled([service.propose(owner, first), service.propose(owner, second)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await db.deliveryCapacityHold.count({ where: { status: 'HELD' } })).toBe(1);
    const inbox = await service.mine(customer);
    expect(inbox.total).toBe(1);
    const appointment = inbox.items[0];
    const command = { version: appointment.version, idempotencyKey: randomUUID(), decision: DeliveryResponse.CONFIRMED };
    await expect(service.respond({ ...customer, id: owner.id }, appointment.id, command)).rejects.toThrow(/thuộc tài khoản/);
    const confirmed = await service.respond(customer, appointment.id, command);
    expect(confirmed.status).toBe('CONFIRMED');
    expect((await service.respond(customer, appointment.id, command)).version).toBe(confirmed.version);
    await expect(service.respond(customer, appointment.id, { ...command, decision: DeliveryResponse.DECLINED })).rejects.toThrow(/nội dung khác/);
    expect(await db.outboxEvent.count({ where: { aggregateId: appointment.id } })).toBe(2);
  }, 60000);

  it('đề xuất hết hạn giải phóng giữ chỗ; không thể xác nhận muộn hoặc thay đổi đơn', async () => {
    const dto = await candidate(1), batch = await service.propose(owner, dto);
    const appointment = batch.appointments[0];
    await db.deliveryAppointment.update({ where: { id: appointment.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await service.expire();
    expect((await db.deliveryAppointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe('EXPIRED');
    expect(await db.deliveryCapacityHold.count({ where: { batchId: batch.id, status: 'HELD' } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: appointment.orderId } })).status).toBe('CONFIRMED');
    await expect(service.respond(customer, appointment.id, { version: 1, idempotencyKey: randomUUID(), decision: DeliveryResponse.CONFIRMED })).rejects.toThrow(/hết hạn/);
  }, 60000);

  it('yêu cầu đổi không được tự xác nhận khung mới; retry đề xuất không sinh thông báo/hold trùng', async () => {
    const dto = await candidate(2), batch = await service.propose(owner, dto);
    expect((await service.propose(owner, dto)).id).toBe(batch.id);
    const appointment = batch.appointments[0];
    const changed = await service.respond(customer, appointment.id, { version: 1, idempotencyKey: randomUUID(), decision: DeliveryResponse.CHANGE_REQUESTED, requestedStart: '2031-01-07T02:00:00Z', requestedEnd: '2031-01-07T04:00:00Z' });
    expect(changed.status).toBe('CHANGE_REQUESTED');
    expect(changed.windowStart.toISOString()).toBe(appointment.windowStart.toISOString());
    expect(await db.deliveryCapacityHold.count({ where: { batchId: batch.id, status: 'HELD' } })).toBe(0);
    await expect(service.optimize(owner, batch.id, { idempotencyKey: randomUUID() })).rejects.toThrow(/Chưa có khách/);
  }, 60000);

  it('database tự chặn giữ chỗ đồng thời và đặt chuyến đè lên chỗ đã giữ, kể cả bỏ qua service', async () => {
    const job = await db.optimizationJob.findFirstOrThrow();
    const batches = await Promise.all([0, 1].map(() => db.deliveryPlanningBatch.create({ data: {
      branchId, sourceJobId: job.id, candidateNumber: 1, createdById: owner.id, idempotencyKey: randomUUID(), requestHash: 'db-test',
      windowMinutes: 120, expiresAt: new Date(Date.now() + 3600000), proposal: {},
    } })));
    const startsAt = new Date('2031-01-08T01:00:00Z'), endsAt = new Date('2031-01-08T02:00:00Z');
    const results = await Promise.allSettled(batches.map(batch => db.deliveryCapacityHold.create({ data: {
      batchId: batch.id, routeIndex: 0, vehicleId, driverId, orderIds: [randomUUID()], startsAt, endsAt, expiresAt: batch.expiresAt,
    } })));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const trip = await db.trip.create({ data: { tripNumber: randomUUID(), vehicleId, plannedStartTime: startsAt, plannedEndTime: endsAt } });
    await expect(db.resourceReservation.create({ data: { tripId: trip.id, vehicleId, startsAt, endsAt } })).rejects.toThrow(/DELIVERY_CAPACITY_CONFLICT/);
  }, 30000);

  it('xác nhận → tối ưu lại bằng solver thật → áp dụng giữ đúng khung và đổi hold thành reservation trong cùng transaction', async () => {
    const dto = await candidate(3), batch = await service.propose(owner, dto);
    const offer = batch.appointments[0];
    await service.respond(customer, offer.id, { version: offer.version, idempotencyKey: randomUUID(), decision: DeliveryResponse.CONFIRMED });
    const finalJob = await service.optimize(owner, batch.id, { idempotencyKey: randomUUID() });
    const source = sourceRequests.get(dto.jobId);
    if (!source) throw new Error('Missing real source request');
    const window = [
      (offer.windowStart.getTime() - Date.parse(source.proposal.planningEpochIso)) / 1000,
      (offer.windowEnd.getTime() - Date.parse(source.proposal.planningEpochIso)) / 1000,
    ];
    const solved = spawnSync(resolve('../optimizer/.venv/Scripts/python.exe'), ['-X','utf8','-c',
      'import sys,json;from app.models import FleetOptimizationRequest;from app.hybrid_alns_engine import PackingAwareHybridALNSOptimizer;e=json.load(sys.stdin);q=json.loads(e["input"]);[(o.update(delivery_window_start_sec=e["window"][0],delivery_window_end_sec=e["window"][1])) for o in q["orders"]];print(PackingAwareHybridALNSOptimizer(FleetOptimizationRequest.model_validate(q),time_budget_seconds=2).solve().model_dump_json())'],
      { cwd: resolve('../optimizer'), input: JSON.stringify({ input: source.input, window }), encoding: 'utf8', windowsHide: true });
    if (solved.status !== 0) throw new Error(solved.stderr);
    const result: unknown = JSON.parse(solved.stdout);
    assertFleetOptimizationResult(result);
    expect(result.status).toBe('SUCCESS');
    const proposal = { ...source.proposal, result };
    await db.optimizationResult.create({ data: { optimizationJobId: finalJob.id, candidateNumber: 1, feasibilityStatus: 'FEASIBLE', objectiveBreakdown: {},
      resultSnapshot: { proposal, signature: signOptimizationProposal(proposal, secret) },
    } });
    await db.optimizationJob.update({ where: { id: finalJob.id }, data: { status: 'SUCCEEDED' } });
    const applied = await jobs.apply(owner, finalJob.id, 1);
    expect(applied.trips).toHaveLength(1);
    expect((await db.deliveryPlanningBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe('APPLIED');
    expect((await db.deliveryAppointment.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('SCHEDULED');
    expect(await db.deliveryCapacityHold.count({ where: { batchId: batch.id, status: 'HELD' } })).toBe(0);
    expect(await db.resourceReservation.count({ where: { tripId: applied.trips[0].id, status: 'HELD' } })).toBe(2);
    const stop = await db.tripStop.findFirstOrThrow({ where: { tripId: applied.trips[0].id, stopType: 'DELIVERY' } });
    expect(stop.plannedArrivalTime?.getTime()).toBeGreaterThanOrEqual(offer.windowStart.getTime());
    expect(stop.plannedArrivalTime?.getTime()).toBeLessThanOrEqual(offer.windowEnd.getTime());
  }, 60000);
});
