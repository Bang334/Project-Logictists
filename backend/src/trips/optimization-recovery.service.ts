import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  OPTIMIZATION_JOB_NAME,
  OPTIMIZATION_QUEUE,
} from './optimization-jobs.service';

@Injectable()
export class OptimizationRecoveryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OptimizationRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OPTIMIZATION_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap() {
    await this.recover();
    this.timer = setInterval(() => {
      void this.recover().catch((error: Error) =>
        this.logger.error('Optimization job recovery failed', error),
      );
    }, 5_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recover() {
    const now = new Date();
    const recoverable = await this.prisma.optimizationJob.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'RETRYING', 'CANCEL_REQUESTED'] } },
          { status: 'RUNNING', leaseUntil: { lt: now } },
        ],
      },
      select: { id: true, status: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });

    for (const job of recoverable) {
      if (job.status === 'RUNNING') {
        await this.prisma.optimizationJob.updateMany({
          where: { id: job.id, status: 'RUNNING', leaseUntil: { lt: now } },
          data: { status: 'RETRYING' },
        });
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
    }
    if (recoverable.length > 0)
      this.logger.debug(`Checked ${recoverable.length} recoverable optimization job(s)`);
  }
}
