import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import {
  OPTIMIZATION_JOB_NAME,
  OPTIMIZATION_QUEUE,
} from './optimization-jobs.service';

const RECOVERY_POLL_INTERVAL_MS = 15_000;
const PENDING_OUTBOX_GRACE_MS = 20_000;
const ACTIVE_QUEUE_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

@Injectable()
export class OptimizationRecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OptimizationRecoveryService.name);
  private timer?: NodeJS.Timeout;
  private recovering = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OPTIMIZATION_QUEUE) private readonly queue: Queue,
    @Optional() private readonly events?: EventsGateway,
  ) {}

  async onApplicationBootstrap() {
    await this.recover(true);
    this.timer = setInterval(() => {
      void this.recover(false).catch((error: Error) =>
        this.logger.error('Optimization job recovery failed', error),
      );
    }, RECOVERY_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async recover(isBootstrap = false) {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const now = new Date();
      const pendingBefore = isBootstrap
        ? now
        : new Date(now.getTime() - PENDING_OUTBOX_GRACE_MS);

      const abandonedCancels = await this.prisma.optimizationJob.findMany({
        where: {
          status: 'CANCEL_REQUESTED',
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        },
        select: { id: true, branchId: true },
        take: 100,
      });

      let finalizedCancelCount = 0;
      for (const cancelledJob of abandonedCancels) {
        const queuedJob = await this.queue.getJob(cancelledJob.id).catch(() => undefined);
        const state = queuedJob ? await queuedJob.getState().catch(() => null) : null;
        if (state === 'active' && !isBootstrap) {
          continue;
        }
        if (queuedJob && state !== 'active') {
          await queuedJob.remove().catch(() => undefined);
        }
        const updated = await this.prisma.optimizationJob.updateMany({
          where: { id: cancelledJob.id, status: 'CANCEL_REQUESTED' },
          data: {
            status: 'CANCELLED',
            completedAt: now,
            leaseUntil: null,
            leaseOwner: null,
          },
        });
        if (updated.count === 1) {
          finalizedCancelCount += 1;
          this.events?.emitOptimizationJobUpdate(cancelledJob.branchId, {
            jobId: cancelledJob.id,
            status: 'CANCELLED',
          });
        }
      }

      const recoverable = await this.prisma.optimizationJob.findMany({
        where: {
          OR: [
            { status: 'RETRYING' },
            { status: 'PENDING', updatedAt: { lt: pendingBefore } },
            { status: 'RUNNING', leaseUntil: { lt: now } },
          ],
        },
        select: { id: true, status: true },
        take: 100,
        orderBy: { createdAt: 'asc' },
      });

      let recoveredCount = 0;
      for (const job of recoverable) {
        if (job.status === 'RUNNING') {
          await this.prisma.optimizationJob.updateMany({
            where: { id: job.id, status: 'RUNNING', leaseUntil: { lt: now } },
            data: { status: 'RETRYING', leaseUntil: null, leaseOwner: null },
          });
        }
        const existing = await this.queue.getJob(job.id).catch(() => undefined);
        if (existing) {
          const state = await existing.getState().catch(() => null);
          if (state && ACTIVE_QUEUE_STATES.has(state)) {
            continue;
          }
          // Completed/failed BullMQ remnants block queue.add with the same jobId.
          await existing.remove().catch(() => undefined);
        }
        await this.queue
          .add(
            OPTIMIZATION_JOB_NAME,
            { jobId: job.id },
            {
              jobId: job.id,
              attempts: 3,
              backoff: { type: 'exponential', delay: 2_000 },
              removeOnComplete: 100,
              removeOnFail: 500,
            },
          )
          .catch((error: Error) => {
            if (!error.message.toLowerCase().includes('jobid')) throw error;
          });
        recoveredCount += 1;
      }

      if (recoveredCount > 0 || finalizedCancelCount > 0) {
        this.logger.debug(
          `Recovered ${recoveredCount} optimization job(s); finalized ${finalizedCancelCount} cancelled job(s)`,
        );
      }
    } finally {
      this.recovering = false;
    }
  }
}
