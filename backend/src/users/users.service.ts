import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import { CreateUserDto, ListUsersDto } from './users.dto';

const activeScope: Prisma.UserRoleScopeWhereInput = {
  active: true, role: { active: true },
  OR: [
    { scopeType: 'COMPANY', branchId: null, role: { code: 'ADMIN' } },
    { scopeType: 'BRANCH', role: { code: 'DISPATCHER' }, branch: { active: true } },
  ],
};
// Allowlist keeps password, session IDs and legacy authorization columns out of all responses.
const userSelect = {
  id: true, username: true, fullName: true, active: true, createdAt: true,
  roleScopes: {
    where: activeScope,
    select: { scopeType: true, role: { select: { code: true, name: true } }, branch: { select: { id: true, code: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsGateway) {}

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

  async create(dto: CreateUserDto) {
    const password = await bcrypt.hash(dto.password, 12);
    try {
      return await this.prisma.$transaction(async tx => {
        // Hold active role/branches stable until all scopes have been written.
        const roles = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM roles WHERE code = ${dto.roleCode} AND active = true FOR SHARE`;
        if (!roles.length) throw new BadRequestException({ code: 'ROLE_UNAVAILABLE', field: 'roleCode', message: 'Vai trò DISPATCHER không tồn tại hoặc đã ngừng hoạt động' });
        const branches = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM branches WHERE id IN (${Prisma.join(dto.branchIds)}) AND active = true ORDER BY id FOR SHARE`;
        if (branches.length !== dto.branchIds.length) throw new BadRequestException({ code: 'BRANCH_UNAVAILABLE', field: 'branchIds', message: 'Một hoặc nhiều chi nhánh không tồn tại hoặc đã ngừng hoạt động' });
        return tx.user.create({
          data: { username: dto.username, fullName: dto.fullName, password, roleScopes: { create: dto.branchIds.map(branchId => ({ roleId: roles[0].id, scopeType: 'BRANCH', branchId })) } },
          select: userSelect,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'USERNAME_EXISTS', field: 'username', message: 'Tên đăng nhập đã tồn tại' });
      }
      throw error;
    }
  }

  async lock(id: string, actorId: string) {
    if (id === actorId) throw new BadRequestException({ code: 'SELF_LOCK_DENIED', message: 'Không thể tự khóa tài khoản của bạn' });
    const result = await this.prisma.$transaction(async tx => {
      // Same row lock as login: a concurrent login cannot leave an unrevoked session behind.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
      if (!rows.length) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại' });
      const user = await tx.user.update({ where: { id }, data: { active: false }, select: userSelect });
      await tx.authSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      return user;
    });
    this.events.disconnectUser(id);
    return result;
  }
}
