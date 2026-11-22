import { assertPlanningCalendar } from '../../src/trips/planning-calendar';
import { ConflictException } from '@nestjs/common';

describe('planning calendar boundary', () => {
  const start = new Date('2031-01-01T16:00:00Z'); // 23:00 local
  const midnight = new Date('2031-01-01T17:00:00Z');
  const end = new Date('2031-01-01T19:00:00Z');
  const driver = { status: 'AVAILABLE', homeBranchId: 'a', employeeId: 'employee',
    employee: { employmentStatus: 'ACTIVE', branchId: 'a' }, licenseExpiry: new Date('2032-01-01') };
  function fixture() {
    return {
      driver: { findUnique: jest.fn().mockResolvedValue(driver) },
      driverShift: { findMany: jest.fn().mockResolvedValue([{ startsAt: start, endsAt: midnight }, { startsAt: midnight, endsAt: end }]) },
      employeeLeave: { findFirst: jest.fn().mockResolvedValue(null) },
      vehicleUnavailability: { findFirst: jest.fn().mockResolvedValue(null) },
      resourceReservation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
  }
  it('covers overnight work with adjoining shifts and excludes own reservation on publish', async () => {
    const tx = fixture();
    await expect(assertPlanningCalendar(tx as never, 'v', 'd', start, end, 'trip')).resolves.toBeUndefined();
    expect(tx.resourceReservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tripId: { not: 'trip' }, startsAt: { lt: end }, endsAt: { gt: start } }) }));
  });
  it('does not bridge a one millisecond gap', async () => {
    const tx = fixture();
    tx.driverShift.findMany.mockResolvedValue([{ startsAt: start, endsAt: midnight }, { startsAt: new Date(+midnight + 1), endsAt: end }]);
    await expect(assertPlanningCalendar(tx as never, 'v', 'd', start, end)).rejects.toBeInstanceOf(ConflictException);
  });
  it.each(['employeeLeave', 'vehicleUnavailability', 'resourceReservation'] as const)('rejects a current %s conflict', async key => {
    const tx = fixture(); tx[key].findFirst.mockResolvedValue({ id: 'conflict' });
    await expect(assertPlanningCalendar(tx as never, 'v', 'd', start, end)).rejects.toBeInstanceOf(ConflictException);
  });
  it('rejects missing employee and expiry during the trip', async () => {
    const tx = fixture();
    tx.driver.findUnique.mockResolvedValue({ ...driver, employee: null });
    await expect(assertPlanningCalendar(tx as never, 'v', 'd', start, end)).rejects.toBeInstanceOf(ConflictException);
    tx.driver.findUnique.mockResolvedValue({ ...driver, licenseExpiry: new Date('2031-01-01') });
    await expect(assertPlanningCalendar(tx as never, 'v', 'd', start, end)).rejects.toBeInstanceOf(ConflictException);
    await expect(assertPlanningCalendar(tx as never, 'v', 'd', start, midnight)).resolves.toBeUndefined();
  });
});
