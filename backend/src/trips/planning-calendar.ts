import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { coversInterval, licenseValidUntilExclusive } from '../fleet/availability';

/** Temporal checks only; caller owns the shared 4101/4102 resource locks.
 * Spatial validation and travel-to-start remain separate mandatory checks.
 */
export async function assertPlanningCalendar(
  tx: Prisma.TransactionClient,
  vehicleId: string,
  driverId: string,
  startsAt: Date,
  endsAt: Date,
  excludeTripId?: string,
): Promise<void> {
  const overlap = { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } };
  const [driver, shifts, block, reservation] = await Promise.all([
    tx.driver.findUnique({ where: { id: driverId }, include: { employee: true } }),
    tx.driverShift.findMany({ where: { driverId, status: 'ACTIVE', ...overlap } }),
    tx.vehicleUnavailability.findFirst({ where: {
      vehicleId, status: 'ACTIVE', startsAt: { lt: endsAt },
      OR: [{ endsAt: null }, { endsAt: { gt: startsAt } }],
    }, select: { id: true } }),
    tx.resourceReservation.findFirst({ where: {
      OR: [{ vehicleId }, { driverId }], status: { in: ['HELD', 'ACTIVE'] },
      ...overlap, ...(excludeTripId ? { tripId: { not: excludeTripId } } : {}),
    }, select: { id: true } }),
  ]);
  const reasons: string[] = [];
  if (!driver || driver.status !== 'AVAILABLE' ||
      driver.employee?.employmentStatus !== 'ACTIVE' ||
      driver.employee.branchId !== driver.homeBranchId) reasons.push('DRIVER_PROFILE_INCOMPLETE');
  if (driver && licenseValidUntilExclusive(driver.licenseExpiry) < endsAt) reasons.push('LICENSE_EXPIRES_BEFORE_WORK_END');
  if (!coversInterval(shifts, startsAt, endsAt)) reasons.push('SHIFT_NOT_COVERING_INTERVAL');
  if (driver?.employeeId && await tx.employeeLeave.findFirst({ where: {
    employeeId: driver.employeeId, approvalStatus: 'APPROVED', ...overlap,
  }, select: { id: true } })) reasons.push('EMPLOYEE_LEAVE');
  if (block) reasons.push('VEHICLE_UNAVAILABILITY');
  if (reservation) reasons.push('RESERVED_OR_ASSIGNED');
  if (reasons.length) throw new ConflictException({
    code: 'PLANNING_CALENDAR_CONFLICT',
    message: 'Lịch hoặc hồ sơ tài nguyên không đáp ứng khoảng thời gian chuyến; tải lại để lập phương án.',
    reasons,
  });
}
