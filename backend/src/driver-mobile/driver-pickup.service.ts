import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Principal } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { DriverMobileService } from './driver-mobile.service';
import { CompletePickupDto, PickupPackageDto, InspectPickupDto } from './driver-mobile.dto';
import { planHash, readExecutionPlan, supportsPickup } from './execution-plan';
import { assertFixedLoadingPath, placementGeometry, pickupConflict as conflict } from './pickup-loading-guard';

type Operation = { kind: 'scan'; dto: InspectPickupDto } | { kind: 'load'; dto: PickupPackageDto } | { kind: 'complete'; dto: CompletePickupDto };

@Injectable()
export class DriverPickupService {
  constructor(private readonly prisma: PrismaService, private readonly mobile: DriverMobileService) {}

  async run(user: Principal, assignmentId: string, stopId: string, key: string | undefined, operation: Operation) {
    if (operation.kind === 'scan') key = randomUUID();
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new BadRequestException('Idempotency-Key không hợp lệ');
    const dto = operation.dto;
    const requestHash = planHash({ assignmentId, stopId, action: operation.kind, ...dto,
      ...(operation.kind === 'complete' ? { missing: [...operation.dto.missing].sort((a, b) => a.taskId.localeCompare(b.taskId)) } : {}),
    });
    return this.prisma.$transaction(async tx => {
      const driver = await this.mobile.identity(user, 'driver.trips.execute', tx);
      const offered = await tx.driverAssignment.findFirst({ where: { id: assignmentId, driverId: driver.id }, include: { trip: { select: { vehicleId: true } } } });
      if (!offered) throw new NotFoundException('Không tìm thấy phân công');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4101, hashtext(${offered.trip.vehicleId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4102, hashtext(${driver.id}))`;
      await tx.$queryRaw`SELECT id FROM users WHERE id=${user.id} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM drivers WHERE id=${driver.id} FOR UPDATE`;
      await this.mobile.identity(user, 'driver.trips.execute', tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(71009, hashtext(${user.id + ':' + key}))`;
      const commandType = 'DRIVER_PICKUP';
      const prior = await tx.processedCommand.findUnique({ where: { actorUserId_commandType_idempotencyKey: { actorUserId: user.id, commandType, idempotencyKey: key } } });
      await tx.$queryRaw`SELECT id FROM driver_assignments WHERE id=${assignmentId} FOR UPDATE`;
      const assignment = await tx.driverAssignment.findFirst({ where: { id: assignmentId, driverId: driver.id } });
      if (!assignment) throw new NotFoundException('Không tìm thấy phân công');
      if (prior) {
        if (prior.requestHash !== requestHash) conflict('IDEMPOTENCY_MISMATCH', 'Key đã dùng cho nội dung khác');
        if (prior.status === 'COMPLETED') return prior.result;
        conflict('COMMAND_IN_PROGRESS', 'Lệnh đang xử lý');
      }
      await tx.$queryRaw`SELECT id FROM trips WHERE id=${assignment.tripId} FOR UPDATE`;
      const trip = await tx.trip.findUniqueOrThrow({ where: { id: assignment.tripId }, include: { executionSnapshot: true, stops: { orderBy: { sequence: 'asc' } }, vehicle: true } });
      if (trip.vehicleId !== offered.trip.vehicleId || trip.id !== offered.tripId || trip.version !== dto.expectedTripVersion || assignment.version !== dto.expectedVersion) conflict('VERSION_CONFLICT', 'Kế hoạch hoặc phân công đã thay đổi; hãy tải lại');
      if (assignment.status !== 'ACCEPTED' || trip.status !== 'IN_PROGRESS' || !trip.actualStartTime) conflict('INVALID_TRANSITION', 'Cần nhận và bắt đầu chuyến trước khi lấy hàng');
      const stop = trip.stops.find(s => s.id === stopId);
      if (!stop) throw new NotFoundException('Không tìm thấy điểm dừng');
      if (stop.status !== 'ARRIVED' || !stop.actualArrivalTime || stop.actualDepartureTime) conflict('INVALID_TRANSITION', 'Điểm chưa đến hoặc đã kết thúc lấy hàng');
      if (trip.stops.some(s => s.sequence < stop.sequence && s.status !== 'COMPLETED')) conflict('PREVIOUS_STOP_INCOMPLETE', 'Cần hoàn tất điểm trước');
      const snapshot = trip.executionSnapshot;
      if (!snapshot || !supportsPickup(snapshot.plan)) conflict('PICKUP_SNAPSHOT_REQUIRED', 'Chuyến dùng snapshot cũ chưa có kế hoạch kiện; liên hệ điều phối. Không tự nâng cấp lịch sử.');
      // Freeze rows in a stable order. Package lock also serializes other Trips.
      await tx.$queryRaw`SELECT id FROM allocations WHERE "tripId"=${trip.id} ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT t.id FROM stop_tasks t JOIN trip_stops s ON s.id=t."tripStopId" WHERE s."tripId"=${trip.id} ORDER BY t.id FOR UPDATE OF t`;
      await tx.$queryRaw`SELECT p.id FROM packages p WHERE p.id IN (SELECT "packageId" FROM allocations WHERE "tripId"=${trip.id}) ORDER BY p.id FOR UPDATE`;
      const plan = await readExecutionPlan(tx, trip.id, true);
      if (planHash(plan) !== snapshot.planHash) conflict('PLAN_CHANGED', 'Kế hoạch kiện hoặc bố trí đã thay đổi sau khi bắt đầu; liên hệ điều phối');
      const tasks = await tx.stopTask.findMany({ where: { tripStopId: stop.id }, include: {
        pickupResult: true, allocation: { include: { package: true, orderItem: { select: { orderId: true } } } }, orderStop: true,
      }, orderBy: { id: 'asc' } });
      if (stop.stopType !== 'PICKUP' || !tasks.length || tasks.some(t => t.action !== 'LOAD')) conflict('UNSUPPORTED_PICKUP_STOP', 'Mốc này chỉ kết thúc điểm lấy hàng có toàn bộ task LOAD');
      for (const task of tasks) {
        const a = task.allocation, p = a?.package;
        if (!a || !p || a.tripId !== trip.id || a.orderItemId !== p.orderItemId || a.allocatedQuantity !== 1 || task.plannedQuantity !== 1 ||
            a.releasedAt || !['ALLOCATED', 'ACTIVE'].includes(a.status) || !task.orderStop || task.orderStop.type !== 'PICKUP' || task.orderStop.orderId !== a.orderItem.orderId ||
            task.actualQuantity !== (task.pickupResult ? (task.pickupResult.outcome === 'LOADED' ? 1 : 0) : null)) conflict('PLAN_DATA_CONFLICT', 'Task phải tham chiếu đúng một kiện, phân bổ và điểm lấy hợp lệ');
      }
      const now = new Date(), tripVersion = trip.version + 1;
      let commandPromise: ReturnType<typeof tx.processedCommand.create> | undefined;
      const getCommand = () => commandPromise ??= tx.processedCommand.create({ data: { actorUserId: user.id, commandType, idempotencyKey: key, requestHash, status: 'PROCESSING' } });
      let sequence = 0;
      const event = async (eventType: string, taskId?: string, payload: Prisma.InputJsonValue = {}) => tx.executionEvent.create({ data: {
        tripId: trip.id, tripStopId: stop.id, stopTaskId: taskId, eventType, actorUserId: user.id, commandId: (await getCommand()).id,
        sourceSnapshotId: snapshot.id, eventSequence: sequence++, occurredAt: now, payload,
      } });
      let eventId: string, packageId: string | null = null, outcome: string;
      if (operation.kind !== 'complete') {
        const qr = operation.dto.qrCode;
        const task = tasks.find(t => t.allocation?.package && (qr.startsWith('TMS:PACKAGE:')
          ? qr === `TMS:PACKAGE:1:${t.allocation.package.id}` : qr === t.allocation.package.packageCode));
        if (!task || !task.allocation?.package) throw new NotFoundException('QR không thuộc kiện cần lấy tại điểm này');
        const a = task.allocation, parcel = task.allocation.package;
        if (task.pickupResult) conflict('PACKAGE_ALREADY_RECORDED', 'Kiện đã được ghi nhận; quét lại không tăng số lượng');
        if (parcel.status !== 'ALLOCATED' || await tx.pickupResult.findFirst({ where: { packageId: parcel.id, outcome: 'LOADED' } })) conflict('PACKAGE_UNAVAILABLE', 'Kiện không còn ở trạng thái có thể nhận lên xe');
        if (parcel.weightG <= 0n) conflict('INVALID_LOAD_PLAN', 'Khối lượng kiện phải được xác minh trước khi xếp hàng');
        const loadPlan = await tx.loadPlan.findFirst({ where: { tripId: trip.id }, orderBy: { revision: 'desc' }, include: { steps: { include: { tasks: { select: { id: true } }, placements: true } } } });
        if (!loadPlan || loadPlan.validationStatus !== 'VALID') conflict('LOAD_PLAN_REQUIRED', 'Chưa có LoadPlan được kiểm chứng để xếp kiện');
        const geometry = loadPlan.geometrySnapshot;
        if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry) || geometry.doorPosition !== 'REAR') conflict('UNSUPPORTED_LOADING_PATH', 'Chưa có contract thực thi cho kiểu cửa xe này');
        if (geometry.lengthMm !== trip.vehicle.lengthCm * 10 || geometry.widthMm !== trip.vehicle.widthCm * 10 || geometry.heightMm !== trip.vehicle.heightCm * 10) conflict('INVALID_LOAD_PLAN', 'Hình học xe không khớp kế hoạch xếp hàng');
        const steps = loadPlan.steps.filter(s => s.stopTaskId === task.id || s.tasks.some(t => t.id === task.id));
        if (steps.length !== 1 || steps[0].operationType !== 'PICKUP') conflict('INVALID_LOAD_PLAN', 'Không xác định duy nhất bước xếp kiện trong kế hoạch');
        const step = steps[0], placement = step.placements.find(p => p.packageId === parcel.id);
        if (!placement || placement.effectiveLengthMm !== parcel.lengthMm || placement.effectiveWidthMm !== parcel.widthMm || placement.effectiveHeightMm !== parcel.heightMm) conflict('INVALID_LOAD_PLAN', 'Kích thước kiện và bố trí không khớp');
        const onboard = await tx.pickupResult.findMany({ where: { outcome: 'LOADED', event: { tripId: trip.id } }, include: { package: true, event: true } });
        const obstacles = onboard.map(result => {
          const p = step.placements.find(p => p.packageId === result.packageId);
          const payload = result.event.payload;
          if (!p || !payload || typeof payload !== 'object' || Array.isArray(payload) || payload.placementHash !== planHash(placementGeometry(p))) conflict('ONBOARD_PLAN_CONFLICT', 'Kế hoạch thay đổi vị trí kiện đang trên xe; không tự dịch chuyển kiện');
          return p;
        });
        // Placement rows have per-step IDs; hash only geometry for cross-step identity.
        assertFixedLoadingPath(placement, obstacles, trip.vehicle);
        const weight = onboard.reduce((sum, r) => sum + r.package.weightG, parcel.weightG);
        if (weight > BigInt(Math.floor(trip.vehicle.payloadCapacityKg * 1000))) conflict('CAPACITY_EXCEEDED', 'Tổng khối lượng thực tế vượt tải xe');
        if (operation.kind === 'scan') return { taskId: task.id, packageId: parcel.id, packageCode: parcel.packageCode, tripVersion: trip.version,
          loadPlanRevision: loadPlan.revision, placement: placementGeometry(placement) };
        const loaded = await event('PACKAGE_LOADED', task.id, { assignmentId, tripVersion, packageId: parcel.id, allocationId: a.id,
          vehicleId: trip.vehicleId, loadPlanId: loadPlan.id, loadPlanRevision: loadPlan.revision, loadPlanStepId: step.id,
          placementHash: planHash(placementGeometry(placement)), qrHash: planHash(qr), confirmationMethod: 'QR_AND_LOADED_ATTESTATION' });
        await tx.pickupResult.create({ data: { stopTaskId: task.id, eventId: loaded.id, packageId: parcel.id, allocationId: a.id, outcome: 'LOADED' } });
        await tx.stopTask.update({ where: { id: task.id }, data: { actualQuantity: 1 } });
        await tx.package.update({ where: { id: parcel.id }, data: { status: 'LOADED', version: { increment: 1 } } });
        eventId = loaded.id; packageId = parcel.id; outcome = 'LOADED';
      } else {
        const pending = tasks.filter(t => !t.pickupResult);
        const missing = operation.dto.missing;
        if (missing.length !== pending.length || missing.some(m => !pending.some(t => t.id === m.taskId))) throw new BadRequestException('Phải khai báo đúng từng kiện chưa lấy, không khai báo lại kiện đã lấy');
        const loadedCount = tasks.filter(t => t.pickupResult?.outcome === 'LOADED').length;
        outcome = loadedCount === tasks.length ? 'FULL' : loadedCount === 0 ? 'NONE' : 'PARTIAL';
        if (operation.dto.declaredOutcome !== outcome) throw new BadRequestException('Hiện trạng khai báo không khớp số kiện máy chủ đã ghi nhận');
        for (const item of missing) {
          const task = pending.find(t => t.id === item.taskId);
          if (!task?.allocation?.package) conflict('PLAN_DATA_CONFLICT', 'Không xác định được kiện chưa lấy');
          const absent = await event('PACKAGE_NOT_COLLECTED', task.id, { assignmentId, tripVersion, packageId: task.allocation.package.id, allocationId: task.allocation.id });
          await tx.pickupResult.create({ data: { stopTaskId: task.id, eventId: absent.id, packageId: task.allocation.package.id, allocationId: task.allocation.id, outcome: 'NOT_COLLECTED', reason: item.reason } });
          await tx.stopTask.update({ where: { id: task.id }, data: { actualQuantity: 0 } });
        }
        const completed = await event('PICKUP_STOP_COMPLETED', undefined, { assignmentId, tripVersion, outcome, plannedCount: tasks.length, loadedCount, missingCount: pending.length });
        await tx.tripStop.update({ where: { id: stop.id }, data: { status: 'COMPLETED', actualDepartureTime: now } });
        eventId = completed.id;
      }
      await tx.trip.update({ where: { id: trip.id }, data: { version: { increment: 1 } } });
      const result = { assignmentId, tripId: trip.id, stopId, tripVersion, eventId, packageId, outcome, occurredAt: now.toISOString() };
      const command = await getCommand();
      await tx.auditLog.create({ data: { entityType: 'Trip', entityId: trip.id, action: operation.kind === 'load' ? 'PACKAGE_LOADED' : 'PICKUP_STOP_COMPLETED', performedBy: user.id, actorUserId: user.id, changeSummary: { commandId: command.id, eventId, tripVersion } } });
      await tx.outboxEvent.create({ data: { eventId: randomUUID(), aggregateType: 'Trip', aggregateId: trip.id, aggregateVersion: tripVersion,
        eventType: operation.kind === 'load' ? 'driver.package.loaded' : 'driver.pickup.completed', payload: { tripId: trip.id, assignmentId, stopId, tripVersion, executionEventId: eventId, outcome } } });
      await tx.processedCommand.update({ where: { id: command.id }, data: { status: 'COMPLETED', result } });
      return result;
    }, { timeout: 15000 });
  }
}
