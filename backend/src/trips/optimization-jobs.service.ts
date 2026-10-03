import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma, Role } from '@prisma/client';
import { createHash } from 'crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { resolveBranchScope } from '../auth/branch-scope';
import { RunAutomaticOptimizationDto } from './dto/run-automatic-optimization.dto';
import { TripsService } from './trips.service';
import { OutboxService } from '../common/services/outbox.service';

export const OPTIMIZATION_QUEUE = 'optimization';
export const OPTIMIZATION_JOB_NAME = 'run-automatic-optimization';

type JobUser = { id: string; branchId?: string | null; role: Role };
type StoredJobResult = {
  proposal: Record<string, unknown>;
  signature: string;
};

@Injectable()
export class OptimizationJobsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OPTIMIZATION_QUEUE) private readonly queue: Queue,
    private readonly tripsService: TripsService,
    private readonly outbox: OutboxService,
  ) {}

  async create(user: JobUser, dto: RunAutomaticOptimizationDto) {
    const branchId = resolveBranchScope(user, dto.branchId);
    const request = {
      branchId,
      scheduleMode: dto.scheduleMode ?? null,
      customStartTime: dto.customStartTime ?? null,
    };
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');

    const existing = await this.prisma.optimizationJob.findUnique({
      where: {
        createdById_idempotencyKey: {
          createdById: user.id,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException(
          'Cùng idempotency key nhưng nội dung yêu cầu tối ưu khác lần gửi trước',
        );
      }
      return this.toPublicJob(existing);
    }

    let job;
    try {
      job = await this.prisma.$transaction(async (tx) => {
        const created = await tx.optimizationJob.create({
          data: {
            status: 'PENDING',
            branchId,
            createdById: user.id,
            idempotencyKey: dto.idempotencyKey,
            requestHash,
            requestSnapshot: request,
            schemaVersion: '2',
            parameters: request,
          },
        });
        await this.outbox.enqueue(
          {
            aggregateType: 'OptimizationJob',
            aggregateId: created.id,
            eventType: 'OPTIMIZATION_JOB_CREATED',
            payload: { jobId: created.id, branchId },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.prisma.optimizationJob.findUnique({
          where: {
            createdById_idempotencyKey: {
              createdById: user.id,
              idempotencyKey: dto.idempotencyKey,
            },
          },
        });
        if (concurrent?.requestHash === requestHash) return this.toPublicJob(concurrent);
        throw new ConflictException(
          'Cùng idempotency key nhưng nội dung yêu cầu tối ưu khác lần gửi trước',
        );
      }
      throw error;
    }

    return this.toPublicJob(job);
  }

  async list(user: JobUser, branchId?: string) {
    const scopedBranchId = resolveBranchScope(user, branchId);
    const jobs = await this.prisma.optimizationJob.findMany({
      where: { branchId: scopedBranchId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map((job) => this.toPublicJob(job));
  }

  async get(user: JobUser, id: string) {
    const job = await this.getAuthorizedJob(user, id);
    return this.toPublicJob(job);
  }

  async cancel(user: JobUser, id: string) {
    const job = await this.getAuthorizedJob(user, id);
    if (['SUCCEEDED', 'PARTIAL', 'INFEASIBLE', 'FAILED', 'TIMEOUT', 'APPLIED', 'CANCELLED'].includes(job.status)) {
      throw new ConflictException(`Không thể hủy job ở trạng thái ${job.status}`);
    }
    const nextStatus = job.status === 'RUNNING' ? 'CANCEL_REQUESTED' : 'CANCELLED';
    const updated = await this.prisma.optimizationJob.update({
      where: { id },
      data: {
        status: nextStatus,
        cancelledAt: new Date(),
        ...(nextStatus === 'CANCELLED' ? { completedAt: new Date() } : {}),
      },
    });
    if (nextStatus === 'CANCELLED') {
      const queuedJob = await this.queue.getJob(id);
      if (queuedJob) await queuedJob.remove().catch(() => undefined);
    }
    return this.toPublicJob(updated);
  }

  async apply(user: JobUser, id: string) {
    const job = await this.getAuthorizedJob(user, id);
    if (!['SUCCEEDED', 'PARTIAL'].includes(job.status)) {
      throw new ConflictException(`Job ${id} chưa sẵn sàng để áp dụng`);
    }
    const stored = job.result as unknown as StoredJobResult | null;
    if (!stored?.proposal || !stored.signature) {
      throw new ConflictException(`Job ${id} thiếu kết quả đã lưu`);
    }

    const applied = await this.tripsService.applyAutomaticOptimization(
      {
        proposal: stored.proposal,
        signature: stored.signature,
      },
      { ...user, branchId: user.branchId ?? undefined },
      id,
    );
    return { jobId: id, status: 'APPLIED', ...applied };
  }

  private async getAuthorizedJob(user: JobUser, id: string) {
    const job = await this.prisma.optimizationJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Không tìm thấy optimization job ${id}`);
    if (user.role !== Role.ADMIN && user.branchId !== job.branchId) {
      throw new ForbiddenException('KhÃ´ng cÃ³ quyá»n truy cáº­p job ngoÃ i chi nhÃ¡nh');
    }
    return job;
  }

  private toPublicJob(job: {
    id: string;
    branchId: string;
    status: string;
    schemaVersion: string;
    requestSnapshot: Prisma.JsonValue;
    result: Prisma.JsonValue | null;
    errorCode: string | null;
    errorMessage: string | null;
    attemptCount: number;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const stored = job.result as unknown as StoredJobResult | null;
    const proposal = stored?.proposal as { result?: unknown } | undefined;
    const snapshot = job.requestSnapshot as {
      planningEpochIso?: unknown;
      scheduleMode?: unknown;
    };
    return {
      id: job.id,
      branchId: job.branchId,
      status: job.status,
      schemaVersion: job.schemaVersion,
      planningEpochIso:
        typeof snapshot.planningEpochIso === 'string'
          ? snapshot.planningEpochIso
          : null,
      scheduleMode:
        typeof snapshot.scheduleMode === 'string' ? snapshot.scheduleMode : null,
      result: proposal?.result ?? null,
      error: job.errorCode
        ? { code: job.errorCode, message: job.errorMessage }
        : null,
      attemptCount: job.attemptCount,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}
