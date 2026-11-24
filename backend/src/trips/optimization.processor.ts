import { MapboxMatrixRateLimitException } from '../mapbox/mapbox.service';
import { AuthService } from '../auth/auth.service';
import {
  BadRequestException,
  GatewayTimeoutException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Job, UnrecoverableError } from 'bullmq';
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
import {
  isOptimizationAbortError,
  OptimizationJobControlService,
} from './optimization-job-control.service';
import { extractCandidateCostBreakdown } from './optimizer-contract';

type QueuePayload = { jobId: string };

@Processor(OPTIMIZATION_QUEUE, { concurrency: 1, lockDuration: 120_000 })
export class OptimizationProcessor extends WorkerHost {
  private readonly logger = new Logger(OptimizationProcessor.name);
  private readonly workerId = `optimizer-${process.pid}-${randomUUID()}`;

  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly tripsService: TripsService,
    private readonly events: EventsGateway,
    @Optional() private readonly jobControl?: OptimizationJobControlService,
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
    if (!optimizationJob || ['CANCELLED', 'CANCEL_REQUESTED', 'APPLIED'].includes(optimizationJob.status)) return;

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

    const startedAt = optimizationJob.startedAt ?? new Date();
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
        startedAt,
        attemptCount: { increment: 1 },
        leaseUntil,
        leaseOwner: this.workerId,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (claimed.count !== 1) return;
    this.emitStatus(optimizationJob.branchId, optimizationJob.id, 'RUNNING');

