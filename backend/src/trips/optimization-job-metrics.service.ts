import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface OptimizationJobMetricsSnapshot {
  generatedAt: string;
  statusCounts: Record<string, number>;
  oldestWaitingJobAgeSeconds: number | null;
  expiredLeaseRunningJobs: number;
  recentJobs: {
    sampleSize: number;
    averageQueueLagSeconds: number | null;
    averageDurationSeconds: number | null;
    timedOutCount: number;
    partialCount: number;
    infeasibleCount: number;
    failedCount: number;
  };
}

const WAITING_STATUSES = ['PENDING', 'RETRYING'];
const RECENT_SAMPLE_SIZE = 100;

function secondsBetween(later: Date, earlier: Date): number {
  return Math.max(0, (later.getTime() - earlier.getTime()) / 1000);
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
}

/**
 * Tổng hợp chỉ số vận hành của optimization worker từ PostgreSQL (nguồn sự thật).
 * Chỉ trả đếm và thời gian; không trả payload, snapshot hay dữ liệu liên hệ.
 */
@Injectable()
export class OptimizationJobMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSnapshot(now: Date = new Date()): Promise<OptimizationJobMetricsSnapshot> {
    const [statusGroups, oldestWaiting, expiredLeaseRunningJobs, recentJobs] = await Promise.all([
      this.prisma.optimizationJob.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.optimizationJob.findFirst({
        where: { status: { in: WAITING_STATUSES } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.optimizationJob.count({
        where: { status: 'RUNNING', leaseUntil: { lt: now } },
      }),
      this.prisma.optimizationJob.findMany({
        where: { completedAt: { not: null } },
        orderBy: { completedAt: 'desc' },
        take: RECENT_SAMPLE_SIZE,
        select: { status: true, createdAt: true, startedAt: true, completedAt: true },
      }),
    ]);

    const queueLags: number[] = [];
    const durations: number[] = [];
    for (const job of recentJobs) {
      if (!job.startedAt || !job.completedAt) continue;
      queueLags.push(secondsBetween(job.startedAt, job.createdAt));
      durations.push(secondsBetween(job.completedAt, job.startedAt));
    }
    const countStatus = (status: string) =>
      recentJobs.filter((job) => job.status === status).length;

    return {
      generatedAt: now.toISOString(),
      statusCounts: Object.fromEntries(
        statusGroups.map((group) => [group.status, group._count._all]),
      ),
      oldestWaitingJobAgeSeconds: oldestWaiting
        ? Math.round(secondsBetween(now, oldestWaiting.createdAt))
        : null,
      expiredLeaseRunningJobs,
      recentJobs: {
        sampleSize: recentJobs.length,
        averageQueueLagSeconds: averageOrNull(queueLags),
        averageDurationSeconds: averageOrNull(durations),
        timedOutCount: countStatus('TIMED_OUT'),
        partialCount: countStatus('PARTIAL'),
        infeasibleCount: countStatus('INFEASIBLE'),
        failedCount: countStatus('FAILED'),
      },
    };
  }
}
