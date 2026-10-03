import { ConflictException } from '@nestjs/common';
import { Role, TripStatus } from '@prisma/client';
import { TripsService } from '../../src/trips/trips.service';

describe('TripsService.publish', () => {
  const trip = {
    id: 'trip-1',
    tripNumber: 'TRIP-1',
    status: TripStatus.PLANNED,
    version: 4,
    managingBranchId: 'branch-1',
    vehicle: { homeBranchId: 'branch-1' },
    assignments: [{ id: 'assignment-1', role: 'PRIMARY' }],
    stops: [
      { id: 'stop-1', tasks: [{ id: 'task-1' }] },
      { id: 'stop-2', tasks: [{ id: 'task-2' }] },
    ],
  };
  const tx = {
    $queryRaw: jest.fn(),
    trip: { findUnique: jest.fn(), updateMany: jest.fn() },
    loadPlan: { findFirst: jest.fn() },
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
});
