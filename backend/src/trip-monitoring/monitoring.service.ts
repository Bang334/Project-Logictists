import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Principal } from '../auth/access';
import { monitoringScope } from './monitoring-scope';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { MonitoringPageQuery, MonitoringQuery } from './monitoring.dto';

const headerSelect = {
  id: true, tripNumber: true, status: true, version: true, updatedAt: true,
  plannedStartTime: true, plannedEndTime: true, actualStartTime: true, actualEndTime: true,
  managingBranch: { select: { id: true, name: true } },
  vehicle: { select: { id: true, plateNumber: true } },
  assignments: { orderBy: { id: 'asc' }, select: {
    id: true, status: true, role: true, startTime: true, endTime: true, actualEndTime: true,
    respondedAt: true, rejectionReason: true, startStopId: true, endStopId: true,
    driver: { select: { id: true, fullName: true } },
  } },
} satisfies Prisma.TripSelect;
const eventSelect = { id: true, eventType: true, tripStopId: true, stopTaskId: true, occurredAt: true, receivedAt: true, sourceSnapshotId: true } satisfies Prisma.ExecutionEventSelect;
const podSelect = { id: true, uploadStatus: true, mediaType: true, sizeBytes: true, capturedAt: true, uploadedAt: true, discardedAt: true } satisfies Prisma.PodFileSelect;
const podLinks = { tripStopId: true, assignment: { select: { tripId: true } }, sourceSnapshot: { select: { tripId: true } } } satisfies Prisma.PodFileSelect;

