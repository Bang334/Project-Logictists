import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { AccountVersionDto, CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';

const activeScope: Prisma.UserRoleScopeWhereInput = {
  active: true, role: { active: true },
  OR: [
    { scopeType: 'COMPANY', branchId: null, role: { code: 'ADMIN' } },
    { scopeType: 'BRANCH', role: { code: 'DISPATCHER' }, branch: { active: true } },
    { scopeType: 'BRANCH', role: { code: 'DRIVER' }, branch: { active: true } },
  ],
};
// Allowlist keeps credentials and session IDs out; role describes account type, not authority.
const userSelect = {
  id: true, username: true, fullName: true, role: true, active: true, createdAt: true, updatedAt: true,
  roleScopes: {
    where: activeScope,
    select: { scopeType: true, role: { select: { code: true, name: true } }, branch: { select: { id: true, code: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsGateway, private readonly config: ConfigService) {}

  async list(query: ListUsersDto) {
    const where: Prisma.UserWhereInput = {
      ...(query.search ? { OR: [{ username: { contains: query.search, mode: 'insensitive' } }, { fullName: { contains: query.search, mode: 'insensitive' } }] } : {}),
      ...(query.status ? { active: query.status === 'active' } : {}),
      ...(query.branchId ? { roleScopes: { some: { ...activeScope, branchId: query.branchId } } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: userSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.user.count({ where }),
    ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async availableDrivers(query: ListUsersDto) {
    const where: Prisma.DriverWhereInput = { userId: null, homeBranch: { active: true }, ...(query.search ? { fullName: { contains: query.search, mode: 'insensitive' } } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.driver.findMany({ where, select: { id: true, fullName: true, homeBranchId: true }, orderBy: { id: 'asc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.driver.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async detail(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { ...userSelect, roleScopes: { select: { active: true, scopeType: true, role: { select: { code: true, name: true, active: true } }, branch: { select: { id: true, code: true, name: true, active: true } } }, orderBy: { createdAt: 'asc' } } } });
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    return { ...user, roleScopes: user.roleScopes.filter(scope => scope.active && scope.role.active && (scope.scopeType === 'COMPANY' || scope.branch?.active)), scopeHistory: user.roleScopes };
  }

  async edit(id: string, dto: UpdateUserDto | AccountVersionDto, actorId: string, unlock = false) {
    if (id === actorId) throw new ForbiddenException({ code: 'SELF_EDIT_DENIED', message: 'Không được tự sửa quyền hoặc trạng thái tài khoản' });
    const result = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
      const target = await tx.user.findUnique({ where: { id }, include: { roleScopes: { include: { role: true } } } });
      if (!target) throw new NotFoundException('Không tìm thấy tài khoản');
      if (!['DRIVER', 'DISPATCHER'].includes(target.role) || target.roleScopes.some(scope => scope.role.code === 'ADMIN')) throw new ForbiddenException('Chỉ quản lý DRIVER và DISPATCHER; không sửa ADMIN');
      if (unlock && target.active) return tx.user.findUniqueOrThrow({ where: { id }, select: userSelect });
      if (target.updatedAt.toISOString() !== new Date(dto.expectedUpdatedAt).toISOString()) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Tài khoản đã thay đổi. Hãy tải lại' });
      if ('branchIds' in dto && dto.branchIds) {
        if (target.role !== 'DISPATCHER' || target.roleScopes.some(scope => scope.role.code !== 'DISPATCHER')) throw new ForbiddenException('Phạm vi DRIVER lấy từ hồ sơ tài xế, không sửa qua User');
        const branches = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM branches WHERE id IN (${Prisma.join(dto.branchIds)}) AND active = true ORDER BY id FOR SHARE`;
        if (branches.length !== dto.branchIds.length) throw new BadRequestException({ code: 'BRANCH_UNAVAILABLE', field: 'branchIds', message: 'Chi nhánh không tồn tại hoặc đã ngừng hoạt động' });
        const role = await tx.accessRole.findUnique({ where: { code: 'DISPATCHER' } });
        if (!role?.active) throw new BadRequestException('Vai trò DISPATCHER không hoạt động');
        await tx.userRoleScope.updateMany({ where: { userId: id, roleId: role.id }, data: { active: false } });
        for (const branchId of dto.branchIds) {
          await tx.userRoleScope.upsert({ where: { userId_roleId_scopeType_branchId: { userId: id, roleId: role.id, scopeType: 'BRANCH', branchId } }, create: { userId: id, roleId: role.id, scopeType: 'BRANCH', branchId }, update: { active: true } });
        }
      }
      if (unlock) {
        const unavailable = await tx.userRoleScope.count({ where: { userId: id, active: true, scopeType: 'BRANCH', branch: { active: false } } });
        if (unavailable) throw new ConflictException({ code: 'BRANCH_UNAVAILABLE', message: 'Tài khoản còn scope tại chi nhánh đã ngừng' });
      }
      const user = await tx.user.update({ where: { id }, data: { updatedAt: new Date(Math.max(Date.now(), target.updatedAt.getTime() + 1)), ...(unlock ? { active: true } : { ...('fullName' in dto ? { fullName: dto.fullName } : {}) }) }, select: userSelect });
      if (!unlock) await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditLog.create({ data: { entityType: 'User', entityId: id, action: unlock ? 'ACCOUNT_UNLOCKED' : 'ACCOUNT_UPDATED', performedBy: actorId, actorUserId: actorId, changeSummary: { fields: Object.keys(dto).filter(key => key !== 'expectedUpdatedAt') } } });
      return user;
    });
    if (!unlock) this.events.disconnectUser(id);
    return result;
  }

  async create(dto: CreateUserDto, actorId: string, idempotencyKey: string) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(idempotencyKey)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Cần Idempotency-Key từ 16 đến 100 ký tự' });
    if ((dto.roleCode === 'DRIVER') !== !!dto.driverId) throw new BadRequestException({ code: 'DRIVER_LINK_REQUIRED', field: 'driverId', message: 'Tài khoản DRIVER phải chọn hồ sơ tài xế; DISPATCHER không được liên kết tài xế' });
    const password = await bcrypt.hash(dto.password, 12);
    // A keyed digest prevents the command log from becoming a password guessing oracle.
    const requestHash = createHmac('sha256', this.config.getOrThrow<string>('JWT_SECRET')).update(JSON.stringify([dto.username, dto.fullName, dto.password, dto.roleCode, [...dto.branchIds].sort(), dto.driverId ?? null])).digest('hex');
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4204, hashtext(${actorId + ':' + idempotencyKey}))`;
        const prior = await tx.processedCommand.findUnique({ where: { actorUserId_commandType_idempotencyKey: { actorUserId: actorId, commandType: 'CREATE_ACCOUNT', idempotencyKey } } });
        if (prior) {
          if (prior.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Khóa yêu cầu đã dùng cho nội dung khác' });
          const result = prior.result;
          if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.id !== 'string') throw new ConflictException('Kết quả lệnh không hợp lệ');
          return tx.user.findUniqueOrThrow({ where: { id: result.id }, select: userSelect });
        }
        // Hold active role/branches stable until all scopes have been written.
        const roles = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM roles WHERE code = ${dto.roleCode} AND active = true FOR SHARE`;
        if (!roles.length) throw new BadRequestException({ code: 'ROLE_UNAVAILABLE', field: 'roleCode', message: 'Vai trò không tồn tại hoặc đã ngừng hoạt động' });
        const branches = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM branches WHERE id IN (${Prisma.join(dto.branchIds)}) AND active = true ORDER BY id FOR SHARE`;
        if (branches.length !== dto.branchIds.length) throw new BadRequestException({ code: 'BRANCH_UNAVAILABLE', field: 'branchIds', message: 'Một hoặc nhiều chi nhánh không tồn tại hoặc đã ngừng hoạt động' });
        let fullName = dto.fullName;
        let employeeId: string | null = null;
        if (dto.driverId) {
          await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${dto.driverId} FOR UPDATE`;
          const driver = await tx.driver.findUnique({ where: { id: dto.driverId } });
          if (!driver || driver.userId || dto.branchIds.length !== 1 || dto.branchIds[0] !== driver.homeBranchId) throw new ConflictException({ code: 'DRIVER_UNAVAILABLE', field: 'driverId', message: 'Tài xế đã có tài khoản hoặc chi nhánh không khớp hồ sơ' });
          employeeId = driver.employeeId;
          if (employeeId) {
            await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE`;
            const employee = await tx.employee.findUniqueOrThrow({ where: { id: employeeId } });
            if (employee.userId || employee.employmentStatus !== 'ACTIVE' || employee.branchId !== driver.homeBranchId) throw new ConflictException({ code: 'EMPLOYEE_UNAVAILABLE', field: 'driverId', message: 'Nhân viên đã có tài khoản, không hoạt động hoặc khác chi nhánh' });
          }
          fullName = driver.fullName;
        }
        const user = await tx.user.create({
          data: { role: dto.roleCode, username: dto.username, fullName, password, roleScopes: { create: dto.branchIds.map(branchId => ({ roleId: roles[0].id, scopeType: 'BRANCH', branchId })) } },
          select: userSelect,
        });
        if (dto.driverId) await tx.driver.update({ where: { id: dto.driverId }, data: { userId: user.id } });
        if (employeeId) await tx.employee.update({ where: { id: employeeId }, data: { userId: user.id, version: { increment: 1 } } });
        await tx.auditLog.create({ data: { entityType: 'User', entityId: user.id, action: 'ACCOUNT_CREATED', performedBy: actorId, actorUserId: actorId, changeSummary: { roleCode: dto.roleCode, branchIds: dto.branchIds } } });
        await tx.processedCommand.create({ data: { actorUserId: actorId, commandType: 'CREATE_ACCOUNT', idempotencyKey, requestHash, status: 'COMPLETED', result: { id: user.id } } });
        return user;
      }, { timeout: 15000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'USERNAME_EXISTS', field: 'username', message: 'Tên đăng nhập đã tồn tại' });
      }
      throw error;
    }
  }

  async lock(id: string, actorId: string, expectedUpdatedAt: string) {
    if (id === actorId) throw new BadRequestException({ code: 'SELF_LOCK_DENIED', message: 'Không thể tự khóa tài khoản của bạn' });
    const result = await this.prisma.$transaction(async tx => {
      // Same row lock as login: a concurrent login cannot leave an unrevoked session behind.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại' });
      const target = await tx.user.findUniqueOrThrow({ where: { id }, select: { active: true, updatedAt: true, role: true, roleScopes: { select: { role: { select: { code: true } } } } } });
      if (target.role === 'ADMIN' || target.roleScopes.some(scope => scope.role.code === 'ADMIN') || !['DRIVER', 'DISPATCHER'].includes(target.role)) {
        throw new ForbiddenException({ code: 'ACCOUNT_TARGET_DENIED', message: 'Chỉ được khóa tài khoản DRIVER hoặc DISPATCHER; không được khóa ADMIN' });
      }
      if (target.active && target.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Tài khoản đã thay đổi. Hãy tải lại' });
      const user = target.active ? await tx.user.update({ where: { id }, data: { active: false, updatedAt: new Date(Math.max(Date.now(), target.updatedAt.getTime() + 1)) }, select: userSelect }) : await tx.user.findUniqueOrThrow({ where: { id }, select: userSelect });
      await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (target.active) await tx.auditLog.create({ data: { entityType: 'User', entityId: id, action: 'ACCOUNT_LOCKED', performedBy: actorId, actorUserId: actorId, changeSummary: { active: false } } });
      return user;
    });
    this.events.disconnectUser(id);
    return result;
  }
}
