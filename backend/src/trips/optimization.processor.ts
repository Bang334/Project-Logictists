import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma, Role } from '@prisma/client';
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

type QueuePayload = { jobId: string };

@Processor(OPTIMIZATION_QUEUE, { concurrency: 1 })
export class OptimizationProcessor extends WorkerHost {
  private readonly logger = new Logger(OptimizationProcessor.name);
  private readonly workerId = `optimizer-${process.pid}-${randomUUID()}`;

  constructor(
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

    const request = optimizationJob.parameters as Prisma.JsonObject;
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
      const storedResult = await this.tripsService.executeAutomaticOptimization(
        {
          id: optimizationJob.createdById,
          branchId: optimizationJob.branchId,
          role: optimizationJob.createdBy.role as Role,
        },
        dto,
        optimizationJob.id,
      );
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

      const solverStatus = storedResult.proposal.result.status;
      const status =
        solverStatus === 'SUCCESS'
          ? 'SUCCEEDED'
          : solverStatus === 'ERROR'
            ? 'FAILED'
            : solverStatus;
      const stored = await this.prisma.$transaction(async (tx) => {
        const finalized = await tx.optimizationJob.updateMany({
          where: {
            id: optimizationJob.id,
            status: 'RUNNING',
            leaseOwner: this.workerId,
          },
          data: {
            status,
            result: storedResult as unknown as Prisma.InputJsonValue,
            completedAt: new Date(),
            leaseUntil: null,
            leaseOwner: null,
            solverVersion: 'ortools-fastapi-v1',
          },
        });
        if (finalized.count !== 1) return false;
        await tx.optimizationResult.upsert({
          where: {
            optimizationJobId_candidateNumber: {
              optimizationJobId: optimizationJob.id,
              candidateNumber: 1,
            },
          },
          create: {
            optimizationJobId: optimizationJob.id,
            candidateNumber: 1,
            resultSnapshot: storedResult.proposal.result as unknown as Prisma.InputJsonValue,
            feasibilityStatus: this.feasibilityStatus(solverStatus),
            objectiveBreakdown: {
              totalCostVnd: storedResult.proposal.result.total_cost_vnd,
              totalDistanceKm: storedResult.proposal.result.total_distance_km,
              totalDurationMinutes: storedResult.proposal.result.total_duration_minutes,
            },
          },
          update: {
            resultSnapshot: storedResult.proposal.result as unknown as Prisma.InputJsonValue,
            feasibilityStatus: this.feasibilityStatus(solverStatus),
            objectiveBreakdown: {
              totalCostVnd: storedResult.proposal.result.total_cost_vnd,
              totalDistanceKm: storedResult.proposal.result.total_distance_km,
              totalDurationMinutes: storedResult.proposal.result.total_duration_minutes,
            },
          },
        });
        return true;
      });
      if (!stored) return;
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
