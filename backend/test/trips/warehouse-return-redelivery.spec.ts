import { ConflictException } from '@nestjs/common';
import {
  LocationType,
  OrderStatus,
  PackageEventType,
  PackageStatus,
  ReservationStatus,
  StopType,
  TaskAction,
  TripStatus,
} from '@prisma/client';
import axios from 'axios';
import { WarehousesService } from '../../src/locations/warehouses.service';
import { DriverContinuationService } from '../../src/driver-mobile/driver-continuation.service';
import { OrdersService } from '../../src/orders/orders.service';
import { TripsService } from '../../src/trips/trips.service';
import { Principal } from '../../src/auth/access';

const adminUser: Principal = {
  id: 'user-admin-1',
  sessionId: 'sess-1',
  username: 'admin',
  fullName: 'Quản trị',
  role: 'ADMIN',
  branchId: 'branch-dad',
  grants: [{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: ['branches.read', 'branches.manage', 'orders.read', 'orders.write', 'trips.read', 'trips.plan', 'trips.publish'] }],
};

const driverUser: Principal = {
  id: 'user-driver-1',
  sessionId: 'sess-driver-1',
  username: 'driver1',
  fullName: 'Tài xế A',
  role: 'DRIVER',
  branchId: 'branch-dad',
  grants: [{ role: 'DRIVER', scopeType: 'BRANCH', branchId: 'branch-dad', permissions: ['driver.profile.read', 'driver.assignments.read', 'driver.assignments.respond'] }],
};

