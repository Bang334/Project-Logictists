import { OptimizationJobMetricsService } from '../../src/trips/optimization-job-metrics.service';

describe('OptimizationJobMetricsService', () => {
  const now = new Date('2026-10-03T10:00:00.000Z');

  function buildService(overrides: {
    groups?: Array<{ status: string; _count: { _all: number } }>;
    oldestWaiting?: { createdAt: Date } | null;
    expiredLeases?: number;
    recent?: Array<{
      status: string;
      createdAt: Date;
      startedAt: Date | null;
      completedAt: Date | null;
    }>;
  }) {
    const prisma = {
      optimizationJob: {
        groupBy: jest.fn().mockResolvedValue(overrides.groups ?? []),
        findFirst: jest.fn().mockResolvedValue(overrides.oldestWaiting ?? null),
        count: jest.fn().mockResolvedValue(overrides.expiredLeases ?? 0),
        findMany: jest.fn().mockResolvedValue(overrides.recent ?? []),
      },
    };
    return {
      prisma,
      service: new OptimizationJobMetricsService(prisma as never),
    };
  }

  it('returns null averages and ages when there are no jobs, not zero', async () => {
    const { service } = buildService({});

    const snapshot = await service.getSnapshot(now);

    expect(snapshot.oldestWaitingJobAgeSeconds).toBeNull();
    expect(snapshot.recentJobs.averageQueueLagSeconds).toBeNull();
    expect(snapshot.recentJobs.averageDurationSeconds).toBeNull();
    expect(snapshot.recentJobs.sampleSize).toBe(0);
  });

  it('computes queue lag, duration, waiting age and expired leases', async () => {
    const { service, prisma } = buildService({
      groups: [
        { status: 'PENDING', _count: { _all: 2 } },
        { status: 'RUNNING', _count: { _all: 1 } },
      ],
      oldestWaiting: { createdAt: new Date('2026-10-03T09:58:00.000Z') },
      expiredLeases: 1,
      recent: [
        {
          status: 'SUCCEEDED',
          createdAt: new Date('2026-10-03T09:00:00.000Z'),
          startedAt: new Date('2026-10-03T09:00:10.000Z'),
          completedAt: new Date('2026-10-03T09:00:40.000Z'),
        },
        {
          status: 'TIMED_OUT',
          createdAt: new Date('2026-10-03T09:10:00.000Z'),
          startedAt: new Date('2026-10-03T09:10:30.000Z'),
          completedAt: new Date('2026-10-03T09:12:30.000Z'),
        },
        {
          status: 'FAILED',
          createdAt: new Date('2026-10-03T09:20:00.000Z'),
          startedAt: null,
          completedAt: new Date('2026-10-03T09:20:05.000Z'),
        },
      ],
    });

    const snapshot = await service.getSnapshot(now);

    expect(snapshot.statusCounts).toEqual({ PENDING: 2, RUNNING: 1 });
    expect(snapshot.oldestWaitingJobAgeSeconds).toBe(120);
    expect(snapshot.expiredLeaseRunningJobs).toBe(1);
    expect(snapshot.recentJobs.sampleSize).toBe(3);
    expect(snapshot.recentJobs.averageQueueLagSeconds).toBe(20);
    expect(snapshot.recentJobs.averageDurationSeconds).toBe(75);
    expect(snapshot.recentJobs.timedOutCount).toBe(1);
    expect(snapshot.recentJobs.failedCount).toBe(1);
    expect(prisma.optimizationJob.count).toHaveBeenCalledWith({
      where: { status: 'RUNNING', leaseUntil: { lt: now } },
    });
  });
});
