import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash } from 'crypto';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { OptimizationJobsService } from '../../src/trips/optimization-jobs.service';

const now = new Date('2026-10-03T00:00:00.000Z');

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    branchId: 'branch-1',
    status: 'PENDING',
    schemaVersion: '2',
    requestSnapshot: {},
    parameters: {
      progress: { stage: 'QUEUED', details: {}, updatedAt: now.toISOString() },
    },
    result: null,
    errorCode: null,
    errorMessage: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('OptimizationJobsService', () => {
  const queue = {
    add: jest.fn(),
    getJob: jest.fn(),
  };
  const outbox = { enqueue: jest.fn() };
  const prisma = {
    optimizationJob: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    optimizationResult: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const trips = { applyAutomaticOptimization: jest.fn() };
  let service: OptimizationJobsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.optimizationResult.findUnique.mockResolvedValue(null);
    prisma.optimizationResult.findMany.mockResolvedValue([]);
    service = new OptimizationJobsService(
      prisma as never,
      queue as never,
      trips as never,
      outbox as never,
    );
  });

  it('keeps a repeated cancellation pending until the worker confirms it stopped', async () => {
    const user = {
      id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1',
      role: Role.DISPATCHER,
      grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.plan'] }],
    } as Parameters<OptimizationJobsService['cancel']>[0];
    prisma.optimizationJob.findUnique.mockResolvedValue(job({ status: 'CANCEL_REQUESTED' }));

    await expect(service.cancel(user, 'job-1')).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' });
    expect(prisma.optimizationJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.optimizationJob.update).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('requests cancellation if a queued job is claimed during cancellation', async () => {
    const user = {
      id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1',
      role: Role.DISPATCHER,
      grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.plan'] }],
    } as Parameters<OptimizationJobsService['cancel']>[0];
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce(job({ status: 'RUNNING' }))
      .mockResolvedValueOnce(job({ status: 'CANCEL_REQUESTED' }));
    prisma.optimizationJob.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    await expect(service.cancel(user, 'job-1')).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' });
    expect(prisma.optimizationJob.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'job-1', status: 'RUNNING' },
      data: { status: 'CANCEL_REQUESTED', cancelledAt: expect.any(Date) },
    });
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('persists the job and durable enqueue event atomically', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      prisma.optimizationJob.create.mockResolvedValue(job({ idempotencyKey: 'idem-1' }));
      return callback(prisma);
    });
    outbox.enqueue.mockResolvedValue(undefined);

    const result = await service.create(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      { idempotencyKey: 'idem-1' },
    );

    expect(prisma.optimizationJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'branch-1',
        createdById: 'user-1',
        idempotencyKey: 'idem-1',
        status: 'PENDING',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateType: 'OptimizationJob',
        aggregateId: 'job-1',
        eventType: 'OPTIMIZATION_JOB_CREATED',
      }),
      prisma,
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'job-1', status: 'PENDING' });
    expect(result.progress).toMatchObject({ stage: 'QUEUED' });
  });

  it('persists the user-selected search budget in the idempotent job request', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      prisma.optimizationJob.create.mockResolvedValue(job({
        requestSnapshot: {
          branchId: 'branch-1',
          scheduleMode: null,
          customStartTime: null,
          searchBudgetSeconds: 90,
        },
      }));
      return callback(prisma);
    });
    outbox.enqueue.mockResolvedValue(undefined);

    const result = await service.create(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      { idempotencyKey: 'idem-budget', searchBudgetSeconds: 90 },
    );

    expect(prisma.optimizationJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestSnapshot: expect.objectContaining({ searchBudgetSeconds: 90 }),
        parameters: expect.objectContaining({ searchBudgetSeconds: 90 }),
      }),
    });
    expect(result).toMatchObject({ searchBudgetSeconds: 90 });
  });

  it('returns the existing job for the same idempotency key and payload', async () => {
    const existing = job({
      idempotencyKey: 'idem-1',
      requestHash: expect.any(String),
      requestSnapshot: {
        branchId: 'branch-1',
        scheduleMode: null,
        customStartTime: null,
        searchBudgetSeconds: null,
      },
    });
    const requestHash = createHash('sha256')
      .update(JSON.stringify(existing.requestSnapshot))
      .digest('hex');
    prisma.optimizationJob.findUnique.mockResolvedValue({ ...existing, requestHash });

    const result = await service.create(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      { idempotencyKey: 'idem-1' },
    );

    expect(result).toMatchObject({ id: 'job-1' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reusing an idempotency key with a different payload', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(
      job({ idempotencyKey: 'idem-1', requestHash: 'different' }),
    );

    await expect(
      service.create(
        { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
        { idempotencyKey: 'idem-1', scheduleMode: 'NEXT_DAY' as never },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects reading a job belonging to another branch', async () => {
    prisma.$queryRaw.mockResolvedValue([job({ branchId: 'branch-2' })]);

    await expect(
      service.get(
        { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
        'job-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delegates the apply claim to the transaction that creates trips', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(
      job({
        status: 'SUCCEEDED',
        result: { proposal: { result: {} }, signature: 'x'.repeat(32) },
      }),
    );
    trips.applyAutomaticOptimization.mockRejectedValue(
      new ConflictException('Optimization job đang được áp dụng'),
    );

    await expect(
      service.apply(
        { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
        'job-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(trips.applyAutomaticOptimization).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'job-1',
      1,
    );
    expect(prisma.optimizationJob.updateMany).not.toHaveBeenCalled();
  });

  it('lets the trip transaction finalize APPLIED instead of updating the job afterward', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(
      job({
        status: 'SUCCEEDED',
        result: { proposal: { result: {} }, signature: 'x'.repeat(32) },
      }),
    );
    trips.applyAutomaticOptimization.mockResolvedValue({ trips: [{ id: 'trip-1' }] });

    const result = await service.apply(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      'job-1',
    );

    expect(trips.applyAutomaticOptimization).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'job-1',
      1,
    );
    expect(prisma.optimizationJob.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    );
    expect(result).toMatchObject({ jobId: 'job-1', status: 'APPLIED' });
  });

  it('applies the explicitly selected candidate instead of silently using rank 1', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(
      job({
        status: 'SUCCEEDED',
        result: { proposal: { result: { marker: 'rank-1' } }, signature: 'rank-1' },
      }),
    );
    prisma.optimizationResult.findUnique.mockResolvedValue({
      resultSnapshot: {
        proposal: { result: { marker: 'rank-3' } },
        signature: 'rank-3',
      },
    });
    trips.applyAutomaticOptimization.mockResolvedValue({ trips: [{ id: 'trip-3' }] });

    await service.apply(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      'job-1',
      3,
    );

    expect(prisma.optimizationResult.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          optimizationJobId_candidateNumber: {
            optimizationJobId: 'job-1',
            candidateNumber: 3,
          },
        },
      }),
    );
    expect(trips.applyAutomaticOptimization).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal: expect.objectContaining({ result: { marker: 'rank-3' } }),
        signature: 'rank-3',
      }),
      expect.anything(),
      'job-1',
      3,
    );
  });

  it('hides a historical partial result and refuses to apply it', async () => {
    const user = { id: 'dispatcher', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 's',
      branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH' as const,
        branchId: 'branch-1', permissions: ['trips.read', 'trips.plan'] }] };
    const partial = job({ status: 'PARTIAL', result: { proposal: { result: {
      status: 'PARTIAL', unassigned_orders: [{ order_id: 'missing' }],
    } } }, summaries: [{ candidateNumber: 1, feasibilityStatus: 'PARTIAL', objectiveBreakdown: {} }] });
    prisma.$queryRaw.mockResolvedValueOnce([partial]);
    prisma.optimizationJob.findUnique.mockResolvedValue(partial);
    expect(await service.get(user, 'job-1')).toMatchObject({ candidates: [], result: null });
    await expect(service.apply(user, 'job-1')).rejects.toThrow(ConflictException);
    expect(trips.applyAutomaticOptimization).not.toHaveBeenCalled();
  });

  it('exports ranked candidates and route details as an Excel workbook', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(job({ status: 'SUCCEEDED' }));
    prisma.optimizationResult.findMany.mockResolvedValue([
      {
        candidateNumber: 1,
        feasibilityStatus: 'FEASIBLE',
        objectiveBreakdown: {
          totalCostVnd: 7_796_170,
          totalDistanceKm: 895.34,
          totalDurationMinutes: 2094.9,
          routeCount: 7,
          unassignedOrderCount: 0,
        },
        resultSnapshot: {
          proposal: {
            result: {
              status: "SUCCESS", unassigned_orders: [],
              routes: [
                {
                  service_day_index: 0,
                  plate_number: '29C-001.23',
                  driver_name: 'Tài xế A',
                  total_distance_km: 120.5,
                  total_duration_minutes: 240,
                  cost: { total_cost_vnd: 1_000_000 },
                  stops: [
                    { stop_type: 'PICKUP', order_id: 'ORD-001' },
                    { stop_type: 'DELIVERY', order_id: 'ORD-001' },
                  ],
                },
              ],
            },
          },
          signature: 'signed',
        },
      },
    ]);

    const exported = await service.exportCandidates(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      'job-1',
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from(exported.buffer));

    expect(exported.filename).toMatch(/\.xlsx$/);
    expect(workbook.getWorksheet('Chuỗi nghiệm cải thiện')?.getCell('D2').value).toBe(7_796_170);
    expect(workbook.getWorksheet('Chi tiết tuyến')?.getCell('D2').value).toBe('29C-001.23');
    expect(workbook.getWorksheet('Chi tiết tuyến')?.getCell('I2').value).toContain('ORD-001');
  });

  it('restores the latest restorable job for the scoped branch and skips failed/cancelled jobs', async () => {
    const user = {
      id: 'user-1',
      username: 'dispatcher',
      fullName: 'Dispatcher',
      sessionId: 'session',
      branchId: 'branch-1',
      role: Role.DISPATCHER,
      grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH' as const, branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }],
    };
    prisma.$queryRaw.mockResolvedValue([job({
      id: 'job-latest', status: 'SUCCEEDED', result: { proposal: { result: { status: 'SUCCESS', unassigned_orders: [], total_cost_vnd: 123 } } },
      summaries: [{ candidateNumber: 1, feasibilityStatus: 'FEASIBLE',
        objectiveBreakdown: { totalCostVnd: 123, routeCount: 1, unassignedOrderCount: 0 } }],
    })]);
    const restored = await service.getLatestRestorable(user, undefined);
    const filter = prisma.$queryRaw.mock.calls[0][1];
    expect(filter.values).toEqual(['branch-1']);
    expect(filter.sql).toContain('WHERE j."branchId" = ?');
    expect(filter.sql).toContain("j.status IN ('PENDING','RUNNING','RETRYING','CANCEL_REQUESTED','SUCCEEDED','APPLIED')");
    expect(filter.sql).toContain('ORDER BY j."createdAt" DESC, j.id DESC LIMIT 1');
    expect(restored).toMatchObject({
      id: 'job-latest',
      status: 'SUCCEEDED',
      result: { total_cost_vnd: 123 },
      candidates: [expect.objectContaining({ candidateNumber: 1, totalCostVnd: 123 })],
    });

    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.getLatestRestorable(user, undefined)).resolves.toBeNull();
  });

  it('rejects getLatestRestorable for a branch outside user scope', async () => {
    await expect(
      service.getLatestRestorable(
        {
          id: 'user-1',
          username: 'dispatcher',
          fullName: 'Dispatcher',
          sessionId: 'session',
          branchId: 'branch-1',
          role: Role.DISPATCHER,
          grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan'] }],
        },
        'branch-2',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('supersedes stale branch-wide jobs when creating a new branch optimization job', async () => {
    const removeOld = jest.fn().mockResolvedValue(undefined);
    const jobControl = { abort: jest.fn(), notifyPythonCancel: jest.fn().mockResolvedValue(undefined) };
    const events = { emitOptimizationJobUpdate: jest.fn() };
    const svc = new OptimizationJobsService(
      prisma as never,
      queue as never,
      trips as never,
      outbox as never,
      undefined,
      jobControl as never,
      events as never,
    );
    prisma.optimizationJob.findUnique.mockResolvedValue(null);
    prisma.optimizationJob.findMany.mockResolvedValue([
      { id: 'old-pending', status: 'PENDING', parameters: { branchId: 'branch-1' } },
      { id: 'old-running', status: 'RUNNING', parameters: { branchId: 'branch-1' } },
      { id: 'batch-job', status: 'PENDING', parameters: { branchId: 'branch-1', deliveryBatchId: 'b1' } },
    ]);
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    queue.getJob.mockResolvedValue({ remove: removeOld });
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      prisma.optimizationJob.create.mockResolvedValue(job({ id: 'job-new', idempotencyKey: 'idem-new' }));
      return callback(prisma);
    });
    outbox.enqueue.mockResolvedValue(undefined);

    await svc.create(
      { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan'] }] },
      { idempotencyKey: 'idem-new' },
    );

    expect(removeOld).toHaveBeenCalledTimes(1);
    expect(jobControl.abort).toHaveBeenCalledWith('old-running');
    expect(jobControl.notifyPythonCancel).toHaveBeenCalledWith('old-running');
    expect(events.emitOptimizationJobUpdate).toHaveBeenCalledWith('branch-1', { jobId: 'old-pending', status: 'CANCELLED' });
    expect(events.emitOptimizationJobUpdate).toHaveBeenCalledWith('branch-1', { jobId: 'old-running', status: 'CANCEL_REQUESTED' });
  });

  it('includes per-candidate costBreakdown from both objectiveBreakdown and SQL projection fallback', async () => {
    const user = {
      id: 'user-1',
      username: 'dispatcher',
      fullName: 'Dispatcher',
      sessionId: 'session',
      branchId: 'branch-1',
      role: Role.DISPATCHER,
      grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH' as const, branchId: 'branch-1', permissions: ['trips.read', 'trips.plan'] }],
    };
    prisma.$queryRaw.mockResolvedValueOnce([
      job({
        status: 'SUCCEEDED',
        result: { proposal: { result: { status: 'SUCCESS', unassigned_orders: [], total_cost_vnd: 47_590_879 } } },
        summaries: [
          {
            candidateNumber: 1,
            feasibilityStatus: 'FEASIBLE',
            objectiveBreakdown: {
              totalCostVnd: 47_590_879,
              fuelCostVnd: 21_466_310,
              vehicleFixedCostVnd: 2_550_000,
              driverCostVnd: 22_529_295,
              cargoHoldingCostVnd: 1_045_274,
              lateDeliveryPenaltyVnd: 0,
              unassignedOrderCount: 0,
            },
          },
          {
            candidateNumber: 2,
            feasibilityStatus: 'FEASIBLE',
            objectiveBreakdown: { totalCostVnd: 48_186_743, unassignedOrderCount: 0 },
            costBreakdown: {
              fuelCostVnd: 21_700_000,
              vehicleFixedCostVnd: 2_650_000,
              driverCostVnd: 22_750_000,
              cargoHoldingCostVnd: 1_086_743,
              lateDeliveryPenaltyVnd: 0,
            },
          },
          {
            candidateNumber: 3,
            feasibilityStatus: 'FEASIBLE',
            objectiveBreakdown: { totalCostVnd: 50_000_000, unassignedOrderCount: 0 },
            costBreakdown: {
              fuelCostVnd: null,
              vehicleFixedCostVnd: null,
              driverCostVnd: null,
              cargoHoldingCostVnd: null,
              lateDeliveryPenaltyVnd: null,
            },
          },
        ],
      }),
    ]);

    const loaded = await service.get(user, 'job-1');
    expect(loaded.candidates[0].costBreakdown).toEqual({
      fuelCostVnd: 21_466_310,
      vehicleFixedCostVnd: 2_550_000,
      driverCostVnd: 22_529_295,
      cargoHoldingCostVnd: 1_045_274,
      lateDeliveryPenaltyVnd: 0,
    });
    expect(loaded.candidates[1].costBreakdown).toEqual({
      fuelCostVnd: 21_700_000,
      vehicleFixedCostVnd: 2_650_000,
      driverCostVnd: 22_750_000,
      cargoHoldingCostVnd: 1_086_743,
      lateDeliveryPenaltyVnd: 0,
    });
    expect(loaded.candidates[2].costBreakdown).toBeUndefined();
  });
});
