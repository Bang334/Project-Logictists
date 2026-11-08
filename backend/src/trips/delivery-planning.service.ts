import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceAccess } from '../auth/resource-access.service';
import { Principal } from '../auth/access';
import { resolveBranchScope } from '../auth/branch-scope';
import { OutboxService } from '../common/services/outbox.service';
import { TripsService } from './trips.service';
import { OptimizationJobsService } from './optimization-jobs.service';
import { assertOptimizationProposal } from './optimization-proposal';
import { OptimizeDeliveryBatchDto, ProposeDeliveryBatchDto, RespondDeliveryAppointmentDto } from './dto/delivery-planning.dto';
import { proposedDeliveryWindows, refreshBatchHolds } from './delivery-planning.rules';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicAppointment = {
  id: true, batchId: true, orderId: true, windowStart: true, windowEnd: true, expiresAt: true,
  status: true, version: true, requestedStart: true, requestedEnd: true, responseNote: true,
  order: { select: { orderNumber: true } },
} satisfies Prisma.DeliveryAppointmentSelect;

@Injectable()
export class DeliveryPlanningService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(DeliveryPlanningService.name);
  constructor(private readonly prisma: PrismaService, private readonly trips: TripsService,
    private readonly jobs: OptimizationJobsService, private readonly access: ResourceAccess, private readonly outbox: OutboxService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.expire().catch(error => this.logger.error('Không thể thu hồi đề xuất hết hạn', error)), 15000);
    this.timer.unref();
    void this.expire().catch(error => this.logger.error('Không thể thu hồi đề xuất hết hạn', error));
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async expire() {
    const batches = await this.prisma.deliveryPlanningBatch.findMany({ where: {
      status: 'OFFERING', appointments: { some: { status: 'PENDING', expiresAt: { lte: new Date() } } },
    }, select: { id: true }, take: 100 });
    for (const batch of batches) await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM delivery_planning_batches WHERE id = ${batch.id} FOR UPDATE`;
      const expired = await tx.deliveryAppointment.findMany({ where: { batchId: batch.id, status: 'PENDING', expiresAt: { lte: new Date() } } });
      await tx.deliveryAppointment.updateMany({ where: { id: { in: expired.map(row => row.id) }, status: 'PENDING' }, data: { status: 'EXPIRED', version: { increment: 1 } } });
      await refreshBatchHolds(tx, batch.id);
      if (expired.length) await tx.deliveryPlanningBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } });
      for (const row of expired) await this.event(tx, row.id, row.customerId, row.version + 1);
    });
  }

  async propose(user: Principal, dto: ProposeDeliveryBatchDto) {
    const expiresAt = new Date(dto.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) throw new BadRequestException('Hạn phản hồi không hợp lệ');
    const fingerprint = hash({ jobId: dto.jobId, candidateNumber: dto.candidateNumber, windowMinutes: dto.windowMinutes, expiresAt: expiresAt.toISOString() });
    const existing = await this.prisma.deliveryPlanningBatch.findUnique({ where: { createdById_idempotencyKey: { createdById: user.id, idempotencyKey: dto.idempotencyKey } } });
    if (existing) {
      await this.access.branch(user, 'trips.plan', existing.branchId);
      if (existing.requestHash !== fingerprint) throw new ConflictException('Idempotency key đã dùng với nội dung đề xuất khác');
      return this.getBatch(user, existing.id);
    }
    const candidate = await this.prisma.optimizationResult.findUnique({ where: { optimizationJobId_candidateNumber: { optimizationJobId: dto.jobId, candidateNumber: dto.candidateNumber } }, include: { optimizationJob: true } });
    if (!candidate) throw new NotFoundException('Không tìm thấy phương án đã lưu');
    await this.access.branch(user, 'trips.plan', candidate.optimizationJob.branchId);
    const stored: unknown = candidate.resultSnapshot;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || !('proposal' in stored) || !('signature' in stored) || typeof stored.signature !== 'string') throw new ConflictException('Phương án không có chữ ký hợp lệ');
    const proposal = stored.proposal;
    const signature = stored.signature;
    assertOptimizationProposal(proposal);
    if (proposal.scheduleMode !== 'NEXT_DAY') throw new BadRequestException('Hãy chạy phương án Ngày tiếp theo (ca mai) trước khi hẹn giao');
    const branch = await this.prisma.branch.findUniqueOrThrow({ where: { id: proposal.branchId } });
    const seconds = (clock: string) => { const [h, m] = clock.split(':').map(Number); return h * 3600 + m * 60; };
    const deliveryDays = new Map<string, number[]>();
    for (const route of proposal.result.routes) for (const stop of route.stops) if (stop.stop_type === 'DELIVERY') {
      const days = deliveryDays.get(stop.order_id) ?? []; days.push(Math.floor(stop.arrival_time_sec / 86400)); deliveryDays.set(stop.order_id, days);
    }
    const tomorrowOrders = new Set([...deliveryDays].filter(([, days]) => days.length && days.every(day => day === 0)).map(([id]) => id));
    const offerWitness = { ...proposal, result: { ...proposal.result, routes: proposal.result.routes.map(route => ({ ...route, stops: route.stops.filter(stop => tomorrowOrders.has(stop.order_id)) })) } };
    const offers = proposedDeliveryWindows(offerWitness, dto.windowMinutes, new Date(dto.expiresAt), seconds(branch.workStartTime), seconds(branch.workEndTime));
    if (!offers.length) throw new BadRequestException('Phương án chưa có đơn nào giao trọn trong ngày mai; không gửi lời hẹn cho các ngày khác');
    await this.expire();
    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM optimization_jobs WHERE id = ${dto.jobId} FOR UPDATE`;
        const currentJob = await tx.optimizationJob.findUniqueOrThrow({ where: { id: dto.jobId } });
        if (!['SUCCEEDED','PARTIAL'].includes(currentJob.status)) throw new ConflictException('Job không còn sẵn sàng để gửi đề xuất');
        const trips = await this.trips.validateDeliveryPlanningCandidate(proposal, signature, user, tx);
        const orders = await tx.order.findMany({ where: { id: { in: offers.map(row => row.orderId) } }, include: { customer: { include: { userAccounts: { where: { active: true } } } } } });
        if (orders.some(order => !order.customer.userId && !order.customer.userAccounts.length)) throw new BadRequestException('Có khách chưa liên kết tài khoản app; cần liên kết trước khi gửi đề xuất');
        const batch = await tx.deliveryPlanningBatch.create({ data: {
          branchId: proposal.branchId, sourceJobId: dto.jobId, candidateNumber: dto.candidateNumber,
          createdById: user.id, idempotencyKey: dto.idempotencyKey, requestHash: fingerprint,
          windowMinutes: dto.windowMinutes, expiresAt: new Date(dto.expiresAt), proposal: proposal as unknown as Prisma.InputJsonValue,
        } });
        for (const offer of offers) {
          const order = orders.find(row => row.id === offer.orderId);
          if (!order) throw new ConflictException('Đơn đã thay đổi');
          const appointment = await tx.deliveryAppointment.create({ data: { ...offer, batchId: batch.id, customerId: order.customerId, expiresAt: batch.expiresAt } });
          await this.event(tx, appointment.id, order.customerId, appointment.version);
        }
        await tx.deliveryCapacityHold.createMany({ data: trips.map((trip, routeIndex) => ({ ...trip, routeIndex })).filter(trip => trip.orderIds.some(id => tomorrowOrders.has(id))).map((trip) => ({
          batchId: batch.id, routeIndex: trip.routeIndex, vehicleId: trip.vehicleId, driverId: trip.driverId,
          orderIds: trip.orderIds.filter(id => tomorrowOrders.has(id)), startsAt: trip.plannedStartTime, endsAt: trip.plannedEndTime, expiresAt: batch.expiresAt,
        })) });
        return batch.id;
      }, { timeout: 30000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const retry = await this.prisma.deliveryPlanningBatch.findUnique({ where: { createdById_idempotencyKey: { createdById: user.id, idempotencyKey: dto.idempotencyKey } } });
        if (retry?.requestHash === fingerprint) return this.getBatch(user, retry.id);
        throw new ConflictException('Đơn hoặc yêu cầu đã có đề xuất đang giữ chỗ');
      }
      throw error;
    }
    return this.getBatch(user, createdId);
  }

  async list(user: Principal, branchId: string) {
    branchId = resolveBranchScope(user, branchId);
    await this.access.branch(user, 'trips.plan', branchId);
    await this.expire();
    return this.prisma.deliveryPlanningBatch.findMany({ where: { branchId }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { id: true, status: true, version: true, windowMinutes: true, expiresAt: true, finalOptimizationJobId: true, createdAt: true, appointments: { select: publicAppointment } } });
  }
  async getBatch(user: Principal, id: string) {
    const batch = await this.prisma.deliveryPlanningBatch.findUnique({ where: { id }, select: { branchId: true } });
    if (!batch) throw new NotFoundException('Không tìm thấy đợt đề xuất');
    await this.access.branch(user, 'trips.plan', batch.branchId);
    return this.prisma.deliveryPlanningBatch.findUniqueOrThrow({ where: { id }, select: {
      id: true, status: true, version: true, windowMinutes: true, expiresAt: true, finalOptimizationJobId: true,
      appointments: { select: publicAppointment },
    } });
  }
  async mine(user: Principal, page = 1) {
    if (user.role !== 'CUSTOMER') throw new ForbiddenException('Chỉ khách hàng được xem hộp đề xuất nhận hàng');
    if (!Number.isInteger(page) || page < 1 || page > 100000) throw new BadRequestException('Trang không hợp lệ');
    const where: Prisma.DeliveryAppointmentWhereInput = { customer: { OR: [{ userId: user.id }, { userAccounts: { some: { userId: user.id, active: true } } }] } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.deliveryAppointment.findMany({ where, select: publicAppointment, orderBy: { createdAt: 'desc' }, take: 20, skip: (page - 1) * 20 }),
      this.prisma.deliveryAppointment.count({ where }),
    ]);
    return { items, total, page, pageSize: 20 };
  }
  async respond(user: Principal, id: string, dto: RespondDeliveryAppointmentDto) {
    if (user.role !== 'CUSTOMER') throw new ForbiddenException('Chỉ khách hàng được phản hồi');
    if (Boolean(dto.requestedStart) !== Boolean(dto.requestedEnd) || (dto.requestedStart && dto.requestedEnd && Date.parse(dto.requestedStart) >= Date.parse(dto.requestedEnd))) throw new BadRequestException('Khung yêu cầu đổi không hợp lệ');
    if (dto.decision !== 'CHANGE_REQUESTED' && (dto.requestedStart || dto.requestedEnd)) throw new BadRequestException('Chỉ yêu cầu đổi khung được nhập thời gian khác');
    const fingerprint = hash({ decision: dto.decision, requestedStart: dto.requestedStart ? new Date(dto.requestedStart).toISOString() : null, requestedEnd: dto.requestedEnd ? new Date(dto.requestedEnd).toISOString() : null, note: dto.note ?? null });
    return this.prisma.$transaction(async tx => {
      const owned = await tx.deliveryAppointment.findFirst({ where: { id, customer: { OR: [{ userId: user.id }, { userAccounts: { some: { userId: user.id, active: true } } }] } } });
      if (!owned) throw new NotFoundException('Không tìm thấy đề xuất thuộc tài khoản');
      await tx.$queryRaw`SELECT id FROM delivery_planning_batches WHERE id = ${owned.batchId} FOR UPDATE`;
      const current = await tx.deliveryAppointment.findUniqueOrThrow({ where: { id } });
      if (current.responseKey === dto.idempotencyKey) {
        if (current.responseHash !== fingerprint) throw new ConflictException('Idempotency key có nội dung khác');
        return tx.deliveryAppointment.findUniqueOrThrow({ where: { id }, select: publicAppointment });
      }
      const batch = await tx.deliveryPlanningBatch.findUniqueOrThrow({ where: { id: current.batchId } });
      if (batch.status !== 'OFFERING' || current.status !== 'PENDING' || current.expiresAt <= new Date() || current.version !== dto.version) throw new ConflictException('Đề xuất hết hạn hoặc đã thay đổi; hãy tải lại');
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${current.orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: current.orderId } });
      if (order.status !== 'CONFIRMED') throw new ConflictException('Đơn không còn chờ lập lịch');
      const updated = await tx.deliveryAppointment.update({ where: { id }, data: {
        status: dto.decision, version: { increment: 1 }, respondedAt: new Date(), responseKey: dto.idempotencyKey,
        responseHash: fingerprint, requestedStart: dto.requestedStart ? new Date(dto.requestedStart) : null,
        requestedEnd: dto.requestedEnd ? new Date(dto.requestedEnd) : null, responseNote: dto.note,
      }, select: publicAppointment });
      await tx.deliveryPlanningBatch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } });
      await refreshBatchHolds(tx, batch.id);
      await this.event(tx, id, current.customerId, updated.version);
      return updated;
    });
  }
  async optimize(user: Principal, id: string, dto: OptimizeDeliveryBatchDto) {
    await this.expire();
    const batch = await this.getBatch(user, id);
    if (batch.status !== 'OFFERING' || batch.appointments.some(row => row.status === 'PENDING')) throw new ConflictException('Cần nhận đủ phản hồi hoặc chờ hết hạn trước khi tối ưu chốt');
    if (!batch.appointments.some(row => row.status === 'CONFIRMED')) throw new ConflictException('Chưa có khách xác nhận');
    const full = await this.prisma.deliveryPlanningBatch.findUniqueOrThrow({ where: { id } });
    return this.jobs.create(user, { ...dto, branchId: full.branchId, deliveryBatchId: id });
  }
  private event(tx: Prisma.TransactionClient, appointmentId: string, customerId: string, version: number) {
    return this.outbox.enqueue({ aggregateType: 'DeliveryAppointment', aggregateId: appointmentId, aggregateVersion: version,
      eventType: 'DELIVERY_APPOINTMENT_UPDATED', payload: { appointmentId, customerId } }, tx);
  }
}
