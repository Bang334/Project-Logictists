import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
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
  const prisma = {
    optimizationJob: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const trips = { applyAutomaticOptimization: jest.fn() };
  let service: OptimizationJobsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OptimizationJobsService(
      prisma as never,
      queue as never,
      trips as never,
    );
  });

  it('persists the business job before enqueueing its durable ID', async () => {
    prisma.optimizationJob.create.mockResolvedValue(job());
    queue.add.mockResolvedValue({ id: 'job-1' });

    const result = await service.create(
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      undefined,
    );

    expect(prisma.optimizationJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        branchId: 'branch-1',
        createdById: 'user-1',
        status: 'PENDING',
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(queue.add).toHaveBeenCalledWith(
      'run-automatic-optimization',
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1', attempts: 3 }),
    );
    expect(result).toMatchObject({ id: 'job-1', status: 'PENDING' });
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

  it('claims apply atomically so the same result cannot be published twice', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(
      job({
        status: 'SUCCEEDED',
        result: { proposal: { result: {} }, signature: 'x'.repeat(32) },
      }),
    );
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.apply(
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
        'job-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(trips.applyAutomaticOptimization).not.toHaveBeenCalled();
  });
});
