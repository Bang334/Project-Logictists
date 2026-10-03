import { ConflictException } from '@nestjs/common';
import { DriverStatus, Role, TripStatus, VehicleStatus } from '@prisma/client';
import { TripsService } from '../../src/trips/trips.service';

describe('TripsService.publish', () => {
  const trip = {
    id: 'trip-1',
    tripNumber: 'TRIP-1',
    status: TripStatus.PLANNED,
    version: 4,
    managingBranchId: 'branch-1',
    vehicleId: 'vehicle-1',
    plannedStartTime: new Date('2026-10-04T01:00:00.000Z'),
    plannedEndTime: new Date('2026-10-04T03:00:00.000Z'),
    planningSnapshot: {
      orders: [{ id: 'order-1', version: 3 }],
      vehicle: { id: 'vehicle-1', updatedAt: '2026-10-03T00:00:00.000Z' },
      driver: { id: 'driver-1', updatedAt: '2026-10-03T00:00:00.000Z' },
    },
    vehicle: {
      id: 'vehicle-1',
      homeBranchId: 'branch-1',
      status: VehicleStatus.AVAILABLE,
      payloadCapacityKg: 1000,
      volumeCapacityM3: 10,
      plateNumber: '51A-00001',
    },
    assignments: [{
      id: 'assignment-1',
      role: 'PRIMARY',
      driverId: 'driver-1',
      driver: {
        id: 'driver-1',
        status: DriverStatus.AVAILABLE,
        licenseExpiry: new Date('2027-01-01T00:00:00.000Z'),
      },
    }],
    stops: [
      { id: 'stop-1', tasks: [{ id: 'task-1' }] },
      { id: 'stop-2', tasks: [{ id: 'task-2' }] },
    ],
  };
  const tx = {
    $queryRaw: jest.fn(),
    trip: { findUnique: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn() },
    driverAssignment: { findFirst: jest.fn() },
    order: { findMany: jest.fn() },
    vehicle: { findUnique: jest.fn() },
    driver: { findUnique: jest.fn() },
    loadPlan: { findFirst: jest.fn() },
    resourceReservation: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const outbox = { enqueue: jest.fn() };
  let service: TripsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new TripsService(prisma as never, {} as never, outbox as never);
    tx.trip.findUnique.mockResolvedValue(trip);
    tx.loadPlan.findFirst.mockResolvedValue({
      id: 'load-plan-1',
      validationStatus: 'VALID',
      steps: [{ stopTaskId: 'task-1' }, { stopTaskId: 'task-2' }],
    });
    tx.trip.updateMany.mockResolvedValue({ count: 1 });
    tx.trip.findFirst.mockResolvedValue(null);
    tx.driverAssignment.findFirst.mockResolvedValue(null);
    tx.order.findMany.mockResolvedValue([{ id: 'order-1', version: 3, status: 'ASSIGNED' }]);
    tx.vehicle.findUnique.mockResolvedValue({
      id: 'vehicle-1',
      status: VehicleStatus.AVAILABLE,
      updatedAt: new Date('2026-10-03T00:00:00.000Z'),
    });
    tx.driver.findUnique.mockResolvedValue({
      id: 'driver-1',
      status: DriverStatus.AVAILABLE,
      licenseExpiry: new Date('2027-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-03T00:00:00.000Z'),
    });
    tx.resourceReservation.findMany.mockResolvedValue([
      { vehicleId: 'vehicle-1', driverId: null, status: 'HELD' },
      { vehicleId: null, driverId: 'driver-1', status: 'HELD' },
    ]);
    tx.resourceReservation.updateMany.mockResolvedValue({ count: 2 });
  });

  it('publishes only the expected version with a complete valid load plan', async () => {
    const result = await service.publish(
      'trip-1',
      { expectedVersion: 4 },
      { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
    );

    expect(tx.trip.updateMany).toHaveBeenCalledWith({
      where: { id: 'trip-1', version: 4, status: TripStatus.PLANNED },
      data: { status: TripStatus.DISPATCHED, version: { increment: 1 } },
    });
    expect(outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        aggregateId: 'trip-1',
        aggregateVersion: 5,
        eventType: 'TRIP_PUBLISHED',
      }),
      tx,
    );
    expect(result).toMatchObject({ id: 'trip-1', status: TripStatus.DISPATCHED, version: 5 });
  });

  it('rejects a stale dispatcher version before changing state', async () => {
    await expect(
      service.publish(
        'trip-1',
        { expectedVersion: 3 },
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.trip.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a plan that does not cover every stop task', async () => {
    tx.loadPlan.findFirst.mockResolvedValue({
      id: 'load-plan-1',
      validationStatus: 'VALID',
      steps: [{ stopTaskId: 'task-1' }],
    });

    await expect(
      service.publish(
        'trip-1',
        { expectedVersion: 4 },
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects publish when the vehicle and driver reservations are missing', async () => {
    tx.resourceReservation.findMany.mockResolvedValue([]);

    await expect(
      service.publish(
        'trip-1',
        { expectedVersion: 4 },
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.trip.updateMany).not.toHaveBeenCalled();
  });

  it('rejects publish when the assigned driver is no longer available', async () => {
    tx.trip.findUnique.mockResolvedValue({
      ...trip,
      assignments: [
        {
          ...trip.assignments[0],
          driver: { ...trip.assignments[0].driver, status: DriverStatus.ON_LEAVE },
        },
      ],
    });

    await expect(
      service.publish(
        'trip-1',
        { expectedVersion: 4 },
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.trip.updateMany).not.toHaveBeenCalled();
  });

  it('rejects publish when an assigned order changed after planning', async () => {
    tx.order.findMany.mockResolvedValue([
      { id: 'order-1', version: 4, status: 'ASSIGNED' },
    ]);

    await expect(
      service.publish(
        'trip-1',
        { expectedVersion: 4 },
        { id: 'user-1', branchId: 'branch-1', role: Role.DISPATCHER },
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.trip.updateMany).not.toHaveBeenCalled();
  });
});