describe('Warehouse Return, 3D Blocking & Next-Day Hub Pickup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('WarehousesService blocks deactivating a warehouse holding custody READY packages', async () => {
    const prisma = {
      location: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wh-1',
          code: 'WH-DAD-01',
          name: 'Kho Đà Nẵng',
          type: LocationType.CENTRAL_WAREHOUSE,
          managingBranchId: 'branch-dad',
          active: true,
        }),
        update: jest.fn(),
      },
      package: {
        count: jest.fn().mockResolvedValue(2),
      },
    };

    const service = new WarehousesService(prisma as never);
    await expect(
      service.updateWarehouse(adminUser, 'wh-1', { active: false }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.location.update).not.toHaveBeenCalled();
  });

  it('DriverContinuationService executes A1+A2 on customer unavailability and completes return to warehouse', async () => {
    const axiosPostSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        trip_id: 'trip-1',
        used_exact_placements: true,
        stop_decisions: [
          {
            stop_id: 'stop-c',
            sequence: 3,
            stop_type: 'DELIVERY',
            order_id: 'ord-c',
            decision: 'RETURN_TO_HUB',
            reason_code: 'BLOCKED_BY_RETAINED_CARGO',
            blocker_item_ids: ['pkg-b'],
          },
          {
            stop_id: 'stop-d',
            sequence: 4,
            stop_type: 'DELIVERY',
            order_id: 'ord-d',
            decision: 'KEEP_DELIVER',
            reason_code: 'CLEAR',
            unload_sequence: ['pkg-d'],
          },
          {
            stop_id: 'stop-u-pick',
            sequence: 5,
            stop_type: 'PICKUP',
            order_id: 'ord-u',
            decision: 'DETACH_TO_FREE_VEHICLE',
            reason_code: 'INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO',
          },
        ],
        keep_delivery_stop_ids: ['stop-d'],
        return_to_hub_stop_ids: ['stop-c'],
        return_to_hub_item_ids: ['pkg-b', 'pkg-c'],
        detached_order_ids: ['ord-u'],
        diagnostics: [],
      },
    });

    const tripStopUpdates: Array<{ id: string; data: unknown }> = [];
    const allocationUpdates: Array<unknown> = [];
    const packageUpdates: Array<unknown> = [];
    const orderUpdates: Array<unknown> = [];
    const stopTaskCreates: Array<unknown> = [];
    const packageEvents: Array<unknown> = [];

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      driver: {
        findUnique: jest.fn().mockResolvedValue({ id: 'drv-1', homeBranchId: 'branch-dad', status: 'ON_DUTY' }),
        update: jest.fn().mockResolvedValue({}),
      },
      driverAssignment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'asg-1',
          driverId: 'drv-1',
          tripId: 'trip-1',
          status: 'ACCEPTED',
          version: 1,
          startStopId: null,
          endStopId: null,
          startTime: new Date('2026-11-25T01:00:00Z'),
          endTime: new Date('2026-11-25T10:00:00Z'),
        }),
      },
      executionEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      trip: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'trip-1',
          managingBranchId: 'branch-dad',
          status: TripStatus.IN_PROGRESS,
          version: 2,
          vehicleId: 'veh-1',
          actualStartTime: new Date('2026-11-25T01:00:00Z'),
          plannedEndTime: new Date('2026-11-25T10:00:00Z'),
          vehicle: { homeBranchId: 'branch-dad' },
        }),
        update: jest.fn().mockResolvedValue({ version: 3, status: TripStatus.IN_PROGRESS }),
      },
      stopTask: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'task-b-deliv',
            tripStopId: 'stop-b',
            actualQuantity: 0,
            packageId: 'pkg-b',
            allocation: { id: 'alloc-b', packageId: 'pkg-b' },
            tripStop: {
              id: 'stop-b',
              sequence: 2,
              status: 'PENDING',
              plannedArrivalTime: new Date('2026-11-25T03:00:00Z'),
              plannedDepartureTime: new Date('2026-11-25T03:15:00Z'),
            },
          })
          .mockResolvedValueOnce({ id: 'task-b-pickup' }),
        findMany: jest.fn().mockResolvedValue([
          { actualQuantity: 0, deliveryResults: [{ id: 'dr-1' }] },
        ]),
        create: jest.fn().mockImplementation(async (args) => {
          stopTaskCreates.push(args);
          return {};
        }),
      },
      deliveryResult: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      package: {
        updateMany: jest.fn().mockImplementation(async (args) => {
          packageUpdates.push(args);
          return { count: 1 };
        }),
      },
      deliveryAttempt: {
        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNumber: 0 } }),
        create: jest.fn().mockResolvedValue({ id: 'att-1' }),
      },
      packageEvent: {
        create: jest.fn().mockImplementation(async (args) => {
          packageEvents.push(args);
          return {};
        }),
      },
      tripStop: {
        update: jest.fn().mockImplementation(async (args) => {
          tripStopUpdates.push({ id: args.where.id, data: args.data });
          return { id: args.where.id, sequence: 99 };
        }),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'stop-c',
            sequence: 3,
            stopType: StopType.DELIVERY,
            status: 'PENDING',
            plannedArrivalTime: new Date('2026-11-25T04:00:00Z'),
            tasks: [
              {
                orderId: 'ord-c',
                packageId: 'pkg-c',
                orderStop: { windowEnd: null, windowStart: null },
                allocation: {
                  orderItem: { orderId: 'ord-c', order: { id: 'ord-c', orderNumber: 'ORD-C', customerId: 'cust-1' } },
                  package: { id: 'pkg-c', lengthMm: 1500, widthMm: 1000, heightMm: 800, weightG: 400000n, cargoKind: 'STANDARD', allowUpperTier: true, noTopLoadRequested: false, maxTopLoadG: null, allowedOrientations: null, status: PackageStatus.LOADED },
                },
              },
            ],
          },
          {
            id: 'stop-d',
            sequence: 4,
            stopType: StopType.DELIVERY,
            status: 'PENDING',
            plannedArrivalTime: new Date('2026-11-25T05:00:00Z'),
            tasks: [
              {
                orderId: 'ord-d',
                packageId: 'pkg-d',
                orderStop: { windowEnd: null, windowStart: null },
                allocation: {
                  orderItem: { orderId: 'ord-d', order: { id: 'ord-d', orderNumber: 'ORD-D', customerId: 'cust-2' } },
                  package: { id: 'pkg-d', lengthMm: 1000, widthMm: 1000, heightMm: 800, weightG: 100000n, cargoKind: 'STANDARD', allowUpperTier: true, noTopLoadRequested: false, maxTopLoadG: null, allowedOrientations: null, status: PackageStatus.LOADED },
                },
              },
            ],
          },
          {
            id: 'stop-u-pick',
            sequence: 5,
            stopType: StopType.PICKUP,
            status: 'PENDING',
            plannedArrivalTime: new Date('2026-11-25T06:00:00Z'),
            tasks: [
              {
                orderId: 'ord-u',
                packageId: 'pkg-u',
                orderStop: { windowEnd: null, windowStart: null },
                allocation: {
                  orderItem: { orderId: 'ord-u', order: { id: 'ord-u', orderNumber: 'ORD-U', customerId: 'cust-3' } },
                  package: { id: 'pkg-u', lengthMm: 1000, widthMm: 1000, heightMm: 800, weightG: 300000n, cargoKind: 'STANDARD', allowUpperTier: true, noTopLoadRequested: false, maxTopLoadG: null, allowedOrientations: null, status: PackageStatus.ALLOCATED },
                },
              },
            ],
          },
        ]),
        findFirst: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({ _max: { sequence: 5 } }),
        create: jest.fn().mockResolvedValue({ id: 'stop-depot-end', sequence: 6 }),
      },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({ homeDepotLocationId: 'wh-dad' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'veh-1',
          plateNumber: '43C-12345',
          vehicleTypeRecord: { lengthCm: 400, widthCm: 200, heightCm: 200, payloadCapacityKg: 3000 },
        }),
      },
      location: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wh-dad',
          code: 'WH-DAD-01',
          name: 'Kho Đà Nẵng',
          type: LocationType.CENTRAL_WAREHOUSE,
          address: '123 Tôn Đức Thắng',
          latitude: 16.06,
          longitude: 108.15,
          active: true,
        }),
      },
      allocation: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'alloc-b',
              packageId: 'pkg-b',
              orderItem: { orderId: 'ord-b', order: { id: 'ord-b', customerId: 'cust-1' } },
              package: { id: 'pkg-b', lengthMm: 800, widthMm: 800, heightMm: 500, weightG: 50000n, cargoKind: 'STANDARD', allowUpperTier: true, noTopLoadRequested: false, maxTopLoadG: null, allowedOrientations: null, status: PackageStatus.LOADED },
              tasks: [{ tripStopId: 'stop-b', deliveryResults: [{ id: 'dr-1' }] }],
            },
            {
              id: 'alloc-c',
              packageId: 'pkg-c',
              orderItem: { orderId: 'ord-c', order: { id: 'ord-c', customerId: 'cust-1' } },
              package: { id: 'pkg-c', lengthMm: 1500, widthMm: 1000, heightMm: 800, weightG: 400000n, cargoKind: 'STANDARD', allowUpperTier: true, noTopLoadRequested: false, maxTopLoadG: null, allowedOrientations: null, status: PackageStatus.LOADED },
              tasks: [{ tripStopId: 'stop-c', deliveryResults: [] }],
            },
            {
              id: 'alloc-d',
              packageId: 'pkg-d',
              orderItem: { orderId: 'ord-d', order: { id: 'ord-d', customerId: 'cust-2' } },
              package: { id: 'pkg-d', lengthMm: 1000, widthMm: 1000, heightMm: 800, weightG: 100000n, cargoKind: 'STANDARD', allowUpperTier: true, noTopLoadRequested: false, maxTopLoadG: null, allowedOrientations: null, status: PackageStatus.LOADED },
              tasks: [{ tripStopId: 'stop-d', deliveryResults: [] }],
            },
          ])
          .mockResolvedValueOnce([{ id: 'alloc-u', packageId: 'pkg-u' }]),
        updateMany: jest.fn().mockImplementation(async (args) => {
          allocationUpdates.push(args);
          return { count: 1 };
        }),
      },
      loadPlan: {
        findFirst: jest.fn().mockResolvedValue({
          geometrySnapshot: {
            demoStackingPolicy: { max_tiers: 3, lift_clearance_cm: 5, owner_mode: 'ANY_CUSTOMER', max_top_load_percent: 30 },
          },
          steps: [
            {
              stepNumber: 1,
              validationResult: {
                placed_items: [
                  { item_id: 'pkg-c', x: 0, y: 0, z: 0 },
                  { item_id: 'pkg-b', x: 10, y: 10, z: 80, support_item_id: 'pkg-c' },
                  { item_id: 'pkg-d', x: 300, y: 100, z: 0 },
                ],
              },
              placements: [
                { packageId: 'pkg-c', xMm: 0, yMm: 0, zMm: 0, effectiveLengthMm: 1500, effectiveWidthMm: 1000, effectiveHeightMm: 800 },
                { packageId: 'pkg-b', xMm: 100, yMm: 100, zMm: 800, effectiveLengthMm: 800, effectiveWidthMm: 800, effectiveHeightMm: 500 },
                { packageId: 'pkg-d', xMm: 3000, yMm: 1000, zMm: 0, effectiveLengthMm: 1000, effectiveWidthMm: 1000, effectiveHeightMm: 800 },
              ],
            },
          ],
        }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord-u',
          status: OrderStatus.ASSIGNED,
          items: [{ packages: [{ id: 'pkg-u', status: PackageStatus.READY, allocations: [] }] }],
        }),
        update: jest.fn().mockImplementation(async (args) => {
          orderUpdates.push(args);
          return {};
        }),
      },
      orderEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
      outboxEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const prisma = {
      $transaction: async <T>(cb: (client: typeof tx) => Promise<T>) => cb(tx),
    };
    const auth = {
      authenticatePayload: jest.fn().mockResolvedValue(driverUser),
    };

    const service = new DriverContinuationService(prisma as never, auth as never);
    const res = await service.reportDeliveryFailure(
      driverUser,
      'asg-1',
      'task-b-deliv',
      'idemp-key-0001',
      {
        expectedVersion: 1,
        expectedTripVersion: 2,
        reason: 'Khách bận đột xuất',
        failureCategory: 'CUSTOMER_BUSY',
      },
    );

    expect(axiosPostSpy).toHaveBeenCalledTimes(1);
    expect(axiosPostSpy.mock.calls[0][0]).toContain('/evaluate-inprogress-trip');
    expect((res as { continuation: unknown }).continuation).toEqual({
      returnWarehouseId: 'wh-dad',
      returnWarehouseName: 'Kho Đà Nẵng',
      keptDeliveryStopIds: ['stop-d'],
      returnToHubStopIds: ['stop-c'],
      detachedOrderIds: ['ord-u'],
      usedExactPlacements: true,
    });
    expect(tripStopUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'stop-c',
          data: { status: 'SKIPPED', skipReason: 'BLOCKED_BY_RETAINED_CARGO' },
        }),
        expect.objectContaining({
          id: 'stop-u-pick',
          data: {
            status: 'SKIPPED',
            skipReason: 'INSUFFICIENT_CAPACITY_WITH_RETAINED_CARGO',
          },
        }),
      ]),
    );
    expect(allocationUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ status: 'RELEASED' }),
        }),
      ]),
    );
    expect(packageUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: { status: PackageStatus.READY } }),
      ]),
    );
    expect(orderUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ data: { status: OrderStatus.CONFIRMED } }),
      ]),
    );
    expect(stopTaskCreates.length).toBe(3);
    expect(packageEvents[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: PackageEventType.DELIVERY_ATTEMPTED }),
      }),
    );
  });

  it('DriverContinuationService confirmReturnToHub blocks while clear deliveries are pending, then returns packages to custody warehouse', async () => {
    const pkgUpdates: Array<unknown> = [];
    const allocUpdates: Array<unknown> = [];
    let tripUpdatedData: unknown;
    let vehicleUpdatedData: unknown;
    let driverUpdatedData: unknown;

    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      driver: {
        findUnique: jest.fn().mockResolvedValue({ id: 'drv-1', homeBranchId: 'branch-dad', status: 'ON_DUTY' }),
        update: jest.fn().mockImplementation(async (args) => {
          driverUpdatedData = args.data;
          return {};
        }),
      },
      driverAssignment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'asg-1',
          driverId: 'drv-1',
          tripId: 'trip-1',
          status: 'ACCEPTED',
          version: 1,
          startStopId: null,
          endStopId: null,
          startTime: new Date('2026-11-25T01:00:00Z'),
          endTime: new Date('2026-11-25T10:00:00Z'),
        }),
      },
      executionEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      trip: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({
            id: 'trip-1',
            managingBranchId: 'branch-dad',
            status: TripStatus.IN_PROGRESS,
            version: 3,
            vehicleId: 'veh-1',
            actualStartTime: new Date('2026-11-25T01:00:00Z'),
            plannedEndTime: new Date('2026-11-25T10:00:00Z'),
            vehicle: { homeBranchId: 'branch-dad' },
          }),
        update: jest.fn().mockImplementation(async (args) => {
          tripUpdatedData = args.data;
          return { status: TripStatus.COMPLETED, version: 4 };
        }),
      },
      tripStop: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'stop-end',
          sequence: 6,
          status: 'PENDING',
          hubLocationId: 'wh-dad',
        }),
        count: jest
          .fn()
          .mockResolvedValueOnce(1) // First attempt: still 1 clear delivery pending
          .mockResolvedValueOnce(0) // Second attempt: 0 clear deliveries pending
          .mockResolvedValueOnce(0), // maybeCompleteTrip check
        update: jest.fn().mockResolvedValue({}),
      },
      location: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wh-dad',
          code: 'WH-DAD-01',
          name: 'Kho Đà Nẵng',
          type: LocationType.CENTRAL_WAREHOUSE,
          managingBranchId: 'branch-dad',
          address: '123 Tôn Đức Thắng',
          latitude: 16.06,
          longitude: 108.15,
          active: true,
        }),
      },
      allocation: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'alloc-b', packageId: 'pkg-b', orderItem: { orderId: 'ord-b' }, package: { id: 'pkg-b', packageCode: 'PKG-B' } },
          { id: 'alloc-c', packageId: 'pkg-c', orderItem: { orderId: 'ord-c' }, package: { id: 'pkg-c', packageCode: 'PKG-C' } },
        ]),
        update: jest.fn().mockImplementation(async (args) => {
          allocUpdates.push(args);
          return {};
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      package: {
        update: jest.fn().mockImplementation(async (args) => {
          pkgUpdates.push(args);
          return {};
        }),
      },
      packageEvent: { create: jest.fn().mockResolvedValue({}) },
      stopTask: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ord-b',
          status: OrderStatus.IN_TRANSIT,
          items: [{ packages: [{ id: 'pkg-b', status: PackageStatus.READY, allocations: [] }] }],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      orderEvent: { create: jest.fn().mockResolvedValue({}) },
      resourceReservation: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      vehicle: {
        update: jest.fn().mockImplementation(async (args) => {
          vehicleUpdatedData = args.data;
          return {};
        }),
      },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };

    const prisma = {
      $transaction: async <T>(cb: (client: typeof tx) => Promise<T>) => cb(tx),
    };
    const auth = { authenticatePayload: jest.fn().mockResolvedValue(driverUser) };
    const service = new DriverContinuationService(prisma as never, auth as never);

    await expect(
      service.confirmReturnToHub(driverUser, 'asg-1', 'stop-end', 'idemp-hub-0001', {
        expectedVersion: 1,
        expectedTripVersion: 3,
      }),
    ).rejects.toThrow(ConflictException);

    const completed = await service.confirmReturnToHub(
      driverUser,
      'asg-1',
      'stop-end',
      'idemp-hub-0002',
      { expectedVersion: 1, expectedTripVersion: 3 },
    );

    expect(completed).toMatchObject({
      stopId: 'stop-end',
      returnedPackageCount: 2,
      tripCompleted: true,
      tripStatus: TripStatus.COMPLETED,
    });
    expect(pkgUpdates).toHaveLength(2);
    expect(pkgUpdates[0]).toMatchObject({
      data: {
        status: PackageStatus.READY,
        custodyLocationId: 'wh-dad',
      },
    });
    expect(allocUpdates).toHaveLength(2);
    expect(allocUpdates[0]).toMatchObject({
      data: expect.objectContaining({ status: 'RETURNED_TO_HUB' }),
    });
    expect(tripUpdatedData).toMatchObject({ status: TripStatus.COMPLETED });
    expect(vehicleUpdatedData).toMatchObject({
      status: 'AVAILABLE',
      currentLatitude: 16.06,
      currentLongitude: 108.15,
    });
    expect(driverUpdatedData).toEqual({ status: 'AVAILABLE' });
  });

  it('Next-day OrdersService & TripsService optimize remaining READY package picking up from custody warehouse', async () => {
    const partialReturnedOrder = {
      id: 'ord-ret-1',
      orderNumber: 'ORD-RET-1',
      orderType: 'B2B_TRANSPORT',
      status: OrderStatus.CONFIRMED,
      packageDataStatus: 'COMPLETE',
      branchId: 'branch-dad',
      customerId: 'cust-1',
      orderedAt: new Date('2026-11-25T02:00:00Z'),
      totalAmount: 1000000,
      totalPackages: 2,
      totalWeightKg: 60,
      totalVolumeM3: 0.6,
      operationalTimezone: 'Asia/Ho_Chi_Minh',
      version: 3,
      branch: { id: 'branch-dad', code: 'BRANCH-DAD', name: 'Đà Nẵng' },
      customer: { id: 'cust-1', code: 'C1', name: 'Khách 1', phone: '0905' },
      charges: [],
      stops: [
        {
          id: 'ord-pick-orig',
          orderId: 'ord-ret-1',
          type: StopType.PICKUP,
          sequence: 1,
          address: 'Điểm lấy gốc của shop',
          latitude: 16.01,
          longitude: 108.11,
          contactName: 'Shop A',
          contactPhone: '0901',
          windowBasis: 'SERVICE_START',
          windowStart: null,
          windowEnd: null,
          serviceDurationMinutes: 15,
        },
        {
          id: 'ord-deliv-1',
          orderId: 'ord-ret-1',
          type: StopType.DELIVERY,
          sequence: 2,
          address: 'Khách Bận',
          latitude: 16.09,
          longitude: 108.22,
          contactName: 'Anh B',
          contactPhone: '0902',
          windowBasis: 'SERVICE_START',
          windowStart: null,
          windowEnd: null,
          serviceDurationMinutes: 15,
        },
      ],
      items: [
        {
          id: 'item-1',
          orderId: 'ord-ret-1',
          description: 'Thiết bị A',
          packageType: 'CARTON',
          quantity: 2,
          packages: [
            {
              id: 'pkg-delivered-1',
              orderItemId: 'item-1',
              packageCode: 'PKG-1',
              status: PackageStatus.DELIVERED,
              lengthMm: 500,
              widthMm: 500,
              heightMm: 500,
              weightG: 30000n,
              custodyLocationId: null,
              custodyLocation: null,
              returnedToHubAt: null,
              deliveryAttemptCount: 1,
              allowedOrientations: null,
              cargoKind: 'STANDARD',
              allowUpperTier: true,
              noTopLoadRequested: false,
              maxTopLoadG: null,
            },
            {
              id: 'pkg-warehouse-2',
              orderItemId: 'item-1',
              packageCode: 'PKG-2',
              status: PackageStatus.READY,
              lengthMm: 500,
              widthMm: 500,
              heightMm: 500,
              weightG: 30000n,
              custodyLocationId: 'wh-dad',
              custodyLocation: {
                id: 'wh-dad',
                code: 'WH-DAD-01',
                name: 'Kho Trung Chuyển Đà Nẵng',
                address: '123 Tôn Đức Thắng',
                latitude: 16.06,
                longitude: 108.15,
              },
              returnedToHubAt: new Date('2026-11-25T11:00:00Z'),
              deliveryAttemptCount: 1,
              allowedOrientations: null,
              cargoKind: 'STANDARD',
              allowUpperTier: true,
              noTopLoadRequested: false,
              maxTopLoadG: null,
            },
          ],
        },
      ],
    };

    const ordersPrisma = {
      order: { findMany: jest.fn().mockResolvedValue([partialReturnedOrder]) },
    };
    const ordersService = new OrdersService(ordersPrisma as never, {} as never);
    const available = await ordersService.getAvailableForDispatch(adminUser, 'branch-dad');
    expect(available).toHaveLength(1);
    expect(ordersPrisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          items: expect.objectContaining({
            none: { allocations: { some: { releasedAt: null } } },
          }),
        }),
      }),
    );

    const tripsService = new TripsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as {
      buildOptimizerOrders: (orders: unknown[], epoch: Date) => Array<{
        id: string;
        items: Array<{ id: string }>;
        pickup_location: { id: string; source_location_id: string; latitude: number; longitude: number; name: string };
      }>;
    };

    const optimizerOrders = tripsService.buildOptimizerOrders(
      [partialReturnedOrder],
      new Date('2026-11-26T00:00:00Z'),
    );
    expect(optimizerOrders).toHaveLength(1);
    expect(optimizerOrders[0].items.map((i) => i.id)).toEqual(['pkg-warehouse-2']);
    expect(optimizerOrders[0].pickup_location).toEqual({
      id: 'hub:wh-dad:ord-ret-1',
      source_location_id: 'ord-pick-orig',
      name: 'Kho Trung Chuyển Đà Nẵng — 123 Tôn Đức Thắng',
      latitude: 16.06,
      longitude: 108.15,
    });
  });
});
