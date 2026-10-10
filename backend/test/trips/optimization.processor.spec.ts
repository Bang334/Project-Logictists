import { Role } from '@prisma/client';
import { OptimizationProcessor } from '../../src/trips/optimization.processor';

function persistedJob(status = 'PENDING') {
  return {
    id: 'job-1',
    branchId: 'branch-1',
    createdById: 'user-1',
    status,
    startedAt: null,
    createdAt: new Date('2026-10-04T00:00:00.000Z'),
    attemptCount: 0,
    parameters: { branchId: 'branch-1' },
    createdBy: { role: Role.DISPATCHER },
  };
}

function queueJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'run-automatic-optimization',
    data: { jobId: 'job-1' },
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides,
  };
}

describe('OptimizationProcessor', () => {
  const prisma = {
    optimizationJob: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    optimizationResult: { createMany: jest.fn(), deleteMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const trips = { executeAutomaticOptimization: jest.fn() };
  const events = { emitOptimizationJobUpdate: jest.fn() };
  let processor: OptimizationProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new OptimizationProcessor(
      { principalForWorker: jest.fn().mockResolvedValue({ id: "user-1", username: "dispatcher", fullName: "Dispatcher", sessionId: "", grants: [] }) } as never,
      prisma as never,
      trips as never,
      events as never,
    );
  });

  it('allows only one worker to claim the PostgreSQL job', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 0 });

    await processor.process(queueJob() as never);

    expect(trips.executeAutomaticOptimization).not.toHaveBeenCalled();
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          OR: expect.arrayContaining([
            { status: { in: ['PENDING', 'RETRYING'] } },
            expect.objectContaining({ status: 'RUNNING' }),
          ]),
        }),
        data: expect.objectContaining({ leaseOwner: expect.any(String) }),
      }),
    );
  });

  it('passes the persisted search budget to the optimization pipeline', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce({
        ...persistedJob(),
        parameters: { branchId: 'branch-1', searchBudgetSeconds: 45 },
      })
      .mockResolvedValueOnce({ status: 'CANCEL_REQUESTED' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockResolvedValue({
      best: { proposal: { result: { status: 'SUCCESS' } }, signature: 'signed' },
      candidates: [],
    });
    prisma.optimizationJob.update.mockResolvedValue({});

    await processor.process(queueJob() as never);

    expect(trips.executeAutomaticOptimization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ searchBudgetSeconds: 45 }),
      'job-1',
      expect.any(Function),
    );
  });

  it('discards a solver result that arrives after cancellation', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(persistedJob())
      .mockResolvedValueOnce({ status: 'CANCEL_REQUESTED' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    const candidate = {
      proposal: { result: { status: 'SUCCESS' } },
      signature: 'signed',
      improvementSequence: 1,
      solverObjective: 100,
      isBestFound: true,
    };
    trips.executeAutomaticOptimization.mockResolvedValue({
      best: candidate,
      candidates: [candidate],
    });
    prisma.optimizationJob.update.mockResolvedValue({});

    await processor.process(queueJob() as never);

    expect(prisma.optimizationJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'CANCELLED',
        result: expect.anything(),
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not let a worker write a result after losing its lease', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(persistedJob())
      .mockResolvedValueOnce({ status: 'RUNNING' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    const candidate = {
      proposal: {
        result: {
          status: 'SUCCESS',
          total_cost_vnd: 100,
          total_distance_km: 10,
          total_duration_minutes: 20,
          routes: [],
          unassigned_orders: [],
          diagnostics: [],
        },
      },
      signature: 'signed',
      improvementSequence: 1,
      solverObjective: 100,
      isBestFound: true,
    };
    trips.executeAutomaticOptimization.mockResolvedValue({
      best: candidate,
      candidates: [candidate],
    });
    const tx = {
      optimizationJob: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      optimizationResult: { createMany: jest.fn(), deleteMany: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await processor.process(queueJob() as never);

    expect(tx.optimizationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          status: 'RUNNING',
          leaseOwner: expect.any(String),
        }),
      }),
    );
    expect(tx.optimizationResult.createMany).not.toHaveBeenCalled();
  });

  it('persists every ranked candidate and keeps the first candidate as the job result', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(persistedJob())
      .mockResolvedValueOnce({ status: 'RUNNING' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    const candidate = (cost: number, improvementSequence: number) => ({
      proposal: {
        result: {
          status: 'SUCCESS',
          total_cost_vnd: cost,
          total_distance_km: cost / 10,
          total_duration_minutes: 20,
          routes: [],
          unassigned_orders: [],
          diagnostics: [],
        },
      },
      signature: `signed-${improvementSequence}`,
      improvementSequence,
      solverObjective: cost * 1_000_000,
      isBestFound: improvementSequence === 2,
    });
    const candidates = [candidate(100, 2), candidate(120, 7)];
    trips.executeAutomaticOptimization.mockResolvedValue({
      best: candidates[0],
      candidates,
    });
    const tx = {
      optimizationJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      optimizationResult: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await processor.process(queueJob() as never);

    expect(tx.optimizationResult.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ candidateNumber: 1 }),
        expect.objectContaining({ candidateNumber: 2 }),
      ],
    });
  });

  it('persists and broadcasts meaningful progress reported by the optimization pipeline', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(persistedJob())
      .mockResolvedValueOnce({ status: 'RUNNING' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockImplementation(
      async (
        _user: unknown,
        _dto: unknown,
        _jobId: string,
        reportProgress: (update: {
          stage: string;
          details: { orderCount: number; packageCount: number };
        }) => Promise<void>,
      ) => {
        await reportProgress({
          stage: 'SEARCHING_SOLUTIONS',
          details: { orderCount: 16, packageCount: 297 },
        });
        return {
          best: {
            proposal: {
              result: {
                status: 'SUCCESS',
                total_cost_vnd: 100,
                total_distance_km: 10,
                total_duration_minutes: 20,
                routes: [],
                unassigned_orders: [],
                diagnostics: [],
              },
            },
            signature: 'signed',
            improvementSequence: 1,
            solverObjective: 100,
            isBestFound: true,
          },
          candidates: [],
        };
      },
    );
    const tx = {
      optimizationJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      optimizationResult: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );

    await processor.process(queueJob() as never);

    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parameters: expect.objectContaining({
            progress: expect.objectContaining({
              stage: 'SEARCHING_SOLUTIONS',
              details: expect.objectContaining({ orderCount: 16, packageCount: 297 }),
            }),
          }),
        }),
      }),
    );
    expect(events.emitOptimizationJobUpdate).toHaveBeenCalledWith(
      'branch-1',
      expect.objectContaining({ jobId: 'job-1', status: 'RUNNING' }),
    );
  });

  it('marks a transient worker failure for bounded retry', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockRejectedValue(new Error('Mapbox timeout'));
    prisma.optimizationJob.update.mockResolvedValue({});

    await expect(processor.process(queueJob() as never)).rejects.toThrow(
      'Mapbox timeout',
    );
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'job-1',
        status: 'RUNNING',
        leaseOwner: expect.any(String),
      }),
      data: expect.objectContaining({
        status: 'RETRYING',
        errorCode: 'OPTIMIZATION_FAILED',
      }),
    });
  });
});
