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
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    optimizationResult: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
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

  it('persists the job and durable enqueue event atomically', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      prisma.optimizationJob.create.mockResolvedValue(job({ idempotencyKey: 'idem-1' }));
      return callback(prisma);
    });
    outbox.enqueue.mockResolvedValue(undefined);

    const result = await service.create(
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
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

  it('returns the existing job for the same idempotency key and payload', async () => {
    const existing = job({
      idempotencyKey: 'idem-1',
      requestHash: expect.any(String),
      requestSnapshot: {
        branchId: 'branch-1',
        scheduleMode: null,
        customStartTime: null,
      },
    });
    const requestHash = createHash('sha256')
      .update(JSON.stringify(existing.requestSnapshot))
      .digest('hex');
    prisma.optimizationJob.findUnique.mockResolvedValue({ ...existing, requestHash });

    const result = await service.create(
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
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
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
        { idempotencyKey: 'idem-1', scheduleMode: 'NEXT_DAY' as never },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects reading a job belonging to another branch', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(job({ branchId: 'branch-2' }));

    await expect(
      service.get(
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
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
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
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
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
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
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
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
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      'job-1',
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from(exported.buffer));

    expect(exported.filename).toMatch(/\.xlsx$/);
    expect(workbook.getWorksheet('Chuỗi nghiệm cải thiện')?.getCell('D2').value).toBe(7_796_170);
    expect(workbook.getWorksheet('Chi tiết tuyến')?.getCell('D2').value).toBe('29C-001.23');
    expect(workbook.getWorksheet('Chi tiết tuyến')?.getCell('I2').value).toContain('ORD-001');
  });
});