    const abortController =
      this.jobControl?.register(optimizationJob.id) ?? new AbortController();
    let heartbeatPending = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      try {
        const renewed = await this.prisma.optimizationJob.updateMany({
          where: {
            id: optimizationJob.id,
            status: 'RUNNING',
            leaseOwner: this.workerId,
          },
          data: { leaseUntil: new Date(Date.now() + 5 * 60 * 1000) },
        });
        if (renewed.count === 0) {
          abortController.abort();
        }
      } catch (error) {
        this.logger.warn(`Lease heartbeat failed for ${optimizationJob.id}: ${this.errorMessage(error)}`);
      } finally {
        heartbeatPending = false;
      }
    }, 10_000);
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
      ...(typeof request.deliveryBatchId === 'string' ? { deliveryBatchId: request.deliveryBatchId } : {}),
      ...(request.replanWithFleet === true ? { replanWithFleet: true } : {}),
      idempotencyKey: optimizationJob.id,
      branchId: optimizationJob.branchId,
      ...(typeof request.scheduleMode === 'string'
        ? { scheduleMode: request.scheduleMode as RunAutomaticOptimizationDto['scheduleMode'] }
        : {}),
      ...(typeof request.customStartTime === 'string'
        ? { customStartTime: request.customStartTime }
        : {}),
      ...(typeof request.searchBudgetSeconds === 'number'
        ? { searchBudgetSeconds: request.searchBudgetSeconds }
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
        await this.finalizeCancellation(optimizationJob.id, optimizationJob.branchId);
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
      const persistenceStarted = performance.now();
      const candidateRows = candidateBatch.candidates.map(
        (candidate, index): Omit<Prisma.OptimizationResultCreateManyInput, 'optimizationJobId'> => {
          const result = candidate.proposal.result;
          const planningObjective = result.planning_objective;
          const costBreakdown = extractCandidateCostBreakdown(result);
          return {
            id: randomUUID(),
            candidateNumber: index + 1,
            resultSnapshot: candidate as unknown as Prisma.InputJsonValue,
            feasibilityStatus: this.feasibilityStatus(result.status),
            objectiveBreakdown: {
              rank: candidate.rank ?? index + 1,
              searchStrategy: candidate.searchStrategy,
              improvementSequence: candidate.improvementSequence ?? candidate.rank ?? index + 1,
              solverObjective: candidate.solverObjective,
              planningSpanDays: planningObjective?.planning_span_days ?? 0,
              driverCalendarSalaryVnd:
                planningObjective?.driver_calendar_salary_vnd ?? 0,
              driverIdleSalaryAllocationVnd:
                planningObjective?.driver_idle_salary_allocation_vnd ?? 0,
              operationalLatePenaltyVnd:
                planningObjective?.operational_late_penalty_vnd ?? 0,
              isBestFound: candidate.isBestFound,
              totalCostVnd: result.total_cost_vnd,
              totalDistanceKm: result.total_distance_km,
              totalDurationMinutes: result.total_duration_minutes,
              routeCount: result.routes.length,
              unassignedOrderCount: result.unassigned_orders.length,
              extraOrderTrips: planningObjective?.extra_order_trips ?? 0,
              splitOrderCount: planningObjective?.split_order_count ?? 0,
              maxTripsPerOrder: planningObjective?.max_trips_per_order ?? 0,
              extraRequestTrips: planningObjective?.extra_request_trips ?? 0,
              activeRouteCount:
                planningObjective?.active_route_count ?? result.routes.length,
              physicalVehicleCount:
                planningObjective?.physical_vehicle_count ??
                new Set(result.routes.map((route) => route.vehicle_id)).size,
              deliveryVisitCount:
                planningObjective?.delivery_visit_count ?? 0,
              ...(costBreakdown ?? {}),
            },
            diagnostics: {
              source: 'HYBRID_FIRST',
              messages: result.diagnostics,
            },
          };
        },
      );
      const bestSnapshot = storedResult === candidateBatch.candidates[0]
        ? null
        : JSON.stringify(storedResult);
      const completedAt = new Date();
      // A single statement keeps candidate replacement atomic with the lease check.
      // Ranked rows and the legacy result column share the first snapshot in transit.
      const stored = await this.prisma.$queryRaw<{ stored: boolean }[]>`
        WITH incoming AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(candidateRows)}::jsonb) AS payload(
            id text, "candidateNumber" integer, "resultSnapshot" jsonb,
            "feasibilityStatus" "FeasibilityStatus", "objectiveBreakdown" jsonb, diagnostics jsonb
          )
        ), finalized AS (
          UPDATE optimization_jobs
          SET status = ${status},
              parameters = ${JSON.stringify(progressParameters({ stage: 'COMPLETED' }))}::jsonb,
              result = COALESCE(${bestSnapshot}::jsonb,
                (SELECT "resultSnapshot" FROM incoming WHERE "candidateNumber" = 1)),
              "completedAt" = ${completedAt},
              "updatedAt" = ${completedAt},
              "leaseUntil" = NULL,
              "leaseOwner" = NULL,
              "solverVersion" = 'hybrid-first-fastapi-v1'
          WHERE id = ${optimizationJob.id} AND status = 'RUNNING' AND "leaseOwner" = ${this.workerId}
          RETURNING id
        ), written AS (
          INSERT INTO optimization_results (
            id, "optimizationJobId", "candidateNumber", "resultSnapshot",
            "feasibilityStatus", "objectiveBreakdown", diagnostics
          )
          SELECT incoming.id, finalized.id, incoming."candidateNumber", incoming."resultSnapshot",
                 incoming."feasibilityStatus", incoming."objectiveBreakdown", incoming.diagnostics
          FROM finalized CROSS JOIN incoming
          ON CONFLICT ("optimizationJobId", "candidateNumber") DO UPDATE
          SET "resultSnapshot" = EXCLUDED."resultSnapshot",
              "feasibilityStatus" = EXCLUDED."feasibilityStatus",
              "objectiveBreakdown" = EXCLUDED."objectiveBreakdown",
              diagnostics = EXCLUDED.diagnostics
        ), pruned AS (
          DELETE FROM optimization_results AS previous USING finalized
          WHERE previous."optimizationJobId" = finalized.id
            AND NOT EXISTS (
              SELECT 1 FROM incoming WHERE incoming."candidateNumber" = previous."candidateNumber"
            )
        )
        SELECT EXISTS (SELECT 1 FROM finalized) AS stored
      `;
      if (!stored[0]?.stored) {
        await this.finalizeCancellation(optimizationJob.id, optimizationJob.branchId);
        return;
      }
      this.logger.log(
        JSON.stringify({
          event: 'optimization_job_finished',
          jobId: optimizationJob.id,
          status,
          persistenceDurationMs: Math.round(performance.now() - persistenceStarted),
          queueLagSeconds: Math.round(
            (startedAt.getTime() - optimizationJob.createdAt.getTime()) / 1000,
          ),
          attempt: optimizationJob.attemptCount + 1,
        }),
      );
      this.emitStatus(optimizationJob.branchId, optimizationJob.id, status);
    } catch (error) {
      if (isOptimizationAbortError(error, abortController.signal) &&
        await this.finalizeCancellation(optimizationJob.id, optimizationJob.branchId)) return;
      const isHttpTimeout = error instanceof GatewayTimeoutException;
      const isNonRetryable = isHttpTimeout || error instanceof BadRequestException
        || error instanceof MapboxMatrixRateLimitException;
      const finalAttempt =
        isNonRetryable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const status = isHttpTimeout
        ? 'TIMEOUT'
        : finalAttempt
          ? 'FAILED'
          : 'RETRYING';
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
      if (isNonRetryable) {
        throw new UnrecoverableError(this.errorMessage(error));
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.jobControl?.unregister(optimizationJob.id, abortController);
    }
  }

  private async finalizeCancellation(id: string, branchId: string): Promise<boolean> {
    const updated = await this.prisma.optimizationJob.updateMany({
      where: { id, status: 'CANCEL_REQUESTED', leaseOwner: this.workerId },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        leaseUntil: null,
        leaseOwner: null,
        result: Prisma.JsonNull,
      },
    });
    if (updated.count !== 1) return false;
    this.emitStatus(branchId, id, 'CANCELLED');
    return true;
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
    if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code;
    if (error instanceof GatewayTimeoutException) {
      return 'OPTIMIZER_HTTP_TIMEOUT';
    }
    const candidate = error as { response?: { status?: number }; getStatus?: () => number };
    const status = candidate?.response?.status ?? candidate?.getStatus?.();
    return status ? `HTTP_${status}` : 'OPTIMIZATION_FAILED';
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message.slice(0, 1000) : 'Optimization worker failed';
  }
}
