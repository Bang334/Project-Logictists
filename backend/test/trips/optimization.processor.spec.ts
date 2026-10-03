import { Role } from '@prisma/client';
import { OptimizationProcessor } from '../../src/trips/optimization.processor';

function persistedJob(status = 'PENDING') {
  return {
    id: 'job-1',
    branchId: 'branch-1',
    createdById: 'user-1',
    status,
    startedAt: null,
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
    optimizationResult: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const trips = { executeAutomaticOptimization: jest.fn() };
  const events = { emitOptimizationJobUpdate: jest.fn() };
  let processor: OptimizationProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new OptimizationProcessor(
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
  });

  it('discards a solver result that arrives after cancellation', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(persistedJob())
      .mockResolvedValueOnce({ status: 'CANCEL_REQUESTED' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockResolvedValue({
      proposal: { result: { status: 'SUCCESS' } },
      signature: 'signed',
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

  it('marks a transient worker failure for bounded retry', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockRejectedValue(new Error('Mapbox timeout'));
    prisma.optimizationJob.update.mockResolvedValue({});

    await expect(processor.process(queueJob() as never)).rejects.toThrow(
      'Mapbox timeout',
    );
    expect(prisma.optimizationJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'RETRYING',
        errorCode: 'OPTIMIZATION_FAILED',
      }),
    });
  });
});
