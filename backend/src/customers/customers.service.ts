import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Principal, assertPermission, branchFilter, hasPermission } from '../auth/access';
import { canEditCustomer, customerFilter } from '../auth/customer-access';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCustomerDto, CustomerProfileDto, CustomerQueryDto, UpdateCustomerDto } from './customers.dto';

const profileSelect = {
  id: true, code: true, name: true, phone: true, email: true, address: true, contactPerson: true, taxCode: true,
  version: true, createdAt: true, updatedAt: true,
  branches: { select: { branch: { select: { id: true, code: true, name: true, active: true } } } },
} satisfies Prisma.CustomerSelect;
type Profile = Prisma.CustomerGetPayload<{ select: typeof profileSelect }>;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
function profileData(dto: CustomerProfileDto) {
  return { name: dto.name, phone: dto.phone, email: dto.email ?? null, address: dto.address ?? null, contactPerson: dto.contactPerson ?? null, taxCode: dto.taxCode ?? null };
}
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}
  private serialize(row: Profile, user: Principal) {
    return { ...row, branches: row.branches.filter(b => hasPermission(user, 'customers.read', b.branch.id)).map(b => b.branch),
      canEdit: canEditCustomer(user, row.branches.map(b => b.branch.id)), canManageScope: hasPermission(user, 'customers.manage') };
  }
  private async profile(id: string, user: Principal, db: Prisma.TransactionClient = this.prisma, branchId?: string) {
    const row = await db.customer.findFirst({ where: { id, ...customerFilter(user, branchId) }, select: profileSelect });
    if (!row) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Khách hàng không tồn tại hoặc ngoài phạm vi được cấp' });
    return row;
  }
  async list(user: Principal, query: CustomerQueryDto) {
    const { search, page, pageSize, branchId } = query;
    const where: Prisma.CustomerWhereInput = { ...customerFilter(user, branchId), ...(search ? {
      OR: ['code', 'name', 'phone', 'email', 'contactPerson', 'taxCode'].map(field => ({ [field]: { contains: search, mode: 'insensitive' } })),
    } : {}) };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.customer.count({ where }), this.prisma.customer.findMany({ where, select: profileSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items: rows.map(r => this.serialize(r, user)), total, page, pageSize };
  }
  async lookup(user: Principal, query: CustomerQueryDto) {
    const result = await this.list(user, query);
    return { ...result, items: result.items.map(({ id, code, name }) => ({ id, code, name })) };
  }
  // Preserve the legacy array contract; in-repo selectors use paginated lookup.
  async findAll(user: Principal, branchId?: string) {
    const rows = await this.prisma.customer.findMany({ where: customerFilter(user, branchId), select: profileSelect,
      orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 501 });
    if (rows.length > 500) throw new BadRequestException({ code: 'CUSTOMER_LOOKUP_REQUIRED', message: 'Danh sách lớn; hãy dùng API /customers/lookup có phân trang' });
    const scope = hasPermission(user, 'orders.read', branchId ?? user.selectedBranchId) ? branchFilter(user, 'orders.read', branchId) : { in: [] };
    const counts = await this.prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: rows.map(r => r.id) }, branchId: scope, orderType: 'B2B_TRANSPORT' }, _count: true });
    const byId = new Map(counts.map(c => [c.customerId, c._count]));
    return rows.map(r => ({ ...this.serialize(r, user), _count: { orders: byId.get(r.id) ?? 0 } }));
  }
  async findOne(id: string, user: Principal, branchId?: string) {
    const profile = this.serialize(await this.profile(id, user, this.prisma, branchId), user);
    const orders = hasPermission(user, 'orders.read', branchId ?? user.selectedBranchId) ? await this.prisma.order.findMany({ where: {
      customerId: id, orderType: 'B2B_TRANSPORT', branchId: branchFilter(user, 'orders.read', branchId),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 10 }) : [];
    return { ...profile, orders };
  }
  async orders(id: string, user: Principal, query: CustomerQueryDto) {
    await this.profile(id, user, this.prisma, query.branchId);
    const where: Prisma.OrderWhereInput = { customerId: id, orderType: 'B2B_TRANSPORT', branchId: branchFilter(user, 'orders.read', query.branchId) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.order.count({ where }), this.prisma.order.findMany({ where, select: { id: true, orderNumber: true, status: true, createdAt: true, branch: { select: { id: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items, total, page: query.page, pageSize: query.pageSize };
  }
  private async checkBranches(ids: string[], user: Principal, tx: Prisma.TransactionClient) {
    for (const id of ids) assertPermission(user, 'customers.write', id);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM branches WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`);
    if (await tx.branch.count({ where: { id: { in: ids }, active: true } }) !== ids.length) {
      throw new BadRequestException({ code: 'CUSTOMER_BRANCH_INVALID', message: 'Chi nhánh không tồn tại hoặc ngừng hoạt động', fieldErrors: [{ field: 'branchIds', message: 'Chọn các chi nhánh đang hoạt động và được cấp quyền' }] });
    }
    if (user.selectedBranchId && !ids.includes(user.selectedBranchId)) throw new ForbiddenException({ code: 'CUSTOMER_SCOPE_MISMATCH', message: 'Hồ sơ phải thuộc chi nhánh đang chọn' });
  }
  private async command(user: Principal, kind: string, key: string | undefined, payload: unknown, write: (tx: Prisma.TransactionClient, commandId: string) => Promise<string>) {
    assertPermission(user, 'customers.write', user.selectedBranchId);
    assertPermission(user, 'customers.read', user.selectedBranchId);
    if (!key || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Cần Idempotency-Key từ 16 đến 100 ký tự' });
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4202, hashtext(${user.id + ':' + kind + ':' + key}))`;
        const previous = await tx.processedCommand.findUnique({ where: { actorUserId_commandType_idempotencyKey: { actorUserId: user.id, commandType: kind, idempotencyKey: key } } });
        if (previous) {
          if (previous.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Khóa yêu cầu đã dùng với nội dung khác' });
          const result = previous.result;
          if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.id !== 'string') throw new ConflictException({ code: 'COMMAND_INCOMPLETE', message: 'Chưa xác nhận được kết quả yêu cầu' });
          return this.serialize(await this.profile(result.id, user, tx), user);
        }
        const commandId = randomUUID();
        await tx.processedCommand.create({ data: { id: commandId, actorUserId: user.id, commandType: kind, idempotencyKey: key, requestHash: hash, status: 'PROCESSING' } });
        const id = await write(tx, commandId);
        const result = this.serialize(await this.profile(id, user, tx), user);
        await tx.processedCommand.update({ where: { id: commandId }, data: { status: 'COMPLETED', result: { id } } });
        return result;
      }, { timeout: 20000, maxWait: 10000 });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'CUSTOMER_CONFLICT', message: 'Mã hồ sơ bị trùng. Vui lòng thử lại' });
      throw e;
    }
  }
  create(dto: CreateCustomerDto, user: Principal, key?: string) {
    const branches = [...dto.branchIds].sort(), data = profileData(dto);
    return this.command(user, 'CUSTOMER_CREATE', key, { ...data, branchIds: branches }, async (tx, commandId) => {
      await this.checkBranches(branches, user, tx);
      const id = randomUUID();
      await tx.customer.create({ data: { id, code: 'CUS-' + randomUUID().toUpperCase(), ...data, branches: { create: branches.map(branchId => ({ branchId })) } } });
      await tx.auditLog.create({ data: { entityType: 'Customer', entityId: id, action: 'CREATE', performedBy: user.id, actorUserId: user.id, correlationId: commandId, changeSummary: { version: 1, branchIds: branches, fields: Object.keys(data) } } });
      return id;
    });
  }
  update(id: string, dto: UpdateCustomerDto, user: Principal, key?: string) {
    const branches = dto.branchIds ? [...dto.branchIds].sort() : undefined, data = profileData(dto);
    return this.command(user, 'CUSTOMER_UPDATE', key, { id, version: dto.version, ...data, branchIds: branches }, async (tx, commandId) => {
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id} FOR UPDATE`;
      const old = await this.profile(id, user, tx);
      if (!canEditCustomer(user, old.branches.map(b => b.branch.id))) throw new ForbiddenException({ code: 'CUSTOMER_SHARED_READ_ONLY', message: 'Hồ sơ được chia sẻ ngoài phạm vi của bạn; cần ADMIN sửa' });
      if (old.version !== dto.version) throw new ConflictException({ code: 'CUSTOMER_VERSION_CONFLICT', message: 'Khách hàng đã được sửa. Tải lại hồ sơ để đối chiếu trước khi lưu' });
      if (branches) {
        assertPermission(user, 'customers.manage');
        await this.checkBranches(branches, user, tx);
        await tx.customerBranch.deleteMany({ where: { customerId: id, branchId: { notIn: branches } } });
        await tx.customerBranch.createMany({ data: branches.map(branchId => ({ customerId: id, branchId })), skipDuplicates: true });
      }
      await tx.customer.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { entityType: 'Customer', entityId: id, action: 'UPDATE', performedBy: user.id, actorUserId: user.id, correlationId: commandId,
        changeSummary: json({ fromVersion: old.version, toVersion: old.version + 1, fields: Object.keys(data).filter(k => data[k as keyof typeof data] !== old[k as keyof typeof data]), ...(branches ? { previousBranchIds: old.branches.map(b => b.branch.id), branchIds: branches } : {}) }) } });
      return id;
    });
  }
}
