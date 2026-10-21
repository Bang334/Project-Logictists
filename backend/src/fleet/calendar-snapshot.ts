import { PrismaService } from '../prisma/prisma.service';
/** Calendar facts for the planning owner; never includes identity documents or leave reasons. */
export async function calendarSnapshot(db: PrismaService, vehicleIds: string[], driverIds: string[], startsAt: Date, endsAt: Date) {
  return db.$transaction(async tx => {
    const drivers = await tx.driver.findMany({ where: { id: { in: driverIds } }, select: { id: true, employeeId: true, updatedAt: true, licenseClass: true, licenseExpiry: true } });
    const employeeIds = drivers.flatMap(d => d.employeeId ? [d.employeeId] : []);
    const overlap = { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } };
    const [vehicles, shifts, leave, vehicleBlocks, reservations] = await Promise.all([
      tx.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, updatedAt: true, vehicleTypeId: true } }),
      tx.driverShift.findMany({ where: { driverId: { in: driverIds }, status: 'ACTIVE', ...overlap }, select: { id: true, driverId: true, startsAt: true, endsAt: true, version: true } }),
      tx.employeeLeave.findMany({ where: { employeeId: { in: employeeIds }, approvalStatus: 'APPROVED', ...overlap }, select: { id: true, employeeId: true, startsAt: true, endsAt: true, version: true } }),
      tx.vehicleUnavailability.findMany({ where: { vehicleId: { in: vehicleIds }, status: 'ACTIVE', startsAt: { lt: endsAt }, OR: [{ endsAt: null }, { endsAt: { gt: startsAt } }] }, select: { id: true, vehicleId: true, startsAt: true, endsAt: true, kind: true, version: true } }),
      tx.resourceReservation.findMany({ where: { OR: [{ vehicleId: { in: vehicleIds } }, { driverId: { in: driverIds } }], status: { in: ['HELD', 'ACTIVE'] }, ...overlap }, select: { id: true, vehicleId: true, driverId: true, startsAt: true, endsAt: true, status: true, updatedAt: true } }),
    ]);
    return { contractVersion: 'fleet.calendar.v1', startsAt, endsAt, interval: '[)', timezone: 'Asia/Ho_Chi_Minh', drivers, vehicles, shifts, leave, vehicleBlocks, reservations, unchecked: ['ACTUAL_LOCATION', 'TRAVEL_TO_START', 'DRIVING_REST_POLICY', 'LICENSE_VEHICLE_COMPATIBILITY'] };
  }, { isolationLevel: 'RepeatableRead' });
}