@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  private scope(user: Principal, branchId?: string): Prisma.TripWhereInput {
    return monitoringScope(user, branchId);
  }
  private async trip(db: Prisma.TransactionClient, user: Principal, id: string) {
    const trip = await db.trip.findFirst({ where: { id, ...this.scope(user) }, select: headerSelect });
    if (!trip) throw new NotFoundException('Chuyến không tồn tại hoặc ngoài phạm vi được cấp');
    return trip;
  }
  async resources(user: Principal, q: MonitoringQuery) {
    const trips = this.scope(user, q.branchId);
    const [vehicles, drivers] = await Promise.all([
      this.prisma.vehicle.findMany({ where: { trips: { some: trips }, plateNumber: { contains: q.search?.trim() || '', mode: 'insensitive' } }, select: { id: true, plateNumber: true }, orderBy: [{ plateNumber: 'asc' }, { id: 'asc' }], take: 30 }),
      this.prisma.driver.findMany({ where: { assignments: { some: { trip: trips } }, fullName: { contains: q.search?.trim() || '', mode: 'insensitive' } }, select: { id: true, fullName: true }, orderBy: [{ fullName: 'asc' }, { id: 'asc' }], take: 30 }),
    ]);
    return { vehicles, drivers };
  }
  async list(user: Principal, q: MonitoringQuery) {
    if (q.from && q.to && new Date(q.from) >= new Date(q.to)) throw new BadRequestException('Khoảng khởi hành phải có từ < đến');
    if (q.from && q.to && Date.parse(q.to) - Date.parse(q.from) > 366 * 86400000) throw new BadRequestException('Khoảng lọc tối đa 366 ngày');
    const search = q.search?.trim();
    const where: Prisma.TripWhereInput = { AND: [this.scope(user, q.branchId), {
      status: q.status, vehicleId: q.vehicleId,
      ...(q.driverId ? { assignments: { some: { driverId: q.driverId } } } : {}),
      ...((q.from || q.to) ? { [q.timeBasis || 'plannedStartTime']: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      ...(search ? { OR: [{ tripNumber: { contains: search, mode: 'insensitive' } }, { vehicle: { plateNumber: { contains: search, mode: 'insensitive' } } }, { assignments: { some: { driver: { fullName: { contains: search, mode: 'insensitive' } } } } }] } : {}),
    }] };
    return this.prisma.$transaction(async db => {
      const total = await db.trip.count({ where });
      const trips = await db.trip.findMany({ where, select: headerSelect, orderBy: [{ plannedStartTime: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize });
      const ids = trips.map(t => t.id);
      const stops = await db.tripStop.findMany({ where: { tripId: { in: ids } }, select: { tripId: true, status: true, tasks: { select: { packageId: true, allocation: { select: { packageId: true } } } } } });
      // Only aggregate identifiers, never event payloads or POD bytes for the list.
      const delivered = await db.deliveryResult.findMany({ where: { result: 'DELIVERED', stopTask: { tripStop: { tripId: { in: ids } } } }, select: { packageId: true, stopTask: { select: { packageId: true, allocation: { select: { packageId: true } }, tripStop: { select: { tripId: true, id: true } } } }, deliveryAttempt: { select: { tripStopId: true } } } });
      if (delivered.some(r => r.deliveryAttempt.tripStopId !== r.stopTask.tripStop.id || r.packageId !== (r.stopTask.packageId || r.stopTask.allocation?.packageId))) {
        throw new ConflictException('Kết quả giao tham chiếu sai điểm/kiện; cần đối soát trước khi thống kê');
      }
      return { items: trips.map(t => {
        const own = stops.filter(s => s.tripId === t.id);
        const packages = new Set(own.flatMap(s => s.tasks.flatMap(task => task.packageId || task.allocation?.packageId ? [task.packageId || task.allocation?.packageId] : [])));
        const deliveredCount = new Set(delivered.filter(r => r.stopTask.tripStop.tripId === t.id && r.deliveryAttempt.tripStopId === r.stopTask.tripStop.id && r.packageId === (r.stopTask.packageId || r.stopTask.allocation?.packageId)).map(r => r.packageId)).size;
        return { ...t, stopCount: own.length, completedStopCount: own.filter(s => s.status === 'COMPLETED').length, packageCount: packages.size, deliveredCount };
      }), total, page: q.page, pageSize: q.pageSize, fetchedAt: new Date() };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async detail(user: Principal, id: string) {
    return this.prisma.$transaction(async db => {
      const trip = await this.trip(db, user, id);
      const stops = await db.tripStop.findMany({ where: { tripId: id }, orderBy: { sequence: 'asc' }, select: {
        id: true, sequence: true, stopType: true, address: true, status: true,
        plannedArrivalTime: true, plannedDepartureTime: true, actualArrivalTime: true, actualDepartureTime: true,
        tasks: { orderBy: { id: 'asc' }, select: {
          id: true, action: true, plannedQuantity: true, actualQuantity: true,
          package: { select: { id: true, packageCode: true } },
          order: { select: { id: true, orderNumber: true } },
          allocation: { select: { tripId: true, package: { select: { id: true, packageCode: true } }, orderItem: { select: { order: { select: { id: true, orderNumber: true } } } } } },
          orderStop: { select: { windowStart: true, windowEnd: true, windowBasis: true, serviceDurationMinutes: true } },
          pickupResult: { select: { outcome: true, reason: true, packageId: true, event: { select: { ...eventSelect, tripId: true } } } },
          deliveryState: { select: { state: true, pickupResult: { select: { packageId: true, event: { select: { tripId: true } } } }, lastEvent: { select: { ...eventSelect, tripId: true } } } },
          deliveryResults: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: {
            id: true, result: true, reason: true, packageId: true,
            deliveryAttempt: { select: { id: true, tripStopId: true, attemptNumber: true, occurredAt: true, recipientName: true, podFiles: { select: { ...podSelect, ...podLinks } } } },
          } },
        } },
      } });
      // Fail closed for inconsistent legacy links instead of selecting a convenient source.
      for (const stop of stops) for (const task of stop.tasks) {
        const packageId = task.package?.id || task.allocation?.package?.id;
        if ((task.allocation && task.allocation.tripId !== id) || (task.package && task.allocation?.package && task.package.id !== task.allocation.package.id) ||
          (task.order && task.allocation && task.order.id !== task.allocation.orderItem.order.id) ||
          (task.pickupResult && (task.pickupResult.packageId !== packageId || task.pickupResult.event.tripId !== id || task.pickupResult.event.stopTaskId !== task.id)) ||
          (task.deliveryState && (task.deliveryState.lastEvent.tripId !== id || task.deliveryState.lastEvent.stopTaskId !== task.id || task.deliveryState.pickupResult.packageId !== packageId || task.deliveryState.pickupResult.event.tripId !== id)) ||
          task.deliveryResults.some(r => r.packageId !== packageId || r.deliveryAttempt.tripStopId !== stop.id || r.deliveryAttempt.podFiles.some(p =>
            (p.tripStopId !== null && p.tripStopId !== stop.id) || (p.assignment !== null && p.assignment.tripId !== id) || (p.sourceSnapshot !== null && p.sourceSnapshot.tripId !== id)))) {
          throw new ConflictException({ code: 'MONITORING_LINK_CONFLICT', message: 'Quan hệ dữ liệu thực thi mâu thuẫn; cần đối soát' });
        }
      }
      const snapshot = await db.tripExecutionSnapshot.findUnique({ where: { tripId: id }, select: { id: true, sourceTripVersion: true, createdAt: true } });
      const loadPlan = await db.loadPlan.findFirst({ where: { tripId: id }, orderBy: { revision: 'desc' }, select: {
        id: true, revision: true, validationStatus: true, validatorVersion: true,
        steps: { orderBy: { stepNumber: 'asc' }, select: { id: true, stepNumber: true, operationType: true, tasks: { select: { id: true } }, placements: { select: { packageId: true, xMm: true, yMm: true, zMm: true, orientation: true, effectiveLengthMm: true, effectiveWidthMm: true, effectiveHeightMm: true } } } },
      } });
      const taskIds = new Set(stops.flatMap(s => s.tasks.map(t => t.id)));
      const packageIds = new Set(stops.flatMap(s => s.tasks.map(t => t.package?.id || t.allocation?.package?.id)));
      if (loadPlan?.steps.some(s => s.tasks.some(t => !taskIds.has(t.id)) || s.placements.some(p => !packageIds.has(p.packageId)))) {
        throw new ConflictException('Load Plan tham chiếu task/kiện ngoài chuyến; cần đối soát');
      }
      const route = await db.trip.findUniqueOrThrow({ where: { id }, select: { routeGeometry: true } });
      return { ...trip, routeGeometry: route.routeGeometry, stops: stops.map(s => ({ ...s, tasks: s.tasks.map(t => ({ ...t, package: t.package || t.allocation?.package || null, order: t.order || t.allocation?.orderItem.order || null, allocation: undefined,
        deliveryState: t.deliveryState ? { state: t.deliveryState.state, lastEvent: t.deliveryState.lastEvent } : null,
        deliveryResults: t.deliveryResults.map(r => ({ ...r, deliveryAttempt: { ...r.deliveryAttempt, podFiles: r.deliveryAttempt.podFiles.map(p => ({ id: p.id, uploadStatus: p.uploadStatus, mediaType: p.mediaType, sizeBytes: p.sizeBytes, capturedAt: p.capturedAt, uploadedAt: p.uploadedAt, discardedAt: p.discardedAt })) } })),
      })) })), snapshot, loadPlan, fetchedAt: new Date() };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async events(user: Principal, id: string, q: MonitoringPageQuery) {
    return this.prisma.$transaction(async db => {
      const trip = await this.trip(db, user, id);
      const where = { tripId: id };
      const total = await db.executionEvent.count({ where });
      const items = await db.executionEvent.findMany({ where, select: eventSelect, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize });
      return { items, total, page: q.page, pageSize: q.pageSize, version: trip.version };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async pod(user: Principal, id: string, podId: string) {
    await this.trip(this.prisma, user, id);
    const pod = await this.prisma.podFile.findFirst({
      where: { id: podId, deliveryAttempt: { tripStop: { tripId: id } } },
      include: {
        deliveryAttempt: { include: { results: { include: { stopTask: { select: {
          tripStopId: true, packageId: true, allocation: { select: { packageId: true } },
        } } } } } },
        assignment: { select: { tripId: true } },
        sourceSnapshot: { select: { tripId: true } },
      },
    });
    if (!pod?.deliveryAttempt || !pod.deliveryAttempt.results.length ||
      (pod.tripStopId && pod.tripStopId !== pod.deliveryAttempt.tripStopId) ||
      (pod.assignment && pod.assignment.tripId !== id) || (pod.sourceSnapshot && pod.sourceSnapshot.tripId !== id) ||
      pod.deliveryAttempt.results.some(r => r.stopTask.tripStopId !== pod.deliveryAttempt?.tripStopId || r.packageId !== (r.stopTask.packageId || r.stopTask.allocation?.packageId))) throw new NotFoundException('POD không thuộc chuyến/lần giao được phép');
    if (pod.uploadStatus !== 'UPLOADED' || pod.discardedAt) throw new ConflictException('POD chưa xác minh hoặc không còn khả dụng');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(pod.mediaType) || !pod.storageKey.startsWith('pod/')) throw new ConflictException('Định dạng POD không được hỗ trợ');
    const signed = new URL(await this.storage.getSignedDownloadUrl(pod.storageKey, user.id, 60), 'http://internal');
    const file = await this.storage.downloadWithSignature(pod.storageKey, user.id, Number(signed.searchParams.get('expires')), signed.searchParams.get('signature') || '');
    if (file.checksum !== pod.checksum || file.mimeType !== pod.mediaType || (pod.sizeBytes !== null && file.sizeBytes !== pod.sizeBytes)) throw new ConflictException('Nội dung POD không khớp dữ liệu đã xác minh');
    await this.prisma.auditLog.create({ data: { entityType: 'PodFile', entityId: pod.id, action: 'VIEW', performedBy: user.id, actorUserId: user.id } });
    return file;
  }
}
