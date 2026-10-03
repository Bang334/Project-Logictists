import { ConflictException } from '@nestjs/common';
import { Role, TripStatus } from '@prisma/client';
import { TripsService } from '../../src/trips/trips.service';

describe('TripsService.updatePlan', () => {
  it('rejects a stale expectedVersion before routing or writing', async () => {
    const prisma = {
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          version: 3,
          status: TripStatus.PLANNED,
          managingBranchId: 'branch-1',
          vehicle: { homeBranchId: 'branch-1' },
          assignments: [],
          stops: [],
        }),
      },
      $transaction: jest.fn(),
    };
    const mapbox = { getRoute: jest.fn() };
    const service = new TripsService(prisma as never, mapbox as never, {} as never);

    await expect(
      service.updatePlan(
        'trip-1',
        {
          expectedVersion: 2,
          vehicleId: 'vehicle-1',
          driverId: 'driver-1',
          plannedStartTime: '2026-10-04T01:00:00.000Z',
          plannedEndTime: '2026-10-04T03:00:00.000Z',
          startLocation: { address: 'Start', latitude: 10.7, longitude: 106.6 },
          endLocation: { address: 'End', latitude: 10.8, longitude: 106.7 },
          orderedStopIds: [],
        },
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      ),
    ).rejects.toThrow(ConflictException);

    expect(mapbox.getRoute).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
