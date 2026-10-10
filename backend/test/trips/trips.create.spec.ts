import { BadRequestException } from '@nestjs/common';
import { Role, VehicleStatus } from '@prisma/client';
import { TripsService } from '../../src/trips/trips.service';

describe('TripsService.create', () => {
  it('rejects a vehicle without an assigned home depot when planning', async () => {
    const prisma = {
      processedCommand: { findUnique: jest.fn().mockResolvedValue(null) },
      vehicle: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'vehicle-1',
          plateNumber: '51A-00001',
          status: VehicleStatus.AVAILABLE,
          homeBranchId: 'branch-1',
          homeDepotLocationId: null,
          homeDepotLocation: null,
          homeBranch: {
            id: 'branch-1',
            latitude: 10.7,
            longitude: 106.6,
          },
        }),
      },
    };
    const service = new TripsService(prisma as never, {} as never, {} as never, { tripInputs: jest.fn() } as never);

    await expect(
      service.create(
        {
          idempotencyKey: '0e0b449b-aaaf-41a5-aec2-ab270f247a86',
          vehicleId: 'vehicle-1',
          driverId: 'driver-1',
          plannedStartTime: '2026-10-04T01:00:00.000Z',
          plannedEndTime: '2026-10-04T03:00:00.000Z',
          startLocation: { address: 'Start', latitude: 10.7, longitude: 106.6 },
          endLocation: { address: 'End', latitude: 10.8, longitude: 106.7 },
          orderIds: ['order-1'],
        },
        { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create(
        {
          idempotencyKey: '0e0b449b-aaaf-41a5-aec2-ab270f247a86',
          vehicleId: 'vehicle-1',
          driverId: 'driver-1',
          plannedStartTime: '2026-10-04T01:00:00.000Z',
          plannedEndTime: '2026-10-04T03:00:00.000Z',
          startLocation: { address: 'Start', latitude: 10.7, longitude: 106.6 },
          endLocation: { address: 'End', latitude: 10.8, longitude: 106.7 },
          orderIds: ['order-1'],
        },
        { id: 'user-1', username: 'dispatcher', fullName: 'Dispatcher', sessionId: 'session', branchId: 'branch-1', role: Role.DISPATCHER, grants: [{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-1', permissions: ['trips.read', 'trips.plan', 'trips.publish'] }] },
      ),
    ).rejects.toThrow('chưa được gán kho đỗ');
  });
});
