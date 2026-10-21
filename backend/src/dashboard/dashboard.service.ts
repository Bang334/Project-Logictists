import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Principal, branchFilter, hasPermission } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { newDispatchOrderWhere } from '../orders/order-contract';
import { minimumLicenseDate } from '../fleet/availability';
import { monitoringScope } from '../trip-monitoring/monitoring-scope';
import { DashboardItemsQuery, DashboardQuery, DetailMetric } from './dashboard.dto';

const readPermissions = ['orders.read', 'trips.read', 'vehicles.read', 'drivers.read'] as const;
const reviewOrders: Prisma.OrderWhereInput = { orderType: 'B2B_TRANSPORT', status: 'CONFIRMED', packageDataStatus: { not: 'COMPLETE' } };
const blockedVehicles = (now: Date): Prisma.VehicleWhereInput => ({ unavailability: { some: {
  status: 'ACTIVE', startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }],
} } });
const branchSelect = { select: { name: true } } as const;

@Injectable()
export class DashboardService {
  constructor(private readonly db: PrismaService) {}
  private access(user: Principal, branchId?: string) {
    if (!readPermissions.some(p => hasPermission(user, p, branchId || user.selectedBranchId))) throw new ForbiddenException('Không có quyền xem Dashboard trong phạm vi này');
  }
  async summary(user: Principal, q: DashboardQuery) {
    this.access(user, q.branchId);
    const from = new Date(q.from), to = new Date(q.to);
    if (!Number.isFinite(+from) || !Number.isFinite(+to) || from >= to || +to - +from > 366 * 86400000) throw new BadRequestException('Kỳ lọc cần từ < đến, tối đa 366 ngày');
    return this.db.$transaction(async tx => {
      const now = new Date();
      const allowed = (p: typeof readPermissions[number]) => hasPermission(user, p, q.branchId || user.selectedBranchId);
      const orders = allowed('orders.read') ? { branchId: branchFilter(user, 'orders.read', q.branchId) } : null;
      const vehicles = allowed('vehicles.read') ? { homeBranchId: branchFilter(user, 'vehicles.read', q.branchId) } : null;
      const drivers = allowed('drivers.read') ? { homeBranchId: branchFilter(user, 'drivers.read', q.branchId) } : null;
      const trips = allowed('trips.read') ? monitoringScope(user, q.branchId) : null;
      // Counts operate on entity rows; relation filters compile to EXISTS, not
      // multiplicative joins. Null means forbidden, never an invented zero.
      const candidateOrders = orders ? await tx.order.count({ where: { ...orders, ...newDispatchOrderWhere } }) : null;
      const review = orders ? await tx.order.count({ where: { ...orders, ...reviewOrders } }) : null;
      const availableVehicles = vehicles ? await tx.vehicle.count({ where: { ...vehicles, status: 'AVAILABLE' } }) : null;
      const blocked = vehicles ? await tx.vehicle.count({ where: { ...vehicles, ...blockedVehicles(now) } }) : null;
      const availableDrivers = drivers ? await tx.driver.count({ where: { ...drivers, status: 'AVAILABLE' } }) : null;
      const expired = drivers ? await tx.driver.count({ where: { ...drivers, licenseExpiry: { lt: minimumLicenseDate(now) } } }) : null;
      const grouped = trips ? await tx.trip.groupBy({ by: ['status'], where: trips, _count: { _all: true } }) : null;
      const count = (status: string) => grouped ? grouped.find(g => g.status === status)?._count._all ?? 0 : null;
      const departed = trips ? await tx.trip.count({ where: { AND: [trips, { actualStartTime: { gte: from, lt: to } }] } }) : null;
      const completed = trips ? await tx.trip.count({ where: { AND: [trips, { status: 'COMPLETED', actualEndTime: { gte: from, lt: to } }] } }) : null;
      const missingCompletionTime = trips ? await tx.trip.count({ where: { AND: [trips, { status: 'COMPLETED', actualEndTime: null }] } }) : null;
      return { fetchedAt: now, timezone: 'Asia/Ho_Chi_Minh', branchId: q.branchId || user.selectedBranchId || null, from, to,
        metrics: { candidateOrders, availableVehicles, availableDrivers, plannedTrips: count('PLANNED'), dispatchedTrips: count('DISPATCHED'), activeTrips: count('IN_PROGRESS'), departedTrips: departed, completedTrips: completed },
        issues: { reviewOrders: review, expiredDrivers: expired, blockedVehicles: blocked }, missingCompletionTime };
    }, { isolationLevel: 'RepeatableRead' });
  }
  async items(user: Principal, q: DashboardItemsQuery) {
    const metric: DetailMetric = q.metric;
    const paging = { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
    return this.db.$transaction(async tx => {
      const now = new Date();
      const base = { page: q.page, pageSize: q.pageSize, fetchedAt: now };
      if (metric === 'candidateOrders' || metric === 'reviewOrders') {
        const where = { branchId: branchFilter(user, 'orders.read', q.branchId), ...(metric === 'candidateOrders' ? newDispatchOrderWhere : reviewOrders) };
        const total = await tx.order.count({ where });
        const rows = await tx.order.findMany({ where, ...paging, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], select: {
          id: true, orderNumber: true, status: true, packageDataStatus: true, updatedAt: true, branch: branchSelect,
        } });
        return { ...base, total, items: rows.map(r => ({ id: r.id, label: r.orderNumber, status: r.status, branch: r.branch.name, updatedAt: r.updatedAt,
          evidence: metric === 'candidateOrders' ? 'CONFIRMED / COMPLETE; chưa có phân công hoặc lịch sử. Cần validator trước điều phối.' : `packageDataStatus=${r.packageDataStatus}; cần đối soát kiện`,
          evidenceAt: r.updatedAt, kind: 'order' })) };
      }
      if (metric === 'availableVehicles' || metric === 'blockedVehicles') {
        const where: Prisma.VehicleWhereInput = { homeBranchId: branchFilter(user, 'vehicles.read', q.branchId), ...(metric === 'availableVehicles' ? { status: 'AVAILABLE' } : blockedVehicles(now)) };
        const total = await tx.vehicle.count({ where });
        const rows = await tx.vehicle.findMany({ where, ...paging, orderBy: [{ plateNumber: 'asc' }, { id: 'asc' }], select: {
          id: true, plateNumber: true, status: true, updatedAt: true, homeBranch: branchSelect,
          unavailability: { where: { status: 'ACTIVE', startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], take: 1, select: { reason: true, startsAt: true, endsAt: true } },
        } });
        return { ...base, total, items: rows.map(r => ({ id: r.id, label: r.plateNumber, status: r.status, branch: r.homeBranch.name, updatedAt: r.updatedAt,
          evidence: metric === 'availableVehicles' ? 'Trạng thái quản lý AVAILABLE; chưa chứng nhận khả thi nhận chuyến.' : `${r.unavailability[0]?.reason}; lịch ACTIVE đến ${r.unavailability[0]?.endsAt?.toISOString() || 'chưa xác định'}`,
          evidenceAt: metric === 'blockedVehicles' ? r.unavailability[0]?.startsAt : r.updatedAt, kind: 'vehicle' })) };
      }
      const where: Prisma.DriverWhereInput = { homeBranchId: branchFilter(user, 'drivers.read', q.branchId), ...(metric === 'availableDrivers' ? { status: 'AVAILABLE' } : { licenseExpiry: { lt: minimumLicenseDate(now) } }) };
      const total = await tx.driver.count({ where });
      const rows = await tx.driver.findMany({ where, ...paging, orderBy: [{ fullName: 'asc' }, { id: 'asc' }], select: {
        id: true, fullName: true, employee: { select: { fullName: true } }, status: true, updatedAt: true, licenseExpiry: true, homeBranch: branchSelect,
      } });
      return { ...base, total, items: rows.map(r => ({ id: r.id, label: r.employee?.fullName || r.fullName, status: r.status, branch: r.homeBranch.name, updatedAt: r.updatedAt,
        evidence: metric === 'availableDrivers' ? 'Trạng thái quản lý AVAILABLE; chưa kiểm tra ca, nghỉ, bằng hoặc vị trí.' : `Bằng có hiệu lực hết ngày ${r.licenseExpiry.toISOString().slice(0, 10)} (Asia/Ho_Chi_Minh)`,
        evidenceAt: r.updatedAt, kind: 'driver' })) };
    }, { isolationLevel: 'RepeatableRead' });
  }
}
