import { BadRequestException, GatewayTimeoutException, Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { Role } from '@prisma/client';
import { OptimizationProcessor } from '../../src/trips/optimization.processor';
import { MapboxMatrixRateLimitException } from '../../src/mapbox/mapbox.service';

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
    $queryRaw: jest.fn(),
  };
  const trips = { executeAutomaticOptimization: jest.fn() };
  const events = { emitOptimizationJobUpdate: jest.fn() };
  let processor: OptimizationProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ stored: true }]);
    processor = new OptimizationProcessor(
      { principalForWorker: jest.fn().mockResolvedValue({ id: "user-1", username: "dispatcher", fullName: "Dispatcher", sessionId: "", grants: [] }) } as never,
      prisma as never,
      trips as never,
      events as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stops queue retries after bounded Mapbox rate-limit retries are exhausted', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockRejectedValue(new MapboxMatrixRateLimitException());
    await expect(processor.process(queueJob() as never)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', errorCode: 'HTTP_503' }),
    }));
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
        parameters: { branchId: 'branch-1', searchBudgetSeconds: 45, deliveryBatchId: 'delivery-batch-1' },
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
      expect.objectContaining({ searchBudgetSeconds: 45, deliveryBatchId: 'delivery-batch-1' }),
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

    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'CANCEL_REQUESTED', leaseOwner: expect.any(String) },
      data: expect.objectContaining({
        status: 'CANCELLED',
        result: expect.anything(),
      }),
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not announce completion when persistence rejects the lease', async () => {
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
    prisma.$queryRaw.mockResolvedValue([{ stored: false }]);

    await processor.process(queueJob() as never);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events.emitOptimizationJobUpdate).not.toHaveBeenCalledWith(
      'branch-1', { jobId: 'job-1', status: 'SUCCEEDED' },
    );
  });

  it('logs queue lag from the first claim even when solving takes longer', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-04T00:00:01.000Z') });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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
    trips.executeAutomaticOptimization.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
      return { best: candidates[0], candidates };
    });
    await processor.process(queueJob() as never);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('"queueLagSeconds":1,'));
  });

  it('waits for a pending lease heartbeat before sending another during pool pressure', async () => {
    jest.useFakeTimers();
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany
      .mockResolvedValue({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Pool timeout')), 30_000);
      }));

    trips.executeAutomaticOptimization.mockImplementation(async () => {
      await jest.advanceTimersByTimeAsync(35_000);
      expect(prisma.optimizationJob.updateMany).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(prisma.optimizationJob.updateMany).toHaveBeenCalledTimes(3);
      throw new BadRequestException('Invalid snapshot');
    });

    await expect(processor.process(queueJob() as never)).rejects.toThrow('Invalid snapshot');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledTimes(4);
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

  it('marks HTTP timeout as TIMEOUT and stops BullMQ retries with UnrecoverableError', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockRejectedValue(
      new GatewayTimeoutException('timeout of 120000ms exceeded'),
    );

    await expect(processor.process(queueJob() as never)).rejects.toThrow(
      UnrecoverableError,
    );
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'job-1',
        status: 'RUNNING',
        leaseOwner: expect.any(String),
      }),
      data: expect.objectContaining({
        status: 'TIMEOUT',
        errorCode: 'OPTIMIZER_HTTP_TIMEOUT',
        completedAt: expect.any(Date),
      }),
    });
    expect(events.emitOptimizationJobUpdate).toHaveBeenCalledWith(
      'branch-1',
      expect.objectContaining({ jobId: 'job-1', status: 'TIMEOUT' }),
    );
  });

  it('marks BadRequestException as FAILED immediately without retry', async () => {
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockRejectedValue(
      new BadRequestException('Invalid snapshot'),
    );

    await expect(processor.process(queueJob() as never)).rejects.toThrow(
      UnrecoverableError,
    );
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'job-1',
        status: 'RUNNING',
      }),
      data: expect.objectContaining({
        status: 'FAILED',
        errorCode: 'HTTP_400',
        completedAt: expect.any(Date),
      }),
    });
  });

  it('finalizes job as CANCELLED cleanly without BullMQ retry when aborted mid-execution', async () => {
    const { OptimizationCancelledError, OptimizationJobControlService } = await import('../../src/trips/optimization-job-control.service');
    const control = new OptimizationJobControlService();
    const ctrlProcessor = new OptimizationProcessor(
      { principalForWorker: jest.fn().mockResolvedValue({ id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: '', grants: [] }) } as never,
      prisma as never,
      trips as never,
      events as never,
      control,
    );
    prisma.optimizationJob.findUnique.mockResolvedValue(persistedJob());
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    trips.executeAutomaticOptimization.mockImplementation(async () => {
      control.abort('job-1');
      throw new OptimizationCancelledError();
    });

    await expect(ctrlProcessor.process(queueJob() as never)).resolves.toBeUndefined();
    expect(prisma.optimizationJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'job-1' }),
      data: expect.objectContaining({ status: 'CANCELLED' }),
    });
    expect(events.emitOptimizationJobUpdate).toHaveBeenCalledWith(
      'branch-1',
      expect.objectContaining({ jobId: 'job-1', status: 'CANCELLED' }),
    );
  });

  it('persists route cost breakdown fields inside each candidate objectiveBreakdown', async () => {
    prisma.optimizationJob.findUnique
      .mockResolvedValueOnce(persistedJob())
      .mockResolvedValueOnce({ status: 'RUNNING' });
    prisma.optimizationJob.updateMany.mockResolvedValue({ count: 1 });
    const candidate = {
      proposal: {
        result: {
          status: 'SUCCESS',
          total_cost_vnd: 1_500_000,
          total_distance_km: 120,
          total_duration_minutes: 90,
          routes: [],
          unassigned_orders: [],
          diagnostics: [],
          benchmarks: {
            or_tools: {
              method_name: 'Hybrid ALNS',
              description: 'test',
              total_cost_vnd: 1_500_000,
              total_distance_km: 120,
              total_duration_minutes: 90,
              vehicles_used: 2,
              fuel_cost_vnd: 500_000,
              vehicle_fixed_cost_vnd: 300_000,
              driver_cost_vnd: 600_000,
              cargo_holding_cost_vnd: 100_000,
              late_delivery_penalty_vnd: 0,
              is_feasible: true,
              violations: [],
            },
            direct_dedicated: {
              method_name: 'Direct',
              description: 'test',
              total_cost_vnd: 2_000_000,
              total_distance_km: 180,
              total_duration_minutes: 140,
              vehicles_used: 4,
              fuel_cost_vnd: 800_000,
              vehicle_fixed_cost_vnd: 400_000,
              driver_cost_vnd: 700_000,
              cargo_holding_cost_vnd: 100_000,
              late_delivery_penalty_vnd: 0,
              is_feasible: true,
              violations: [],
            },
            savings_vs_direct_vnd: 500_000,
            savings_vs_direct_percent: 25,
          },
        },
      },
      signature: 'signed',
      rank: 1,
      searchStrategy: 'Hybrid ALNS',
      improvementSequence: 1,
      solverObjective: 1_500_000,
      isBestFound: true,
    };
    trips.executeAutomaticOptimization.mockResolvedValue({
      best: candidate,
      candidates: [candidate],
    });

    await processor.process(queueJob() as never);

    const sqlCall = prisma.$queryRaw.mock.calls[0];
    const rows = JSON.parse(sqlCall[1] as string) as Array<{
      objectiveBreakdown: Record<string, unknown>;
    }>;
    expect(rows[0].objectiveBreakdown).toMatchObject({
      fuelCostVnd: 500_000,
      vehicleFixedCostVnd: 300_000,
      driverCostVnd: 600_000,
      cargoHoldingCostVnd: 100_000,
      lateDeliveryPenaltyVnd: 0,
    });
  });
});
