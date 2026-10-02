import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FeedbackStatus, FeedbackType, Prisma, Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { assertLocationAccess, AuthenticatedUser, resolveLocationScope } from '../auth/branch-scope';
import { PrismaService } from '../prisma/prisma.service';
import { AddFeedbackMessageDto, CreateFeedbackDto, QueryFeedbackDto, UpdateFeedbackDto } from './dto/feedback.dto';

const transitions: Record<FeedbackStatus, readonly FeedbackStatus[]> = {
  OPEN: [FeedbackStatus.IN_PROGRESS, FeedbackStatus.CLOSED],
  IN_PROGRESS: [FeedbackStatus.WAITING_CUSTOMER, FeedbackStatus.RESOLVED, FeedbackStatus.CLOSED],
  WAITING_CUSTOMER: [FeedbackStatus.IN_PROGRESS, FeedbackStatus.RESOLVED, FeedbackStatus.CLOSED],
  RESOLVED: [FeedbackStatus.IN_PROGRESS, FeedbackStatus.CLOSED],
  CLOSED: [],
};

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateFeedbackDto, user: AuthenticatedUser) {
    if (dto.type === FeedbackType.RATING && dto.rating === undefined) throw new BadRequestException('Đánh giá phải có từ 1 đến 5 sao');
    return this.prisma.$transaction(async (tx) => {
      const customer = user.role === Role.CUSTOMER
        ? await tx.customer.findUnique({ where: { userId: user.id } })
        : dto.customerProfileId ? await tx.customer.findUnique({ where: { id: dto.customerProfileId } }) : null;
      if (!customer) throw new ForbiddenException('Không tìm thấy hồ sơ khách hàng phù hợp');
      const order = dto.salesOrderId ? await tx.order.findUnique({ where: { id: dto.salesOrderId } }) : null;
      if (dto.salesOrderId && (!order || order.customerId !== customer.id)) throw new ForbiddenException('Đơn hàng không thuộc khách hàng');
      const pkg = dto.retailPackageId ? await tx.package.findUnique({ where: { id: dto.retailPackageId } }) : null;
      if (dto.retailPackageId && (!pkg || pkg.orderId !== dto.salesOrderId)) throw new BadRequestException('Kiện hàng không thuộc đơn đã chọn');
      const locationId = dto.locationId || order?.selectedPickupPointId || order?.allocatedSourceId;
      if (user.role === Role.STAFF) {
        if (!locationId) throw new BadRequestException('Phản hồi phải thuộc một địa điểm');
        assertLocationAccess(user, locationId);
      }
      const feedback = await tx.feedbackCase.create({ data: { caseNumber: `FB-${randomUUID().slice(0, 8).toUpperCase()}`, type: dto.type, priority: dto.priority, customerId: customer.id, orderId: dto.salesOrderId, packageId: dto.retailPackageId, locationId, subject: dto.subject.trim(), description: dto.description.trim(), rating: dto.rating } });
      await this.audit(tx, user.id, feedback.id, feedback.caseNumber, 'CREATED', feedback.version);
      return feedback;
    });
  }

  async findAll(query: QueryFeedbackDto, user: AuthenticatedUser) {
    const where: Prisma.FeedbackCaseWhereInput = { status: query.status, type: query.type };
    if (user.role === Role.CUSTOMER) {
      const customer = await this.prisma.customer.findUnique({ where: { userId: user.id } });
      if (!customer) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
      where.customerId = customer.id;
    } else if (user.role === Role.STAFF) where.locationId = resolveLocationScope(user, query.locationId);
    else if (query.locationId) where.locationId = query.locationId;
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedbackCase.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: query.pageSize, include: { customer: true, assignedToUser: { select: { id: true, fullName: true } }, _count: { select: { messages: true } } } }),
      this.prisma.feedbackCase.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const item = await this.prisma.feedbackCase.findUnique({ where: { id }, include: { customer: true, assignedToUser: { select: { id: true, fullName: true } }, messages: { orderBy: { createdAt: 'asc' } } } });
    if (!item) throw new NotFoundException('Không tìm thấy phản hồi');
    this.assertAccess(item, user);
    if (user.role === Role.CUSTOMER) item.messages = item.messages.filter((message) => message.visibility === 'PUBLIC');
    return item;
  }

  async addMessage(id: string, dto: AddFeedbackMessageDto, user: AuthenticatedUser) {
    const item = await this.prisma.feedbackCase.findUnique({ where: { id }, include: { customer: true } });
    if (!item) throw new NotFoundException('Không tìm thấy phản hồi');
    this.assertAccess(item, user);
    if (item.status === FeedbackStatus.CLOSED) throw new ConflictException('Phản hồi đã đóng');
    if (user.role === Role.CUSTOMER && dto.visibility === 'INTERNAL') throw new ForbiddenException('Khách hàng không thể tạo ghi chú nội bộ');
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.feedbackMessage.create({ data: { feedbackCaseId: id, authorUserId: user.role === Role.CUSTOMER ? undefined : user.id, authorCustomerId: user.role === Role.CUSTOMER ? item.customerId : undefined, message: dto.message.trim(), visibility: user.role === Role.CUSTOMER ? 'PUBLIC' : dto.visibility || 'PUBLIC' } });
      const nextVersion = item.version + 1;
      await tx.feedbackCase.update({ where: { id }, data: { status: user.role === Role.CUSTOMER && item.status === FeedbackStatus.WAITING_CUSTOMER ? FeedbackStatus.IN_PROGRESS : undefined, version: { increment: 1 } } });
      await this.audit(tx, user.id, id, item.caseNumber, 'MESSAGE_ADDED', nextVersion);
      return message;
    });
  }

  async update(id: string, dto: UpdateFeedbackDto, user: AuthenticatedUser) {
    const current = await this.prisma.feedbackCase.findUnique({ where: { id }, include: { customer: true } });
    if (!current) throw new NotFoundException('Không tìm thấy phản hồi');
    this.assertAccess(current, user);
    if (dto.status && dto.status !== current.status && !transitions[current.status].includes(dto.status)) throw new ConflictException('Chuyển trạng thái phản hồi không hợp lệ');
    const resolved = dto.status === FeedbackStatus.RESOLVED || dto.status === FeedbackStatus.CLOSED;
    if (resolved && !dto.resolution?.trim()) throw new BadRequestException('Phải nhập kết quả xử lý');
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.feedbackCase.updateMany({ where: { id, version: dto.version }, data: { status: dto.status, priority: dto.priority, assignedToUserId: dto.assignedToUserId, resolution: dto.resolution?.trim(), resolvedAt: resolved ? new Date() : undefined, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('Phản hồi đã được cập nhật; hãy tải lại');
      const updated = await tx.feedbackCase.findUniqueOrThrow({ where: { id } });
      await this.audit(tx, user.id, id, updated.caseNumber, 'UPDATED', updated.version);
      return updated;
    });
  }

  private assertAccess(item: { customer: { userId: string | null }; locationId: string | null }, user: AuthenticatedUser) {
    if (user.role === Role.ADMIN) return;
    if (user.role === Role.CUSTOMER) {
      if (item.customer.userId !== user.id) throw new ForbiddenException('Không có quyền truy cập phản hồi này');
      return;
    }
    if (!item.locationId) throw new ForbiddenException('Phản hồi chưa có phạm vi địa điểm');
    assertLocationAccess(user, item.locationId);
  }

  private async audit(tx: Prisma.TransactionClient, actorId: string, id: string, caseNumber: string, action: string, version: number) {
    await tx.auditLog.create({ data: { entityType: 'FeedbackCase', entityId: id, action: `FEEDBACK_${action}`, performedBy: actorId, actorUserId: actorId, changeSummary: { caseNumber, action } } });
    await tx.outboxEvent.create({ data: { eventId: randomUUID(), aggregateType: 'FeedbackCase', aggregateId: id, aggregateVersion: version, eventType: `feedback.${action.toLowerCase()}`, payload: { feedbackId: id, caseNumber } } });
  }
}
