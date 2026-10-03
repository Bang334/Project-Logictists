import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { createHash } from 'crypto';
import { OptimizationJobsService } from '../../src/trips/optimization-jobs.service';

const now = new Date('2026-10-03T00:00:00.000Z');

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    branchId: 'branch-1',
    status: 'PENDING',
    schemaVersion: '2',
    requestSnapshot: {},
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
    $transaction: jest.fn(),
  };
  const trips = { applyAutomaticOptimization: jest.fn() };
  let service: OptimizationJobsService;

  beforeEach(() => {
    jest.clearAllMocks();
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
    );
    expect(prisma.optimizationJob.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'APPLIED' }) }),
    );
    expect(result).toMatchObject({ jobId: 'job-1', status: 'APPLIED' });
  });
});
