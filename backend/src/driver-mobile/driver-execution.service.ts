import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Principal } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { DriverMobileService } from './driver-mobile.service';
import { readExecutionPlan, planHash, jsonValue, supportsPickup } from './execution-plan';
import { AssignmentResponseDto } from './driver-mobile.dto';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }

@Injectable()
export class DriverExecutionService {
  constructor(private readonly prisma: PrismaService, private readonly mobile: DriverMobileService) {}

  async execute(user: Principal, assignmentId: string, key: string | undefined,
    dto: AssignmentResponseDto, stopId?: string) {
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new BadRequestException('Idempotency-Key không hợp lệ');
    const action = stopId ? 'STOP_ARRIVED' : 'TRIP_STARTED';
    const requestHash = hash({ assignmentId, stopId: stopId ?? null, action,
      expectedVersion: dto.expectedVersion, expectedTripVersion: dto.expectedTripVersion });
    return this.prisma.$transaction(async tx => {
      const driver = await this.mobile.identity(user, 'driver.trips.execute', tx);
      const offered = await tx.driverAssignment.findFirst({ where: { id: assignmentId, driverId: driver.id }, include: { trip: { select: { vehicleId: true } } } });
      if (!offered) throw new NotFoundException('Không tìm thấy phân công');
      // Same resource lock namespaces/order as planning/publish. Serializes starts
      // on different Trips sharing a driver or vehicle, not just the current row.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4101, hashtext(${offered.trip.vehicleId}))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4102, hashtext(${driver.id}))`;
      await tx.$queryRaw`SELECT id FROM users WHERE id=${user.id} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM drivers WHERE id=${driver.id} FOR UPDATE`;
      await this.mobile.identity(user, 'driver.trips.execute', tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(71008, hashtext(${user.id + ':' + key}))`;
      const commandType = 'DRIVER_TRIP_EXECUTION';
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
      const trip = await tx.trip.findUniqueOrThrow({ where: { id: assignment.tripId }, include: { executionSnapshot: true, stops: { orderBy: { sequence: 'asc' } } } });
      if (trip.vehicleId !== offered.trip.vehicleId || trip.id !== offered.tripId) conflict('VERSION_CONFLICT', 'Phân công đã thay đổi; hãy tải lại');
      if (trip.version !== dto.expectedTripVersion || assignment.version !== dto.expectedVersion) conflict('VERSION_CONFLICT', 'Kế hoạch hoặc phân công đã thay đổi; hãy tải lại');
      if (assignment.status !== 'ACCEPTED') conflict('ASSIGNMENT_NOT_ACCEPTED', 'Cần nhận chuyến trước khi thực hiện');
      const now = new Date();
      const version2 = !stopId || !!trip.executionSnapshot && supportsPickup(trip.executionSnapshot.plan);
      const plan = await readExecutionPlan(tx, trip.id, version2);
      let snapshot = trip.executionSnapshot;
      if (!stopId) {
        if (trip.status !== 'DISPATCHED' || trip.actualStartTime || snapshot) conflict('INVALID_TRANSITION', 'Chuyến không còn cho phép bắt đầu');
        if (!trip.stops.length || trip.stops.some(s => s.status !== 'PENDING' || s.actualArrivalTime || s.actualDepartureTime)) conflict('INVALID_EXECUTION_STATE', 'Trạng thái điểm dừng không hợp lệ để bắt đầu');
        await tx.$queryRaw`SELECT id FROM vehicles WHERE id=${trip.vehicleId} FOR UPDATE`;
        const vehicle = await tx.vehicle.findUniqueOrThrow({ where: { id: trip.vehicleId } });
        const currentDriver = await tx.driver.findUniqueOrThrow({ where: { id: driver.id } });
        const end = new Date(Math.max(now.getTime(), trip.plannedEndTime.getTime()));
        if (vehicle.status !== 'AVAILABLE' || currentDriver.status !== 'AVAILABLE' || currentDriver.licenseExpiry <= end) conflict('RESOURCE_UNAVAILABLE', 'Xe hoặc tài xế không còn hợp lệ cho chuyến');
        const busyTrip = await tx.trip.findFirst({ where: {
          id: { not: trip.id }, status: 'IN_PROGRESS', OR: [
            { vehicleId: trip.vehicleId }, { assignments: { some: { driverId: driver.id, status: { not: 'REJECTED' } } } },
          ],
        }, select: { id: true } });
        if (busyTrip) conflict('RESOURCE_BUSY', 'Xe hoặc tài xế đang thực hiện chuyến khác');
        const unavailable = await tx.vehicleUnavailability.findFirst({ where: { vehicleId: trip.vehicleId, status: 'ACTIVE', startsAt: { lte: end }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] } });
        const leave = await tx.driverLeave.findFirst({ where: { driverId: driver.id, status: 'APPROVED', startsAt: { lte: end }, endsAt: { gt: now } } });
        if (unavailable || leave) conflict('RESOURCE_UNAVAILABLE', 'Xe hoặc tài xế có khoảng không khả dụng');
        // JSON round-trip converts Prisma dates to stable ISO strings without
        // reading credentials, financial fields or optimizer internals.
        const savedPlan: Prisma.InputJsonValue = jsonValue(plan);
        snapshot = await tx.tripExecutionSnapshot.create({ data: { tripId: trip.id, sourceTripVersion: trip.version, planHash: planHash(plan, version2), plan: savedPlan } });
        await tx.trip.update({ where: { id: trip.id }, data: { status: 'IN_PROGRESS', actualStartTime: now, version: { increment: 1 } } });
      } else {
        if (trip.status !== 'IN_PROGRESS' || !trip.actualStartTime || !snapshot) conflict('INVALID_TRANSITION', 'Chuyến chưa bắt đầu bằng luồng thực thi hợp lệ');
        if (planHash(plan, version2) !== snapshot.planHash) conflict('PLAN_CHANGED', 'Kế hoạch đã thay đổi sau khi bắt đầu; liên hệ điều phối');
        const stop = trip.stops.find(s => s.id === stopId);
        if (!stop) throw new NotFoundException('Điểm dừng không thuộc chuyến');
        if (stop.status !== 'PENDING' || stop.actualArrivalTime) conflict('INVALID_TRANSITION', 'Điểm dừng đã được ghi nhận');
        if (trip.stops.some(s => s.sequence < stop.sequence && s.status !== 'COMPLETED')) conflict('PREVIOUS_STOP_INCOMPLETE', 'Cần hoàn tất điểm trước trước khi đến điểm này');
        await tx.tripStop.update({ where: { id: stop.id }, data: { status: 'ARRIVED', actualArrivalTime: now } });
        await tx.trip.update({ where: { id: trip.id }, data: { version: { increment: 1 } } });
      }
      const command = await tx.processedCommand.create({ data: { actorUserId: user.id, commandType, idempotencyKey: key, requestHash, status: 'PROCESSING' } });
      const event = await tx.executionEvent.create({ data: {
        tripId: trip.id, tripStopId: stopId, actorUserId: user.id, commandId: command.id,
        sourceSnapshotId: snapshot.id, eventType: action, occurredAt: now,
        payload: { assignmentId, tripVersion: trip.version + 1, confirmationMethod: 'DRIVER_MANUAL' },
      } });
      const result = { assignmentId, tripId: trip.id, tripVersion: trip.version + 1, stopId: stopId ?? null,
        eventId: event.id, snapshotId: snapshot.id, sourceTripVersion: snapshot.sourceTripVersion, occurredAt: now.toISOString(), status: stopId ? 'ARRIVED' : 'IN_PROGRESS' };
      await tx.auditLog.create({ data: { entityType: 'Trip', entityId: trip.id, action, performedBy: user.id, actorUserId: user.id, changeSummary: { commandId: command.id, eventId: event.id, tripVersion: trip.version + 1 } } });
      await tx.outboxEvent.create({ data: { eventId: randomUUID(), aggregateType: 'Trip', aggregateId: trip.id, aggregateVersion: trip.version + 1,
        eventType: stopId ? 'driver.stop.arrived' : 'driver.trip.started', payload: { tripId: trip.id, assignmentId, stopId: stopId ?? null, tripVersion: trip.version + 1, executionEventId: event.id } } });
      await tx.processedCommand.update({ where: { id: command.id }, data: { status: 'COMPLETED', result } });
      return result;
    }, { timeout: 15000 });
  }
}
