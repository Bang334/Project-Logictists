import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type ResourceKind = 'vehicles' | 'drivers';
export function interval(startsAt: string, endsAt: string) {
  const start = new Date(startsAt), end = new Date(endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new BadRequestException({ code: 'INVALID_INTERVAL', message: 'Thời điểm kết thúc phải sau bắt đầu' });
  return { start, end };
}
export function licenseValidUntilExclusive(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - 7 * 3600000);
}
export function minimumLicenseDate(instant: Date): Date {
  const local = new Date(instant.getTime() + 7 * 3600000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}
export function coversInterval(shifts: Array<{ startsAt: Date; endsAt: Date }>, start: Date, end: Date): boolean {
  let cursor = start.getTime();
  for (const shift of [...shifts].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    if (shift.startsAt.getTime() > cursor) return false;
    cursor = Math.max(cursor, shift.endsAt.getTime());
    if (cursor >= end.getTime()) return true;
  }
  return false;
}

/** Shared temporal data checks, not a routing/spatial/rest validator. Caller holds resource locks on publish. */
export async function resourceAvailability(db: Prisma.TransactionClient, kind: ResourceKind, id: string, start: Date, end: Date, excludeTripId?: string) {
  const overlap = { startsAt: { lt: end }, endsAt: { gt: start } };
  const reservations = await db.resourceReservation.findMany({ where: {
    ...(kind === 'vehicles' ? { vehicleId: id } : { driverId: id }), ...overlap,
    status: { in: ['HELD', 'ACTIVE'] }, ...(excludeTripId ? { tripId: { not: excludeTripId } } : {}),
  }, select: { tripId: true }, take: 101 });
  const tripIds = new Set(reservations.map(r => r.tripId));
  const reasons: string[] = [];
  let profileActive: boolean, dataComplete: boolean, version: string;
  let scheduleCovered: boolean | null = null;
  let vehicleGeometry: { lengthMm: number; widthMm: number; heightMm: number; payloadG: number; doorPosition: string; doorOpeningMm: null; obstacles: null } | null = null;
  if (kind === 'vehicles') {
    const v = await db.vehicle.findUniqueOrThrow({ where: { id }, include: { vehicleTypeRecord: true } });
    version = v.updatedAt.toISOString(); profileActive = v.status === 'AVAILABLE';
    vehicleGeometry = { lengthMm: v.vehicleTypeRecord.lengthCm * 10, widthMm: v.vehicleTypeRecord.widthCm * 10, heightMm: v.vehicleTypeRecord.heightCm * 10, payloadG: v.vehicleTypeRecord.payloadCapacityKg * 1000, doorPosition: 'REAR', doorOpeningMm: null, obstacles: null };
    dataComplete = v.vehicleTypeRecord.active && [v.vehicleTypeRecord.payloadCapacityKg, v.vehicleTypeRecord.lengthCm, v.vehicleTypeRecord.widthCm, v.vehicleTypeRecord.heightCm].every(n => Number.isFinite(n) && n > 0) && v.homeDepotLocationId !== null;
    if (!dataComplete) reasons.push('VEHICLE_PROFILE_INCOMPLETE');
    // Door opening/obstacle geometry is not present in the current schema. Never invent it.
    reasons.push('DOOR_AND_OBSTACLE_DATA_UNVERIFIED');
    dataComplete = false;
    const blocked = await db.vehicleUnavailability.findFirst({ where: { vehicleId: id, status: 'ACTIVE', startsAt: { lt: end }, OR: [{ endsAt: null }, { endsAt: { gt: start } }] }, select: { id: true } });
    if (blocked) reasons.push('VEHICLE_UNAVAILABILITY');
    const trips = await db.trip.findMany({ where: { vehicleId: id, ...(excludeTripId ? { id: { not: excludeTripId } } : {}), status: { in: ['PLANNED', 'DISPATCHED', 'IN_PROGRESS'] }, plannedStartTime: { lt: end }, plannedEndTime: { gt: start } }, select: { id: true }, take: 101 });
    trips.forEach(t => tripIds.add(t.id));
  } else {
    const d = await db.driver.findUniqueOrThrow({ where: { id }, include: { employee: true } });
    version = d.updatedAt.toISOString(); profileActive = d.status === 'AVAILABLE' && d.employee?.employmentStatus === 'ACTIVE';
    dataComplete = !!d.employee && d.employee.branchId === d.homeBranchId && !!d.licenseClass && !!d.licenseNumber;
    if (!d.employeeId) reasons.push('EMPLOYEE_LINK_MISSING');
    if (d.employee && d.employee.branchId !== d.homeBranchId) reasons.push('EMPLOYEE_BRANCH_MISMATCH');
    if (licenseValidUntilExclusive(d.licenseExpiry) < end) reasons.push('LICENSE_EXPIRES_BEFORE_WORK_END');
    const shifts = await db.driverShift.findMany({ where: { driverId: id, status: 'ACTIVE', ...overlap }, orderBy: { startsAt: 'asc' } });
    scheduleCovered = coversInterval(shifts, start, end);
    if (!scheduleCovered) reasons.push('SHIFT_NOT_COVERING_INTERVAL');
    if (d.employeeId && await db.employeeLeave.findFirst({ where: { employeeId: d.employeeId, approvalStatus: 'APPROVED', ...overlap }, select: { id: true } })) reasons.push('EMPLOYEE_LEAVE');
    const assignments = await db.driverAssignment.findMany({ where: { driverId: id, ...(excludeTripId ? { tripId: { not: excludeTripId } } : {}), startTime: { lt: end }, endTime: { gt: start }, trip: { status: { in: ['PLANNED', 'DISPATCHED', 'IN_PROGRESS'] } } }, select: { tripId: true }, take: 101 });
    assignments.forEach(a => tripIds.add(a.tripId));
  }
  if (!profileActive) reasons.push('PROFILE_NOT_ACTIVE');
  if (tripIds.size) reasons.push('RESERVED_OR_ASSIGNED');
  return { resourceId: id, kind, version, profileActive, dataComplete, scheduleCovered, reasons,
    blockingTripIds: [...tripIds], conflictsTruncated: tripIds.size > 100,
    unchecked: ['ACTUAL_LOCATION', 'TRAVEL_TO_START', 'DRIVING_REST_POLICY', 'LICENSE_VEHICLE_COMPATIBILITY', 'SPATIAL_VALIDATION'],
    startsAt: start.toISOString(), endsAt: end.toISOString(), timezone: 'Asia/Ho_Chi_Minh', contractVersion: 'fleet.v1',
    units: { profileLength: 'cm', profileMass: 'kg', geometryLength: 'mm', geometryMass: 'g' }, vehicleGeometry, snapshotOnly: true };
}
