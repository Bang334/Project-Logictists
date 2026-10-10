import { Principal, hasPermission } from '../auth/access';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { resolveBranchScope } from '../auth/branch-scope';
import { RunAutomaticOptimizationDto } from './dto/run-automatic-optimization.dto';
import { TripsService } from './trips.service';
import { OutboxService } from '../common/services/outbox.service';
import * as ExcelJS from 'exceljs';
import { OPTIMIZATION_PROGRESS_STAGES } from './optimization-progress';

export const OPTIMIZATION_QUEUE = 'optimization';
export const OPTIMIZATION_JOB_NAME = 'run-automatic-optimization';

type JobUser = Principal;
type StoredJobResult = {
  proposal: Record<string, unknown>;
  signature: string;
};

type CandidateSummary = {
  candidateNumber: number;
  rank?: number;
  searchStrategy?: string;
  improvementSequence: number;
  solverObjective: number;
  planningSpanDays: number;
  driverCalendarSalaryVnd: number;
  driverIdleSalaryAllocationVnd: number;
  operationalLatePenaltyVnd: number;
  isBestFound: boolean;
  feasibilityStatus: string;
  totalCostVnd: number;
  totalDistanceKm: number;
  totalDurationMinutes: number;
  routeCount: number;
  unassignedOrderCount: number;
};

