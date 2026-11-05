import { Principal, branchFilter, assertPermission, hasPermission } from '../auth/access';
import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { LateDeliveryPenaltyMode, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { BranchListDto, BranchStatusDto, CreateBranchDto } from './dto/admin-branch.dto';
import { PrismaService } from '../prisma/prisma.service';
import { MapboxService } from '../mapbox/mapbox.service';
import { UpdateBranchDto } from './dto/update-branch.dto';

@Injectable()
export class BranchesService {
  constructor(
    private prisma: PrismaService,
    private mapboxService: MapboxService,
  ) {}

  async listAdmin(query: BranchListDto, user: Principal) {
    assertPermission(user, 'branches.manage');
    const where: Prisma.BranchWhereInput = { ...(query.status ? { active: query.status === 'active' } : {}), ...(query.search ? { OR: [{ code: { contains: query.search, mode: 'insensitive' } }, { name: { contains: query.search, mode: 'insensitive' } }] } : {}) };
    const [items, total] = await this.prisma.$transaction([this.prisma.branch.findMany({ where, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: { code: 'asc' } }), this.prisma.branch.count({ where })]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  private async command(user: Principal, kind: string, key: string, payload: unknown, write: (tx: Prisma.TransactionClient) => Promise<string>) {
    assertPermission(user, 'branches.manage');
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Cần Idempotency-Key từ 16 đến 100 ký tự' });
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4205, hashtext(${user.id + ':' + kind + ':' + key}))`;
        const old = await tx.processedCommand.findUnique({ where: { actorUserId_commandType_idempotencyKey: { actorUserId: user.id, commandType: kind, idempotencyKey: key } } });
        if (old) {
          if (old.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: 'Khóa yêu cầu đã dùng cho nội dung khác' });
          if (!old.result || typeof old.result !== 'object' || Array.isArray(old.result) || typeof old.result.id !== 'string') throw new ConflictException('Kết quả lệnh không hợp lệ');
          return tx.branch.findUniqueOrThrow({ where: { id: old.result.id } });
        }
        const id = await write(tx);
        await tx.processedCommand.create({ data: { actorUserId: user.id, commandType: kind, idempotencyKey: key, requestHash: hash, status: 'COMPLETED', result: { id } } });
        return tx.branch.findUniqueOrThrow({ where: { id } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException({ code: 'BRANCH_CODE_EXISTS', field: 'code', message: 'Mã chi nhánh đã tồn tại' });
      throw e;
    }
  }

  create(dto: CreateBranchDto, user: Principal, key: string) {
    return this.command(user, 'CREATE_BRANCH', key, [dto.code, dto.name, dto.address, dto.latitude, dto.longitude, dto.phone ?? null], async tx => {
      if (!dto.name.trim() || !dto.address.trim()) throw new BadRequestException('Tên và địa chỉ không được để trống');
      const branch = await tx.branch.create({ data: { ...dto, name: dto.name.trim(), address: dto.address.trim() } });
      await tx.auditLog.create({ data: { entityType: 'Branch', entityId: branch.id, action: 'BRANCH_CREATED', performedBy: user.id, actorUserId: user.id, changeSummary: { code: branch.code } } });
      return branch.id;
    });
  }

  async impacts(id: string, user: Principal, tx: Prisma.TransactionClient = this.prisma) {
    assertPermission(user, 'branches.manage');
    if (!await tx.branch.findUnique({ where: { id }, select: { id: true } })) throw new NotFoundException('Không tìm thấy chi nhánh');
    const [drivers, vehicles, accounts, customers, trips, orders, reservations] = await Promise.all([
      tx.driver.count({ where: { homeBranchId: id } }),
      tx.vehicle.count({ where: { homeBranchId: id, status: { not: 'DECOMMISSIONED' } } }),
      tx.user.count({ where: { active: true, roleScopes: { some: { branchId: id, active: true } } } }),
      tx.customer.count({ where: { branches: { some: { branchId: id } } } }),
      tx.trip.count({ where: { managingBranchId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
      tx.order.count({ where: { branchId: id, status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
      tx.resourceReservation.count({ where: { status: { in: ['HELD', 'ACTIVE'] }, OR: [{ trip: { managingBranchId: id } }, { vehicle: { homeBranchId: id } }, { driver: { homeBranchId: id } }] } }),
    ]);
    return { drivers, vehicles, accounts, customers, trips, orders, reservations };
  }

  setActive(id: string, dto: BranchStatusDto, user: Principal, key: string) {
    return this.command(user, 'BRANCH_STATUS', key, [id, dto.expectedUpdatedAt, dto.active], async tx => {
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${id} FOR UPDATE`;
      const branch = await tx.branch.findUnique({ where: { id } });
      if (!branch) throw new NotFoundException('Không tìm thấy chi nhánh');
      if (branch.updatedAt.toISOString() !== new Date(dto.expectedUpdatedAt).toISOString()) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Chi nhánh đã thay đổi. Hãy tải lại' });
      if (branch.active === dto.active) return id;
      if (!dto.active) {
        const impacts = await this.impacts(id, user, tx);
        if (Object.values(impacts).some(count => count > 0)) throw new ConflictException({ code: 'BRANCH_IN_USE', message: 'Chi nhánh còn dữ liệu đang sử dụng', impacts });
      }
      await tx.branch.update({ where: { id }, data: { active: dto.active, updatedAt: new Date(Math.max(Date.now(), branch.updatedAt.getTime() + 1)) } });
      await tx.auditLog.create({ data: { entityType: 'Branch', entityId: id, action: dto.active ? 'BRANCH_ACTIVATED' : 'BRANCH_DEACTIVATED', performedBy: user.id, actorUserId: user.id, changeSummary: { active: dto.active } } });
      return id;
    });
  }

  async findAll(user: Principal) {
    return this.prisma.branch.findMany({
      where: { active: true, id: branchFilter({ ...user, selectedBranchId: undefined }, 'branches.read') },
      include: {
        _count: {
          select: { vehicles: true, drivers: true },
        },
      },
      orderBy: { code: 'asc' },
    });
  }

  async findOne(id: string, user: Principal) {
    const branch = await this.prisma.branch.findFirst({
      where: { id, AND: { id: branchFilter(user, 'branches.read') } },
      include: {
        vehicles: hasPermission(user, 'vehicles.read', id),
        drivers: hasPermission(user, 'drivers.read', id),
      },
    });

    if (!branch) {
      throw new NotFoundException(`Không tìm thấy chi nhánh với ID ${id}`);
    }

    return branch;
  }

  async update(id: string, dto: UpdateBranchDto, user: Principal) {
    assertPermission(user, 'branches.manage');
    const branch = await this.prisma.branch.findUnique({
      where: { id },
    });

    if (!branch) {
      throw new NotFoundException(`Không tìm thấy chi nhánh với ID ${id}`);
    }

    const penaltyMode = dto.lateDeliveryPenaltyMode ?? branch.lateDeliveryPenaltyMode;
    const penaltyValue = dto.lateDeliveryPenaltyValue ?? Number(branch.lateDeliveryPenaltyValue);
    if (
      penaltyMode === LateDeliveryPenaltyMode.PERCENT_ORDER_VALUE_PER_DAY &&
      penaltyValue > 100
    ) {
      throw new BadRequestException('Mức phạt phần trăm không được vượt quá 100% giá trị đơn mỗi ngày');
    }

    let latitude = dto.latitude;
    let longitude = dto.longitude;

    // Nếu có cập nhật địa chỉ nhưng chưa có tọa độ GPS, tự động giải mã qua Mapbox
    if (dto.address && (latitude === undefined || longitude === undefined)) {
      const geoResults = await this.mapboxService.geocode(dto.address);
      if (geoResults.length > 0) {
        latitude = geoResults[0].latitude;
        longitude = geoResults[0].longitude;
      } else {
        throw new BadRequestException(`Không thể định vị tọa độ Mapbox cho địa chỉ chi nhánh: "${dto.address}"`);
      }
    }

    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${id} FOR UPDATE`;
      const current = await tx.branch.findUniqueOrThrow({ where: { id } });
      if (current.updatedAt.toISOString() !== new Date(dto.expectedUpdatedAt).toISOString()) throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'Chi nhánh đã thay đổi. Hãy tải lại' });
      const result = await tx.branch.update({
      where: { id },
      data: {
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.address ? { address: dto.address } : {}),
        ...(latitude !== undefined ? { latitude } : {}),
        ...(longitude !== undefined ? { longitude } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.timezone ? { timezone: dto.timezone } : {}),
        ...(dto.deliveryGraceDays !== undefined
          ? { deliveryGraceDays: dto.deliveryGraceDays }
          : {}),
        ...(dto.lateDeliveryPenaltyMode !== undefined
          ? { lateDeliveryPenaltyMode: dto.lateDeliveryPenaltyMode }
          : {}),
        ...(dto.lateDeliveryPenaltyValue !== undefined
          ? { lateDeliveryPenaltyValue: dto.lateDeliveryPenaltyValue }
          : {}),
      },
      include: {
        _count: {
          select: { vehicles: true, drivers: true },
        },
      },
      });
      await tx.auditLog.create({ data: { entityType: 'Branch', entityId: id, action: 'BRANCH_UPDATED', performedBy: user.id, actorUserId: user.id, changeSummary: { fields: Object.keys(dto).filter(key => key !== 'expectedUpdatedAt') } } });
      return result;
    });
  }
}
