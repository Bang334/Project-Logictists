import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PackageStatus, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Principal, branchFilter, requireBranch } from '../auth/access';
import { ResourceAccess } from '../auth/resource-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ConfirmOrderDto, UpdateOrderDto } from './dto/update-order.dto';
import { assertDispatchableOrder, assertPackageManifest, orderFieldError, orderInclude, OrderRecord, serializeOrder, validateOrderInput } from './order-contract';
import { packageTotals } from './package-measurements';

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService, private access: ResourceAccess) {}

  async findAll(user: Principal, status?: OrderStatus, customerId?: string, branchId?: string, page = 1, pageSize = 25, search?: string) {
    const where: Prisma.OrderWhereInput = {
      ...(status ? { status } : {}), ...(customerId ? { customerId } : {}),
      branchId: branchFilter(user, 'orders.read', branchId),
      ...(search ? { OR: [{ orderNumber: { contains: search, mode: 'insensitive' } }, { customer: { name: { contains: search, mode: 'insensitive' } } }] } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({ where, include: orderInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items: rows.map(serializeOrder), total, page, pageSize };
  }
  async findOne(id: string, user: Principal) {
    const order = await this.prisma.order.findFirst({ where: { id, branchId: branchFilter(user, 'orders.read') }, include: orderInclude });
    if (!order) throw new NotFoundException('Đơn không tồn tại hoặc ngoài phạm vi');
    return serializeOrder(order);
  }
  async getAvailableForDispatch(user: Principal, branchId?: string) {
    const rows = await this.prisma.order.findMany({
      where: { status: OrderStatus.CONFIRMED, packageDataStatus: 'COMPLETE', branchId: branchFilter(user, 'orders.read', branchId), items: { none: { allocations: { some: {} } } } },
      include: orderInclude, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 501,
    });
    if (rows.length > 500) throw new BadRequestException({ code: 'DISPATCH_SELECTION_TOO_LARGE', message: 'Có hơn 500 đơn chờ; hãy thu hẹp chi nhánh trước khi lập kế hoạch' });
    rows.forEach(assertDispatchableOrder);
    return rows.map(serializeOrder);
  }
  private async command(user: Principal, kind: string, key: string | undefined, payload: unknown, write: (tx: Prisma.TransactionClient, commandId: string) => Promise<string>) {
    if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Cần Idempotency-Key từ 16 đến 100 ký tự' });
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4201, hashtext(${user.id + ':' + kind + ':' + key}))`;
      const prior = await tx.processedCommand.findUnique({ where: { actorUserId_commandType_idempotencyKey: { actorUserId: user.id, commandType: kind, idempotencyKey: key } } });
      if (prior) {
        if (prior.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Khóa yêu cầu đã dùng với nội dung khác' });
        const result = prior.result;
        if (!result || Array.isArray(result) || typeof result !== 'object' || typeof result.id !== 'string') throw new ConflictException('Kết quả yêu cầu trước không hợp lệ');
        const allowed = await tx.order.findFirst({ where: { id: result.id, branchId: branchFilter(user, 'orders.write') }, select: { id: true } });
        if (!allowed) throw new NotFoundException('Đơn không tồn tại hoặc ngoài phạm vi');
        return result;
      }
      const commandId = randomUUID();
      await tx.processedCommand.create({ data: { id: commandId, actorUserId: user.id, commandType: kind, idempotencyKey: key, requestHash: hash, status: 'PROCESSING' } });
      const id = await write(tx, commandId);
      const order = await tx.order.findUniqueOrThrow({ where: { id }, include: orderInclude });
      const result = json(serializeOrder(order));
      await tx.processedCommand.update({ where: { id: commandId }, data: { status: 'COMPLETED', result } });
      return result;
    }, { timeout: 20000, maxWait: 10000 });
  }
  async create(dto: CreateOrderDto, user: Principal, key?: string) {
    validateOrderInput(dto, false);
    if (dto.stops.some(s => s.id) || dto.items.some(i => i.id || i.packages.some(p => p.id))) orderFieldError('items', 'Đơn mới không nhận ID dòng hàng, stop hoặc kiện có sẵn');
    const branchId = requireBranch(user, 'orders.write', dto.branchId);
    return this.command(user, 'ORDER_CREATE', key, dto, async (tx, commandId) => {
      await this.access.branch(user, 'orders.write', branchId, tx);
      await this.access.customer(user, dto.customerId, branchId, tx);
      const id = randomUUID();
      await tx.order.create({ data: { id, orderNumber: 'ORD-' + randomUUID().toUpperCase(), customerId: dto.customerId, branchId, status: OrderStatus.DRAFT, packageDataStatus: 'COMPLETE', notes: dto.notes } });
      await this.writeContents(tx, id, dto, PackageStatus.DRAFT);
      await tx.orderEvent.create({ data: { orderId: id, commandId, actorUserId: user.id, eventType: 'CREATED', toStatus: 'DRAFT' } });
      return id;
    });
  }
  private async lockedOrder(tx: Prisma.TransactionClient, id: string, user: Principal, version: number) {
    // Same order row protects edits from manual and automatic assignment transactions.
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { id, branchId: branchFilter(user, 'orders.write') }, include: orderInclude });
    if (!order) throw new NotFoundException('Đơn không tồn tại hoặc ngoài phạm vi');
    if (order.version !== version) throw new ConflictException({ code: 'ORDER_VERSION_CONFLICT', message: 'Đơn đã thay đổi. Tải lại để đối chiếu trước khi lưu' });
    if (!['DRAFT', 'CONFIRMED'].includes(order.status)) throw new ConflictException({ code: 'ORDER_LOCKED', message: 'Đơn đã tham gia vận chuyển; không được sửa dữ liệu hàng/điểm/giờ' });
    const [allocation, task, delivery] = await Promise.all([
      tx.allocation.findFirst({ where: { orderItem: { orderId: id } }, select: { id: true } }),
      tx.stopTask.findFirst({ where: { orderStop: { orderId: id } }, select: { id: true } }),
      tx.deliveryResult.findFirst({ where: { package: { orderItem: { orderId: id } } }, select: { id: true } }),
    ]);
    if (allocation || task || delivery || order.items.some(i => i.packages.some(p => !['DRAFT', 'READY'].includes(p.status)))) throw new ConflictException({ code: 'ORDER_REFERENCED', message: 'Đơn/kiện có phân công hoặc lịch sử giao nhận; không thể sửa hay xóa' });
    return order;
  }
  async update(id: string, dto: UpdateOrderDto, user: Principal, key?: string) {
    return this.command(user, 'ORDER_UPDATE', key, { id, ...dto }, async (tx, commandId) => {
      const old = await this.lockedOrder(tx, id, user, dto.version);
      if (dto.branchId !== old.branchId) orderFieldError('branchId', 'Không chuyển chi nhánh quản lý qua thao tác sửa đơn');
      await this.access.branch(user, 'orders.write', old.branchId, tx);
      await this.access.customer(user, dto.customerId, old.branchId, tx);
      validateOrderInput(dto, old.status === 'CONFIRMED');
      this.validateOwnedIds(old, dto);
      await this.writeContents(tx, id, dto, old.status === 'CONFIRMED' ? PackageStatus.READY : PackageStatus.DRAFT, old);
      await tx.order.update({ where: { id }, data: { customerId: dto.customerId, notes: dto.notes ?? null, packageDataStatus: 'COMPLETE', version: { increment: 1 } } });
      await tx.orderEvent.create({ data: { orderId: id, commandId, actorUserId: user.id, eventType: old.packageDataStatus === 'COMPLETE' ? 'UPDATED' : 'PACKAGES_RECONCILED', fromStatus: old.status, toStatus: old.status, payload: json({ before: serializeOrder(old), source: 'USER_DECLARED' }) } });
      return id;
    });
  }
  async confirm(id: string, dto: ConfirmOrderDto, user: Principal, key?: string) {
    return this.command(user, 'ORDER_CONFIRM', key, { id, ...dto }, async (tx, commandId) => {
      const order = await this.lockedOrder(tx, id, user, dto.version);
      if (order.status !== 'DRAFT') throw new ConflictException({ code: 'ORDER_NOT_DRAFT', message: 'Chỉ xác nhận đơn nháp' });
      assertPackageManifest(order);
      validateOrderInput({ ...order, notes: order.notes ?? undefined, stops: order.stops.map(s => ({ ...s, type: s.type === 'PICKUP' ? 'PICKUP' : 'DELIVERY', windowStart: s.windowStart?.toISOString(), windowEnd: s.windowEnd?.toISOString() })), items: order.items.map(i => ({ ...i, sku: i.sku ?? undefined, packages: i.packages.map(p => ({ ...p, weightG: p.weightG.toString() })) })) }, true);
      await this.access.branch(user, 'orders.write', order.branchId, tx);
      await this.access.customer(user, order.customerId, order.branchId, tx);
      await tx.package.updateMany({ where: { orderItem: { orderId: id } }, data: { status: PackageStatus.READY, version: { increment: 1 } } });
      await tx.order.update({ where: { id }, data: { status: OrderStatus.CONFIRMED, version: { increment: 1 } } });
      await tx.orderEvent.create({ data: { orderId: id, commandId, actorUserId: user.id, eventType: 'CONFIRMED', fromStatus: 'DRAFT', toStatus: 'CONFIRMED' } });
      return id;
    });
  }
  private validateOwnedIds(old: OrderRecord, dto: CreateOrderDto) {
    dto.stops.forEach((s, i) => { if (!s.id || !old.stops.some(o => o.id === s.id && o.type === s.type)) orderFieldError(`stops.${i}.id`, 'Phải giữ ID và loại điểm của đơn này'); });
    dto.items.forEach((item, i) => {
      if (item.id && !old.items.some(o => o.id === item.id)) orderFieldError(`items.${i}.id`, 'Dòng hàng không thuộc đơn');
      item.packages.forEach((p, j) => { if (p.id && !old.items.find(o => o.id === item.id)?.packages.some(o => o.id === p.id)) orderFieldError(`items.${i}.packages.${j}.id`, 'Kiện không thuộc dòng hàng này'); });
    });
    if (old.packageDataStatus !== 'COMPLETE' && old.items.some(i => !dto.items.some(n => n.id === i.id))) orderFieldError('items', 'Đối soát phải giữ các dòng hàng cũ để lưu căn cứ');
  }
  private async writeContents(tx: Prisma.TransactionClient, orderId: string, dto: CreateOrderDto, status: PackageStatus, old?: OrderRecord) {
    for (const stop of dto.stops) {
      const { id, ...input } = stop;
      const data = { ...input, orderId, sequence: stop.type === 'PICKUP' ? 1 : 2, windowBasis: 'SERVICE_START', windowStart: stop.windowStart ? new Date(stop.windowStart) : null, windowEnd: stop.windowEnd ? new Date(stop.windowEnd) : null };
      if (id) await tx.orderStop.update({ where: { id }, data });
      else await tx.orderStop.create({ data });
    }
    if (old) {
      const retained = dto.items.flatMap(i => i.packages.flatMap(p => p.id ? [p.id] : []));
      await tx.package.deleteMany({ where: { orderItem: { orderId }, id: { notIn: retained } } });
      await tx.orderItem.deleteMany({ where: { orderId, id: { notIn: dto.items.flatMap(i => i.id ? [i.id] : []) } } });
    }
    for (const item of dto.items) {
      const totals = packageTotals(item.packages.map(p => ({ ...p, weightG: BigInt(p.weightG) })));
      const data = { orderId, sku: item.sku ?? null, description: item.description.trim(), packageType: item.packageType, quantity: totals.totalPackages, weightKg: Number(totals.weightG) / 1000, volumeM3: Number(totals.volumeMm3) / 1e9, lengthCm: null, widthCm: null, heightCm: null };
      const line = item.id ? await tx.orderItem.update({ where: { id: item.id }, data }) : await tx.orderItem.create({ data });
      for (const p of item.packages) {
        const data = { lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: BigInt(p.weightG), measurementSource: 'USER_DECLARED', status };
        if (p.id) await tx.package.update({ where: { id: p.id }, data: { ...data, version: { increment: 1 } } });
        else await tx.package.create({ data: { ...data, orderItemId: line.id, packageCode: 'PKG-' + randomUUID().toUpperCase(), allowedOrientations: Prisma.DbNull } });
      }
    }
    const totals = packageTotals(dto.items.flatMap(i => i.packages.map(p => ({ ...p, weightG: BigInt(p.weightG) }))));
    await tx.order.update({ where: { id: orderId }, data: { totalPackages: totals.totalPackages, totalWeightKg: Number(totals.weightG) / 1000, totalVolumeM3: Number(totals.volumeMm3) / 1e9 } });
  }
}
