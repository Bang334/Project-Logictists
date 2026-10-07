import { AuthService } from '../auth/auth.service';
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { TripsService } from './trips.service';
import {
  OPTIMIZATION_JOB_NAME,
  OPTIMIZATION_QUEUE,
} from './optimization-jobs.service';
import { RunAutomaticOptimizationDto } from './dto/run-automatic-optimization.dto';
import {
  OptimizationProgressDetails,
  OptimizationProgressUpdate,
} from './optimization-progress';

type QueuePayload = { jobId: string };

@Processor(OPTIMIZATION_QUEUE, { concurrency: 1 })
export class OptimizationProcessor extends WorkerHost {
  private readonly logger = new Logger(OptimizationProcessor.name);
  private readonly workerId = `optimizer-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly tripsService: TripsService,
    private readonly events: EventsGateway,
  ) {
    super();
  }

  async process(job: Job<QueuePayload, unknown, string>): Promise<void> {
    if (job.name !== OPTIMIZATION_JOB_NAME) {
      throw new Error(`Unknown optimization queue job: ${job.name}`);
    }
    const optimizationJob = await this.prisma.optimizationJob.findUnique({
      where: { id: job.data.jobId },
      include: { createdBy: true },
    });
    if (!optimizationJob || ['CANCELLED', 'APPLIED'].includes(optimizationJob.status)) return;
    if (optimizationJob.status === 'CANCEL_REQUESTED') {
      await this.prisma.optimizationJob.update({
        where: { id: optimizationJob.id },
        data: { status: 'CANCELLED', completedAt: new Date(), leaseUntil: null },
      });
      this.emitStatus(optimizationJob.branchId, optimizationJob.id, 'CANCELLED');
      return;
    }

    const request = (
      optimizationJob.parameters &&
      typeof optimizationJob.parameters === 'object' &&
      !Array.isArray(optimizationJob.parameters)
        ? optimizationJob.parameters
        : {}
    ) as Prisma.JsonObject;
    let latestProgressDetails: OptimizationProgressDetails = {};
    const progressParameters = (
      update: OptimizationProgressUpdate,
    ): Prisma.InputJsonValue => ({
      ...request,
      progress: {
        stage: update.stage,
        details: latestProgressDetails,
        updatedAt: new Date().toISOString(),
      },
    });

    const leaseUntil = new Date(Date.now() + 5 * 60 * 1000);
    const claimed = await this.prisma.optimizationJob.updateMany({
      where: {
        id: optimizationJob.id,
        OR: [
          { status: { in: ['PENDING', 'RETRYING'] } },
          { status: 'RUNNING', leaseUntil: { lt: new Date() } },
        ],
      },
      data: {
        status: 'RUNNING',
        parameters: progressParameters({ stage: 'LOADING_INPUT' }),
        startedAt: optimizationJob.startedAt ?? new Date(),
        attemptCount: { increment: 1 },
        leaseUntil,
        leaseOwner: this.workerId,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (claimed.count !== 1) return;
    this.emitStatus(optimizationJob.branchId, optimizationJob.id, 'RUNNING');

    const heartbeat = setInterval(() => {
      void this.prisma.optimizationJob
        .updateMany({
          where: {
            id: optimizationJob.id,
            status: 'RUNNING',
            leaseOwner: this.workerId,
          },
          data: { leaseUntil: new Date(Date.now() + 5 * 60 * 1000) },
        })
        .catch((error: Error) =>
          this.logger.warn(`Lease heartbeat failed for ${optimizationJob.id}: ${error.message}`),
        );
    }, 60_000);
    heartbeat.unref();

    const reportProgress = async (update: OptimizationProgressUpdate) => {
      latestProgressDetails = {
        ...latestProgressDetails,
        ...(update.details ?? {}),
      };
      try {
        const changed = await this.prisma.optimizationJob.updateMany({
          where: {
            id: optimizationJob.id,
            status: 'RUNNING',
            leaseOwner: this.workerId,
          },
          data: {
            parameters: progressParameters(update),
          },
        });
        if (changed.count === 1) {
          this.emitStatus(optimizationJob.branchId, optimizationJob.id, 'RUNNING');
        }
      } catch (error) {
        this.logger.warn(
          `Không thể cập nhật tiến độ job ${optimizationJob.id}: ${this.errorMessage(error)}`,
        );
      }
    };

    const dto: RunAutomaticOptimizationDto = {
      idempotencyKey: optimizationJob.id,
      branchId: optimizationJob.branchId,
      ...(typeof request.scheduleMode === 'string'
        ? { scheduleMode: request.scheduleMode as RunAutomaticOptimizationDto['scheduleMode'] }
        : {}),
      ...(typeof request.customStartTime === 'string'
        ? { customStartTime: request.customStartTime }
        : {}),
    };

    try {
      const candidateBatch = await this.tripsService.executeAutomaticOptimization(
        await this.auth.principalForWorker(optimizationJob.createdById),
        dto,
        optimizationJob.id,
        reportProgress,
      );
      await reportProgress({
        stage: 'SAVING_RESULTS',
        details: latestProgressDetails,
      });
      const latest = await this.prisma.optimizationJob.findUnique({
        where: { id: optimizationJob.id },
        select: { status: true },
      });
      if (latest?.status === 'CANCEL_REQUESTED') {
        await this.prisma.optimizationJob.update({
          where: { id: optimizationJob.id },
          data: {
            status: 'CANCELLED',
            completedAt: new Date(),
            leaseUntil: null,
            leaseOwner: null,
            result: Prisma.JsonNull,
          },
        });
        this.emitStatus(optimizationJob.branchId, optimizationJob.id, 'CANCELLED');
        return;
      }

      const storedResult = candidateBatch.best;
      const solverStatus = storedResult.proposal.result.status;
      const status =
        solverStatus === 'SUCCESS'
          ? 'SUCCEEDED'
          : solverStatus === 'ERROR'
            ? 'FAILED'
            : solverStatus;
      // Rows are built before opening the transaction and written in one
      // statement: snapshots carry Mapbox geometry, so sequential inserts
      // exceeded Prisma's 5s default and BullMQ re-ran the whole solve.
      const candidateRows = candidateBatch.candidates.map(
        (candidate, index): Prisma.OptimizationResultCreateManyInput => {
          const result = candidate.proposal.result;
          return {
            optimizationJobId: optimizationJob.id,
            candidateNumber: index + 1,
            resultSnapshot: candidate as unknown as Prisma.InputJsonValue,
            feasibilityStatus: this.feasibilityStatus(result.status),
            objectiveBreakdown: {
              rank: candidate.rank ?? index + 1,
              searchStrategy: candidate.searchStrategy,
              improvementSequence: candidate.improvementSequence ?? candidate.rank ?? index + 1,
              solverObjective: candidate.solverObjective,
              isBestFound: candidate.isBestFound,
              totalCostVnd: result.total_cost_vnd,
              totalDistanceKm: result.total_distance_km,
              totalDurationMinutes: result.total_duration_minutes,
              routeCount: result.routes.length,
              unassignedOrderCount: result.unassigned_orders.length,
            },
            diagnostics: {
              source: 'PARALLEL_MULTI_START',
              messages: result.diagnostics,
            },
          };
        },
      );
      const stored = await this.prisma.$transaction(async (tx) => {
        const finalized = await tx.optimizationJob.updateMany({
          where: {
            id: optimizationJob.id,
            status: 'RUNNING',
            leaseOwner: this.workerId,
          },
          data: {
            status,
            parameters: progressParameters({ stage: 'COMPLETED' }),
            result: storedResult as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
            leaseUntil: null,
            leaseOwner: null,
            solverVersion: 'ortools-fastapi-v1',
          },
        });
        if (finalized.count !== 1) return false;
        await tx.optimizationResult.deleteMany({
          where: { optimizationJobId: optimizationJob.id },
        });
        if (candidateRows.length > 0) {
          await tx.optimizationResult.createMany({ data: candidateRows });
        }
        return true;
      }, { timeout: 30_000 });
      if (!stored) return;
      this.logger.log(
        JSON.stringify({
          event: 'optimization_job_finished',
          jobId: optimizationJob.id,
          status,
          queueLagSeconds: Math.round(
            ((optimizationJob.startedAt ?? new Date()).getTime() -
              optimizationJob.createdAt.getTime()) / 1000,
          ),
          attempt: optimizationJob.attemptCount + 1,
        }),
      );
      this.emitStatus(optimizationJob.branchId, optimizationJob.id, status);
    } catch (error) {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const status = finalAttempt ? 'FAILED' : 'RETRYING';
      await this.prisma.optimizationJob.updateMany({
        where: {
          id: optimizationJob.id,
          status: 'RUNNING',
          leaseOwner: this.workerId,
        },
        data: {
          status,
          errorCode: this.errorCode(error),
          errorMessage: this.errorMessage(error),
          ...(finalAttempt ? { completedAt: new Date() } : {}),
          leaseUntil: null,
          leaseOwner: null,
        },
      });
      this.emitStatus(optimizationJob.branchId, optimizationJob.id, status);
      this.logger.error(`Optimization job ${optimizationJob.id} failed`, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private emitStatus(branchId: string, jobId: string, status: string) {
    this.events.emitOptimizationJobUpdate(branchId, { jobId, status });
  }

  private feasibilityStatus(status: string) {
    if (status === 'SUCCESS') return 'FEASIBLE' as const;
    if (status === 'PARTIAL') return 'PARTIAL' as const;
    if (status === 'INFEASIBLE') return 'INFEASIBLE' as const;
    return 'UNKNOWN' as const;
  }

  private errorCode(error: unknown) {
    const candidate = error as { response?: { status?: number } };
    return candidate?.response?.status ? `HTTP_${candidate.response.status}` : 'OPTIMIZATION_FAILED';
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message.slice(0, 1000) : 'Optimization worker failed';
  }
}
