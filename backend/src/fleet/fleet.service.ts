import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VehicleStatus, DriverStatus } from '@prisma/client';
import { Principal, assertPermission, branchFilter, hasPermission, tripFilter } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { flattenVehicleType } from '../vehicles/vehicle-capabilities';
import { assertProfileVersion, assertStatusChangeAllowed, lockResourceProfile, nextProfileTimestamp } from '../vehicles/resource-profile';
import { CancelScheduleDto, CreateDriverDto, CreateVehicleDto, FleetQueryDto, IntervalQueryDto, LinkEmployeeDto, ScheduleDto, UpdateScheduleDto } from './fleet.dto';
import { fleetCommand } from './fleet-command';
import { interval, ResourceKind, resourceAvailability } from './availability';

const branchSelect = { id: true, name: true, code: true, timezone: true } as const;
const vehicleInclude = { homeBranch: { select: branchSelect }, vehicleTypeRecord: true, homeDepotLocation: true } as const;
const driverInclude = { homeBranch: { select: branchSelect }, employee: true } as const;
const missing = () => new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: 'Tài nguyên không tồn tại hoặc ngoài phạm vi' });
export const normalizedPlate = (plate: string) => plate.toUpperCase().replace(/[\s.-]/g, '');

@Injectable()
export class FleetService {
  constructor(private readonly db: PrismaService) {}
  private permission(kind: ResourceKind, write = false) { return `${kind}.${write ? 'manage' : 'read'}` as 'vehicles.read' | 'vehicles.manage' | 'drivers.read' | 'drivers.manage'; }
  private async resource(tx: Prisma.TransactionClient, kind: ResourceKind, id: string, user: Principal, write = false) {
    const where = { id, homeBranchId: branchFilter(user, this.permission(kind, write)) };
    const row = kind === 'vehicles' ? await tx.vehicle.findFirst({ where }) : await tx.driver.findFirst({ where });
    if (!row) throw missing();
    return row;
  }
  async detail(kind: ResourceKind, id: string, user: Principal, tx: Prisma.TransactionClient = this.db) {
    await this.resource(tx, kind, id, user);
    if (kind === 'vehicles') return flattenVehicleType(await tx.vehicle.findUniqueOrThrow({ where: { id }, include: vehicleInclude }));
    const d = await tx.driver.findUniqueOrThrow({ where: { id }, include: driverInclude });
    return { id: d.id, fullName: d.employee?.fullName ?? d.fullName, phone: d.employee?.phone ?? d.phone,
      homeBranchId: d.homeBranchId, homeBranch: d.homeBranch, employeeId: d.employeeId, employeeVersion: d.employee?.version ?? null,
      userLinked: !!d.userId, status: d.status, licenseClass: d.licenseClass, licenseExpiry: d.licenseExpiry,
      updatedAt: d.updatedAt, employeeLinkRequired: !d.employeeId,
      ...(hasPermission(user, 'drivers.manage', d.homeBranchId) ? { citizenId: d.employee?.citizenId ?? d.citizenId, licenseNumber: d.licenseNumber } : {}) };
  }
  async list(kind: ResourceKind, query: FleetQueryDto, user: Principal) {
    const scope = branchFilter(user, this.permission(kind), query.branchId), search = query.search;
    if (query.status && !(kind === 'vehicles' ? Object.values(VehicleStatus) : Object.values(DriverStatus)).some(s => s === query.status)) throw new BadRequestException('Trạng thái không hợp lệ');
    const paging = { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
    return this.db.$transaction(async tx => {
      if (kind === 'vehicles') {
        const where: Prisma.VehicleWhereInput = { homeBranchId: scope, ...(query.status ? { status: query.status as VehicleStatus } : {}), ...(search ? { OR: [{ plateNumber: { contains: search, mode: 'insensitive' } }, { model: { contains: search, mode: 'insensitive' } }] } : {}) };
        const total = await tx.vehicle.count({ where });
        const rows = await tx.vehicle.findMany({ where, ...paging, include: vehicleInclude, orderBy: [{ plateNumber: 'asc' }, { id: 'asc' }] });
        return { items: rows.map(flattenVehicleType), total, page: query.page, pageSize: query.pageSize };
      }
      const where: Prisma.DriverWhereInput = { homeBranchId: scope, ...(query.status ? { status: query.status as DriverStatus } : {}), ...(search ? { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { phone: { contains: search, mode: 'insensitive' } }, { employee: { fullName: { contains: search, mode: 'insensitive' } } }] } : {}) };
      const total = await tx.driver.count({ where });
      const rows = await tx.driver.findMany({ where, ...paging, include: driverInclude, orderBy: [{ fullName: 'asc' }, { id: 'asc' }] });
      return { items: rows.map(d => ({ id: d.id, fullName: d.employee?.fullName ?? d.fullName, phone: d.employee?.phone ?? d.phone, homeBranchId: d.homeBranchId, homeBranch: d.homeBranch, status: d.status, updatedAt: d.updatedAt, employeeId: d.employeeId, licenseClass: d.licenseClass, licenseExpiry: d.licenseExpiry })), total, page: query.page, pageSize: query.pageSize };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async employees(query: FleetQueryDto, user: Principal) {
    const where: Prisma.EmployeeWhereInput = { branchId: branchFilter(user, 'drivers.manage', query.branchId), employmentStatus: 'ACTIVE', driverProfile: null,
      ...(query.search ? { OR: [{ fullName: { contains: query.search, mode: 'insensitive' } }, { employeeCode: { contains: query.search, mode: 'insensitive' } }] } : {}) };
    const [total, items] = await this.db.$transaction([this.db.employee.count({ where }), this.db.employee.findMany({ where, select: { id: true, employeeCode: true, fullName: true, branchId: true, version: true }, orderBy: [{ fullName: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize })]);
    return { total, items, page: query.page, pageSize: query.pageSize };
  }
  private async employee(tx: Prisma.TransactionClient, id: string, version: number, user: Principal) {
    await tx.$queryRaw`SELECT id FROM employees WHERE id=${id} FOR UPDATE`;
    const e = await tx.employee.findFirst({ where: { id, branchId: branchFilter(user, 'drivers.manage'), employmentStatus: 'ACTIVE' }, include: { driverProfile: true, user: { include: { roleScopes: { include: { role: true } } } } } });
    if (!e) throw missing();
    if (e.version !== version) throw new ConflictException('Employee đã thay đổi; tải lại danh sách');
    if (e.driverProfile) throw new ConflictException('Employee đã liên kết tài xế khác');
    if (!e.citizenId?.trim() || !e.phone?.trim()) throw new BadRequestException('Employee thiếu định danh hoặc điện thoại; cần hoàn thiện hồ sơ nhân viên trước');
    if (e.user && (!e.user.active || !e.user.roleScopes.some(s => s.active && s.role.code === 'DRIVER' && s.branchId === e.branchId))) throw new BadRequestException('Tài khoản của Employee chưa có quyền DRIVER phù hợp');
    return { ...e, phone: e.phone, citizenId: e.citizenId };
  }
  createVehicle(dto: CreateVehicleDto, user: Principal, key?: string) {
    assertPermission(user, 'vehicles.manage', dto.homeBranchId);
    return fleetCommand(this.db, user, 'FLEET_CREATE_VEHICLE', key, dto, async tx => {
      if (!await tx.branch.findFirst({ where: { id: dto.homeBranchId, active: true } })) throw new BadRequestException('Chi nhánh không hoạt động');
      const type = await tx.vehicleType.findFirst({ where: { id: dto.vehicleTypeId, active: true } });
      if (!type || ![type.payloadCapacityKg, type.lengthCm, type.widthCm, type.heightCm, type.volumeCapacityM3].every(n => Number.isFinite(n) && n > 0)) throw new BadRequestException('Cấu hình loại xe thiếu hoặc số đo không hợp lệ');
      if (dto.homeDepotLocationId && !await tx.location.findFirst({ where: { id: dto.homeDepotLocationId, managingBranchId: dto.homeBranchId, active: true, type: 'CENTRAL_WAREHOUSE' } })) throw new BadRequestException('Điểm xuất phát không thuộc chi nhánh hoặc không hoạt động');
      if (!normalizedPlate(dto.plateNumber)) throw new BadRequestException('Biển số không hợp lệ');
      const row = await tx.vehicle.create({ data: { ...dto, plateNumber: dto.plateNumber.toUpperCase(), status: 'AVAILABLE' } });
      await this.audit(tx, user, 'Vehicle', row.id, 'CREATE', { version: row.updatedAt.toISOString() }); return row.id;
    }, (tx, id) => this.detail('vehicles', id, user, tx));
  }
  createDriver(dto: CreateDriverDto, user: Principal, key?: string) {
    assertPermission(user, 'drivers.manage');
    return fleetCommand(this.db, user, 'FLEET_CREATE_DRIVER', key, dto, async tx => {
      const e = await this.employee(tx, dto.employeeId, dto.employeeVersion, user);
      const row = await tx.driver.create({ data: { employeeId: e.id, userId: e.userId, fullName: e.fullName, phone: e.phone, citizenId: e.citizenId, homeBranchId: e.branchId, licenseNumber: dto.licenseNumber, licenseClass: dto.licenseClass, licenseExpiry: new Date(dto.licenseExpiry) } });
      await this.audit(tx, user, 'Driver', row.id, 'CREATE', { employeeId: e.id, version: row.updatedAt.toISOString() }); return row.id;
    }, (tx, id) => this.detail('drivers', id, user, tx));
  }
  linkEmployee(id: string, dto: LinkEmployeeDto, user: Principal, key?: string) {
    assertPermission(user, 'drivers.manage');
    return fleetCommand(this.db, user, 'FLEET_LINK_EMPLOYEE', key, { id, ...dto }, async tx => {
      await lockResourceProfile(tx, 'driver', id); await this.resource(tx, 'drivers', id, user, true);
      const d = await tx.driver.findUniqueOrThrow({ where: { id } }); assertProfileVersion(d.updatedAt, dto.expectedUpdatedAt);
      if (d.employeeId) throw new ConflictException('Tài xế đã liên kết Employee; không thay danh tính lịch sử');
      await assertStatusChangeAllowed(tx, 'driver', id);
      const e = await this.employee(tx, dto.employeeId, dto.employeeVersion, user);
      if (d.userId && d.userId !== e.userId) throw new ConflictException('Tài khoản hiện tại không khớp Employee');
      await tx.driver.update({ where: { id }, data: { employeeId: e.id, userId: e.userId, fullName: e.fullName, phone: e.phone, citizenId: e.citizenId, homeBranchId: e.branchId, updatedAt: nextProfileTimestamp(d.updatedAt) } });
      await this.audit(tx, user, 'Driver', id, 'LINK_EMPLOYEE', { employeeId: e.id }); return id;
    }, (tx, resourceId) => this.detail('drivers', resourceId, user, tx));
  }
  async availability(kind: ResourceKind, query: IntervalQueryDto, user: Principal) {
    const { start, end } = interval(query.startsAt, query.endsAt);
    const page = await this.list(kind, query, user);
    return this.db.$transaction(async tx => ({ ...page, items: await Promise.all(page.items.map(async row => {
      await this.resource(tx, kind, row.id, user);
      const result = await resourceAvailability(tx, kind, row.id, start, end);
      const trips = hasPermission(user, 'trips.read') ? await tx.trip.findMany({ where: { id: { in: result.blockingTripIds }, ...tripFilter(user) }, select: { id: true, tripNumber: true, status: true }, take: 100 }) : [];
      const { blockingTripIds: _ids, ...safe } = result;
      return { profile: await this.publicProfile(kind, row.id, user, tx), ...safe, affectedTrips: trips };
    })) }), { isolationLevel: 'RepeatableRead', timeout: 20000 });
  }
  private async publicProfile(kind: ResourceKind, id: string, user: Principal, tx: Prisma.TransactionClient) {
    const row = await this.detail(kind, id, user, tx);
    if ('plateNumber' in row) return row;
    return { id: row.id, fullName: row.fullName, phone: row.phone, homeBranchId: row.homeBranchId, homeBranch: row.homeBranch, updatedAt: row.updatedAt, status: row.status, licenseClass: row.licenseClass, licenseExpiry: row.licenseExpiry, employeeId: row.employeeId };
  }
  async resourceWindow(kind: ResourceKind, id: string, query: IntervalQueryDto, user: Principal) {
    const { start, end } = interval(query.startsAt, query.endsAt);
    return this.db.$transaction(async tx => {
      await this.resource(tx, kind, id, user);
      const result = await resourceAvailability(tx, kind, id, start, end);
      const affectedTrips = hasPermission(user, 'trips.read') ? await tx.trip.findMany({ where: { id: { in: result.blockingTripIds }, ...tripFilter(user) }, select: { id: true, tripNumber: true, status: true }, take: 100 }) : [];
      const { blockingTripIds: _ids, ...safe } = result;
      return { ...safe, profile: await this.publicProfile(kind, id, user, tx), affectedTrips };
    }, { isolationLevel: 'RepeatableRead' });
  }
  private async audit(tx: Prisma.TransactionClient, user: Principal, entityType: string, entityId: string, action: string, summary: Prisma.InputJsonObject) {
    await tx.auditLog.create({ data: { entityType, entityId, action, performedBy: user.id, actorUserId: user.id, changeSummary: summary } });
  }

  async schedules(kind: ResourceKind, id: string, query: IntervalQueryDto, user: Principal, tx: Prisma.TransactionClient = this.db) {
    await this.resource(tx, kind, id, user);
    const { start, end } = interval(query.startsAt, query.endsAt);
    const paging = { skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: [{ startsAt: 'asc' as const }, { id: 'asc' as const }] };
    const overlap = { startsAt: { lt: end }, endsAt: { gt: start } };
    if (kind === 'vehicles') {
      const where = { vehicleId: id, startsAt: { lt: end }, OR: [{ endsAt: null }, { endsAt: { gt: start } }] };
      const [total, rows] = await Promise.all([tx.vehicleUnavailability.count({ where }), tx.vehicleUnavailability.findMany({ where, ...paging })]);
      return { total, items: rows, page: query.page, pageSize: query.pageSize };
    }
    const driver = await tx.driver.findUniqueOrThrow({ where: { id } });
    // Independently paginated sources avoid loading all history to merge in memory.
    const shiftWhere = { driverId: id, ...overlap }, leaveWhere = { employeeId: driver.employeeId ?? '__unlinked__', ...overlap };
    const [shiftTotal, shifts, leaveTotal, leaves] = await Promise.all([tx.driverShift.count({ where: shiftWhere }), tx.driverShift.findMany({ where: shiftWhere, ...paging }), tx.employeeLeave.count({ where: leaveWhere }), tx.employeeLeave.findMany({ where: leaveWhere, ...paging })]);
    return { total: shiftTotal + leaveTotal, shiftTotal, leaveTotal, items: [...shifts.map(s => ({ ...s, kind: 'SHIFT' })), ...leaves.map(l => ({ ...l, kind: l.leaveType, status: l.approvalStatus === 'APPROVED' ? 'ACTIVE' : l.approvalStatus }))], page: query.page, pageSize: query.pageSize };
  }
  schedule(kind: ResourceKind, id: string, dto: ScheduleDto | UpdateScheduleDto | CancelScheduleDto, user: Principal, key?: string, scheduleId?: string, cancel = false, source?: string) {
    assertPermission(user, this.permission(kind, true));
    return fleetCommand(this.db, user, 'FLEET_SCHEDULE', key, { kind, id, scheduleId, cancel, source, ...dto }, async tx => {
      await lockResourceProfile(tx, kind === 'vehicles' ? 'vehicle' : 'driver', id);
      const resource = await this.resource(tx, kind, id, user, true);
      const driver = kind === 'drivers' ? await tx.driver.findUniqueOrThrow({ where: { id } }) : null;
      const scheduleKind = source ?? ('kind' in dto ? dto.kind : undefined);
      if (!scheduleKind || !(kind === 'vehicles' ? ['MAINTENANCE', 'BREAKDOWN'] : ['SHIFT', 'LEAVE', 'OTHER']).includes(scheduleKind)) throw new BadRequestException('Loại lịch không phù hợp tài nguyên');
      if ('kind' in dto && dto.kind !== scheduleKind) throw new BadRequestException('Không đổi loại lịch; hủy và tạo lịch mới');
      if (kind === 'drivers' && !driver?.employeeId) throw new ConflictException({ code: 'EMPLOYEE_LINK_MISSING', message: 'Cần liên kết Employee trước khi khai báo lịch' });
      const previous = scheduleId ? (kind === 'vehicles' ? await tx.vehicleUnavailability.findFirst({ where: { id: scheduleId, vehicleId: id, kind: scheduleKind } }) : scheduleKind === 'SHIFT' ? await tx.driverShift.findFirst({ where: { id: scheduleId, driverId: id } }) : await tx.employeeLeave.findFirst({ where: { id: scheduleId, employeeId: driver?.employeeId ?? '', leaveType: scheduleKind } })) : null;
      if (scheduleId && !previous) throw missing();
      if (previous && (!('version' in dto) || previous.version !== dto.version)) throw new ConflictException({ code: 'SCHEDULE_VERSION_CONFLICT', message: 'Lịch đã thay đổi; tải lại trước khi lưu' });
      if (previous && (('status' in previous && previous.status !== 'ACTIVE') || ('approvalStatus' in previous && previous.approvalStatus !== 'APPROVED'))) throw new ConflictException('Lịch đã hết hiệu lực');
      const times = cancel && previous ? { startsAt: previous.startsAt, endsAt: previous.endsAt } : ('startsAt' in dto ? { startsAt: interval(dto.startsAt, dto.endsAt).start, endsAt: new Date(dto.endsAt) } : null);
      if (!times) throw new BadRequestException('Thiếu thời gian lịch');
      const common = { ...times, reason: dto.reason, recordedById: user.id };
      let resultId: string;
      if (kind === 'vehicles') {
        const row = scheduleId ? await tx.vehicleUnavailability.update({ where: { id: scheduleId }, data: { ...common, status: cancel ? 'CANCELLED' : 'ACTIVE', version: { increment: 1 } } }) : await tx.vehicleUnavailability.create({ data: { ...common, vehicleId: id, kind: scheduleKind } }); resultId = row.id;
      } else {
        if (!common.endsAt) throw new BadRequestException('Lịch tài xế cần thời điểm kết thúc');
        const finite = { ...common, endsAt: common.endsAt };
        if (scheduleKind === 'SHIFT') {
          const row = scheduleId ? await tx.driverShift.update({ where: { id: scheduleId }, data: { ...finite, status: cancel ? 'CANCELLED' : 'ACTIVE', version: { increment: 1 } } }) : await tx.driverShift.create({ data: { ...finite, driverId: id } }); resultId = row.id;
        } else {
          const row = scheduleId ? await tx.employeeLeave.update({ where: { id: scheduleId }, data: { ...finite, approvalStatus: cancel ? 'CANCELLED' : 'APPROVED', version: { increment: 1 } } }) : await tx.employeeLeave.create({ data: { ...finite, employeeId: driver?.employeeId ?? '', leaveType: scheduleKind, approvalStatus: 'APPROVED' } }); resultId = row.id;
        }
      }
      if (kind === 'vehicles') await tx.vehicle.update({ where: { id }, data: { updatedAt: nextProfileTimestamp(resource.updatedAt) } });
      else await tx.driver.update({ where: { id }, data: { updatedAt: nextProfileTimestamp(resource.updatedAt) } });
      if (kind === 'vehicles' && scheduleKind === 'BREAKDOWN' && !cancel) {
        const affected = await tx.trip.findMany({ where: { status: { in: ['PLANNED', 'DISPATCHED', 'IN_PROGRESS'] }, OR: [
          { vehicleId: id, plannedStartTime: times.endsAt ? { lt: times.endsAt } : undefined, plannedEndTime: { gt: times.startsAt } },
          { reservations: { some: { vehicleId: id, status: { in: ['HELD', 'ACTIVE'] }, startsAt: times.endsAt ? { lt: times.endsAt } : undefined, endsAt: { gt: times.startsAt } } } },
        ] }, select: { id: true }, take: 101 });
        if (affected.length) await this.audit(tx, user, 'VehicleUnavailability', resultId, 'TRIP_CONFLICT_RECORDED', { resourceId: id, tripIds: affected.slice(0, 100).map(t => t.id), truncated: affected.length > 100 });
      }
      await this.audit(tx, user, kind === 'vehicles' ? 'VehicleUnavailability' : scheduleKind === 'SHIFT' ? 'DriverShift' : 'EmployeeLeave', resultId, cancel ? 'CANCEL' : scheduleId ? 'UPDATE' : 'CREATE', { resourceId: id, kind: scheduleKind, reason: dto.reason, startsAt: times.startsAt.toISOString(), endsAt: times.endsAt?.toISOString() ?? null, previous: previous ? { version: previous.version, startsAt: previous.startsAt.toISOString(), endsAt: previous.endsAt?.toISOString() ?? null, reason: previous.reason } : null });
      return resultId;
    }, async (tx, resultId) => { await this.resource(tx, kind, id, user, true); return { id: resultId, saved: true }; });
  }
}