type ExportRoute = {
  service_day_index?: unknown;
  plate_number?: unknown;
  driver_name?: unknown;
  total_distance_km?: unknown;
  total_duration_minutes?: unknown;
  cost?: { total_cost_vnd?: unknown };
  stops?: Array<Record<string, unknown>>;
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
      searchBudgetSeconds: dto.searchBudgetSeconds ?? null,
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
            parameters: {
              ...request,
              progress: {
                stage: 'QUEUED',
                details: {},
                updatedAt: new Date().toISOString(),
              },
            },
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
    const results = await this.prisma.optimizationResult.findMany({
      where: { optimizationJobId: id },
      orderBy: { candidateNumber: 'asc' },
      select: {
        candidateNumber: true,
        feasibilityStatus: true,
        objectiveBreakdown: true,
      },
    });
    return this.toPublicJob(job, results.map((result) => this.toCandidateSummary(result)));
  }

  async getCandidate(user: JobUser, id: string, candidateNumber: number) {
    if (!Number.isInteger(candidateNumber) || candidateNumber < 1 || candidateNumber > 10) {
      throw new NotFoundException(`Số thứ tự phương án ${candidateNumber} không hợp lệ`);
    }
    await this.getAuthorizedJob(user, id);
    const candidate = await this.prisma.optimizationResult.findUnique({
      where: {
        optimizationJobId_candidateNumber: {
          optimizationJobId: id,
          candidateNumber,
        },
      },
    });
    if (!candidate) {
      throw new NotFoundException(
        `Không tìm thấy phương án ${candidateNumber} của optimization job ${id}`,
      );
    }
    const stored = candidate.resultSnapshot as unknown as StoredJobResult;
    const proposal = stored?.proposal as { result?: unknown } | undefined;
    if (!proposal?.result) {
      throw new ConflictException(`Phương án ${candidateNumber} có dữ liệu không hợp lệ`);
    }
    return {
      candidateNumber,
      result: proposal.result,
      summary: this.toCandidateSummary(candidate),
    };
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

  async apply(user: JobUser, id: string, candidateNumber = 1) {
    const job = await this.getAuthorizedJob(user, id);
    if (!['SUCCEEDED', 'PARTIAL'].includes(job.status)) {
      throw new ConflictException(`Job ${id} chưa sẵn sàng để áp dụng`);
    }
    const selected = await this.prisma.optimizationResult.findUnique({
      where: {
        optimizationJobId_candidateNumber: {
          optimizationJobId: id,
          candidateNumber,
        },
      },
      select: { resultSnapshot: true },
    });
    if (!selected && candidateNumber !== 1) {
      throw new NotFoundException(`Không tìm thấy phương án ${candidateNumber} của job ${id}`);
    }
    const stored = (selected?.resultSnapshot ?? job.result) as unknown as StoredJobResult | null;
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
      candidateNumber,
    );
    return { jobId: id, status: 'APPLIED', ...applied };
  }

  async exportCandidates(user: JobUser, id: string) {
    const job = await this.getAuthorizedJob(user, id);
    const candidates = await this.prisma.optimizationResult.findMany({
      where: { optimizationJobId: id },
      orderBy: { candidateNumber: 'asc' },
    });
    if (candidates.length === 0) {
      throw new ConflictException(`Job ${id} chưa có phương án để xuất`);
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TMS Logistics';
    workbook.created = new Date();
    const comparison = workbook.addWorksheet('Chuỗi nghiệm cải thiện', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    comparison.columns = [
      { header: 'Hạng', key: 'rank', width: 10 },
      { header: 'Chiến lược tìm kiếm', key: 'searchStrategy', width: 32 },
      { header: 'Objective solver', key: 'solverObjective', width: 22 },
      { header: 'Tổng chi phí (VND)', key: 'cost', width: 22 },
      { header: 'Chênh lệch với hạng 1 (VND)', key: 'gap', width: 30 },
      { header: 'Quãng đường (km)', key: 'distance', width: 20 },
      { header: 'Thời gian (phút)', key: 'duration', width: 20 },
      { header: 'Số lượt chuyến', key: 'routes', width: 18 },
      { header: 'Đơn chưa xếp', key: 'unassigned', width: 18 },
      { header: 'Trạng thái', key: 'status', width: 18 },
    ];
    const summaries = candidates.map((candidate) => this.toCandidateSummary(candidate));
    const bestCost = summaries[0].totalCostVnd;
    for (const summary of summaries) {
      comparison.addRow({
        rank: summary.candidateNumber,
        searchStrategy: summary.searchStrategy ?? 'Khởi tạo',
        solverObjective: summary.solverObjective,
        cost: summary.totalCostVnd,
        gap: summary.totalCostVnd - bestCost,
        distance: summary.totalDistanceKm,
        duration: summary.totalDurationMinutes,
        routes: summary.routeCount,
        unassigned: summary.unassignedOrderCount,
        status: summary.feasibilityStatus,
      });
    }
    comparison.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    comparison.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF155E75' },
    };
    comparison.getColumn('cost').numFmt = '#,##0';
    comparison.getColumn('gap').numFmt = '#,##0';
    comparison.getColumn('distance').numFmt = '#,##0.00';
    comparison.getColumn('duration').numFmt = '#,##0.0';
    comparison.autoFilter = 'A1:J1';

    const details = workbook.addWorksheet('Chi tiết tuyến', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    details.columns = [
      { header: 'Hạng nghiệm', key: 'rank', width: 18 },
      { header: 'Tuyến', key: 'route', width: 10 },
      { header: 'Ngày phục vụ', key: 'day', width: 16 },
      { header: 'Biển số xe', key: 'plate', width: 18 },
      { header: 'Tài xế', key: 'driver', width: 24 },
      { header: 'Chi phí tuyến (VND)', key: 'cost', width: 24 },
      { header: 'Quãng đường (km)', key: 'distance', width: 20 },
      { header: 'Thời gian (phút)', key: 'duration', width: 20 },
      { header: 'Thứ tự điểm dừng', key: 'stops', width: 60 },
    ];
    for (const candidate of candidates) {
      const stored = candidate.resultSnapshot as unknown as StoredJobResult;
      const result = (stored.proposal as { result?: { routes?: ExportRoute[] } })
        ?.result;
      for (const [routeIndex, route] of (result?.routes ?? []).entries()) {
        const stops = Array.isArray(route.stops) ? route.stops : [];
        details.addRow({
          rank: candidate.candidateNumber,
          route: routeIndex + 1,
          day: Number(route.service_day_index ?? 0) + 1,
          plate: String(route.plate_number ?? ''),
          driver: String(route.driver_name ?? ''),
          cost: Number(route.cost?.total_cost_vnd ?? 0),
          distance: Number(route.total_distance_km ?? 0),
          duration: Number(route.total_duration_minutes ?? 0),
          stops: stops
            .map((stop: Record<string, unknown>) =>
              `${stop.stop_type === 'PICKUP' ? 'Lấy' : 'Giao'} ${String(stop.order_id ?? '')}`,
            )
            .join(' → '),
        });
      }
    }
    details.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    details.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF155E75' },
    };
    details.getColumn('cost').numFmt = '#,##0';
    details.getColumn('distance').numFmt = '#,##0.00';
    details.getColumn('duration').numFmt = '#,##0.0';
    details.autoFilter = 'A1:I1';

    const note = comparison.addRow([]);
    note.getCell(1).value =
      'Các phương án được trích xuất từ các lượt chạy OR-Tools độc lập song song. Hạng 1 là phương án tối ưu chi phí nhất giao đủ 100% đơn.';
    comparison.mergeCells(note.number, 1, note.number, 10);
    note.getCell(1).font = { italic: true, color: { argb: 'FF475569' } };

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `chuoi-nghiem-toi-uu-${job.branchId}-${id}.xlsx`,
    };
  }

  private async getAuthorizedJob(user: JobUser, id: string) {
    const job = await this.prisma.optimizationJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException(`Không tìm thấy optimization job ${id}`);
    if (!hasPermission(user, 'trips.plan', job.branchId)) {
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
    parameters: Prisma.JsonValue | null;
    result: Prisma.JsonValue | null;
    errorCode: string | null;
    errorMessage: string | null;
    attemptCount: number;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }, candidates: CandidateSummary[] = []) {
    const stored = job.result as unknown as StoredJobResult | null;
    const proposal = stored?.proposal as { result?: unknown } | undefined;
    const snapshot = job.requestSnapshot as {
      planningEpochIso?: unknown;
      scheduleMode?: unknown;
      searchBudgetSeconds?: unknown;
    };
    const parameters =
      job.parameters &&
      typeof job.parameters === 'object' &&
      !Array.isArray(job.parameters)
        ? job.parameters as Record<string, unknown>
        : {};
    const storedProgress =
      parameters.progress &&
      typeof parameters.progress === 'object' &&
      !Array.isArray(parameters.progress)
        ? parameters.progress as Record<string, unknown>
        : {};
    const progressDetails =
      storedProgress.details &&
      typeof storedProgress.details === 'object' &&
      !Array.isArray(storedProgress.details)
        ? storedProgress.details
        : {};
    const progressStage = OPTIMIZATION_PROGRESS_STAGES.includes(
      storedProgress.stage as (typeof OPTIMIZATION_PROGRESS_STAGES)[number],
    )
      ? storedProgress.stage
      : 'QUEUED';
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
      searchBudgetSeconds:
        typeof snapshot.searchBudgetSeconds === 'number'
          ? snapshot.searchBudgetSeconds
          : null,
      progress: {
        stage: progressStage,
        details: progressDetails,
        updatedAt:
          typeof storedProgress.updatedAt === 'string'
            ? storedProgress.updatedAt
            : null,
      },
      result: proposal?.result ?? null,
      candidates,
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

  private toCandidateSummary(result: {
    candidateNumber: number;
    feasibilityStatus: string;
    objectiveBreakdown: Prisma.JsonValue;
  }): CandidateSummary {
    const objective =
      result.objectiveBreakdown &&
      typeof result.objectiveBreakdown === 'object' &&
      !Array.isArray(result.objectiveBreakdown)
        ? result.objectiveBreakdown as Record<string, unknown>
        : {};
    return {
      candidateNumber: result.candidateNumber,
      rank: Number(objective.rank ?? result.candidateNumber),
      searchStrategy: typeof objective.searchStrategy === 'string' ? objective.searchStrategy : 'Nghiệm trung gian (cũ)',
      improvementSequence: Number(objective.improvementSequence ?? result.candidateNumber),
      solverObjective: Number(objective.solverObjective ?? 0),
      planningSpanDays: Number(objective.planningSpanDays ?? 0),
      driverCalendarSalaryVnd: Number(objective.driverCalendarSalaryVnd ?? 0),
      driverIdleSalaryAllocationVnd: Number(
        objective.driverIdleSalaryAllocationVnd ?? 0,
      ),
      operationalLatePenaltyVnd: Number(
        objective.operationalLatePenaltyVnd ?? 0,
      ),
      isBestFound: objective.isBestFound === true,
      feasibilityStatus: result.feasibilityStatus,
      totalCostVnd: Number(objective.totalCostVnd ?? 0),
      totalDistanceKm: Number(objective.totalDistanceKm ?? 0),
      totalDurationMinutes: Number(objective.totalDurationMinutes ?? 0),
      routeCount: Number(objective.routeCount ?? 0),
      unassignedOrderCount: Number(objective.unassignedOrderCount ?? 0),
    };
  }
}
