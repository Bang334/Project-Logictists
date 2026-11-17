import { LocationType, OrderStatus, PackageStatus, Role, StopType } from '@prisma/client';
import axios from 'axios';
import { Principal } from '../../src/auth/access';
import { TripsService } from '../../src/trips/trips.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

describe('TripsService automatic optimization search budget', () => {
  const branchId = 'branch-1';
  const now = new Date('2026-10-11T01:00:00.000Z');
  const user: Principal = {
    id: 'user-1',
    username: 'dispatcher',
    fullName: 'Dispatcher',
    sessionId: 'session-1',
    role: Role.DISPATCHER,
    branchId,
    grants: [
      {
        role: Role.DISPATCHER,
        scopeType: 'BRANCH',
        branchId,
        permissions: ['trips.plan'],
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards the UI search budget to the FastAPI fleet candidate request', async () => {
    const branch = {
      id: branchId,
      active: true,
      timezone: 'Asia/Ho_Chi_Minh',
      workStartTime: '08:00',
      workEndTime: '17:00',
      fuelPricePerLiter: 25_000,
      monthlyWorkingMinutes: 10_560,
      cargoHoldingCostVndPerTonHour: 0,
      deliveryGraceDays: 0,
      lateDeliveryPenaltyMode: 'NONE',
      lateDeliveryPenaltyValue: 0,
    };
    const depot = {
      id: 'depot-1',
      code: 'DEPOT-1',
      name: 'Kho trung tâm',
      type: LocationType.CENTRAL_WAREHOUSE,
      managingBranchId: branchId,
      latitude: 10.75,
      longitude: 106.67,
      active: true,
    };
    const vehicle = {
      id: 'vehicle-1',
      plateNumber: '51A-00001',
      model: 'Truck',
      homeBranchId: branchId,
      homeDepotLocationId: depot.id,
      homeDepotLocation: depot,
      homeBranch: branch,
      updatedAt: now,
      lastLocationAt: null,
      vehicleTypeRecord: {
        name: 'Xe tải',
        lengthCm: 600,
        widthCm: 240,
        heightCm: 240,
        payloadCapacityKg: 5_000,
        fuelConsumptionLitersPer100Km: 12,
        loadFuelSurchargePercentAtFullPayload: 0,
        fixedOperatingCostPerTrip: 100_000,
        updatedAt: now,
      },
    };
    const driver = {
      id: 'driver-1',
      fullName: 'Tài xế',
      licenseClass: 'C',
      fixedSalaryMonthly: 10_000_000,
      tripBasePay: 100_000,
      perKmPay: 2_000,
      updatedAt: now,
    };
    const order = {
      id: 'order-1',
      orderNumber: 'ORD-1',
      orderType: 'B2B_TRANSPORT',
      status: OrderStatus.CONFIRMED,
      packageDataStatus: 'COMPLETE',
      orderedAt: new Date('2026-10-11T00:00:00.000Z'),
      totalAmount: 1_000_000,
      version: 1,
      stops: [
        {
          id: 'pickup-1',
          type: StopType.PICKUP,
          sequence: 1,
          address: 'Kho',
          latitude: 10.75,
          longitude: 106.67,
          windowBasis: 'SERVICE_START',
          windowStart: new Date('2026-10-11T01:00:00.000Z'),
          windowEnd: new Date('2026-10-11T03:00:00.000Z'),
          serviceDurationMinutes: 15,
        },
        {
          id: 'delivery-1',
          type: StopType.DELIVERY,
          sequence: 2,
          address: 'Khách hàng',
          latitude: 10.8,
          longitude: 106.7,
          windowBasis: 'SERVICE_START',
          windowStart: new Date('2026-10-11T02:00:00.000Z'),
          windowEnd: new Date('2026-10-11T06:00:00.000Z'),
          serviceDurationMinutes: 15,
        },
      ],
      items: [
        {
          id: 'item-1',
          orderId: 'order-1',
          description: 'Hàng thử nghiệm',
          quantity: 1,
          packages: [
            {
              id: 'package-1',
              orderItemId: 'item-1',
              status: PackageStatus.READY,
              lengthMm: 1_000,
              widthMm: 800,
              heightMm: 800,
              weightG: 100_000n,
            },
          ],
        },
      ],
    };
    const prisma = {
      deliveryAppointment: { findMany: jest.fn().mockResolvedValue([]) },
      deliveryCapacityHold: { findMany: jest.fn().mockResolvedValue([]) },
      resourceReservation: { findMany: jest.fn().mockResolvedValue([]) },
      branch: { findFirst: jest.fn().mockResolvedValue(branch) },
      vehicle: { findMany: jest.fn().mockResolvedValue([vehicle]) },
      driver: { findMany: jest.fn().mockResolvedValue([driver]) },
      order: { findMany: jest.fn().mockResolvedValue([order]) },
    };
    const mapbox = {
      getRoadMatrix: jest.fn().mockResolvedValue({
        distancesMeters: [
          [0, 1_000, 2_000],
          [1_000, 0, 1_000],
          [2_000, 1_000, 0],
        ],
        durationsSeconds: [
          [0, 60, 120],
          [60, 0, 60],
          [120, 60, 0],
        ],
      }),
    };
    const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
    axiosPost.mockRejectedValueOnce(new Error('stop after payload capture'));
    const service = new TripsService(
      prisma as never,
      mapbox as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.executeAutomaticOptimization(user, {
        idempotencyKey: '5c65ab86-32fc-4289-88d7-26ce1057584f',
        branchId,
        searchBudgetSeconds: 30,
      }),
    ).rejects.toThrow('stop after payload capture');

    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(axiosPost.mock.calls[0][1]).toMatchObject({
      max_time_seconds: 120,
      search_time_seconds: 30,
    });
  });

  it('replanWithFleet keeps confirmed 6-8h windows locked while applying 11-14h requested windows across all vehicles and other orders', async () => {
    const planningEpoch = new Date('2031-01-02T17:00:00.000Z'); // 00:00 ngày 03/01/2031 (UTC+7)
    const branch = {
      id: branchId,
      active: true,
      timezone: 'Asia/Ho_Chi_Minh',
      workStartTime: '06:00',
      workEndTime: '18:00',
      fuelPricePerLiter: 25_000,
      monthlyWorkingMinutes: 10_560,
      cargoHoldingCostVndPerTonHour: 0,
      deliveryGraceDays: 2,
      lateDeliveryPenaltyMode: 'NONE',
      lateDeliveryPenaltyValue: 0,
    };
    const depot = {
      id: 'depot-1',
      code: 'DEPOT-1',
      name: 'Kho trung tâm',
      type: LocationType.CENTRAL_WAREHOUSE,
      managingBranchId: branchId,
      latitude: 10.75,
      longitude: 106.67,
      active: true,
    };
    const makeVehicle = (id: string, plateNumber: string) => ({
      id,
      plateNumber,
      model: 'Truck',
      homeBranchId: branchId,
      homeDepotLocationId: depot.id,
      homeDepotLocation: depot,
      homeBranch: branch,
      updatedAt: now,
      lastLocationAt: null,
      vehicleTypeRecord: {
        name: 'Xe tải',
        lengthCm: 600,
        widthCm: 240,
        heightCm: 240,
        payloadCapacityKg: 5_000,
        fuelConsumptionLitersPer100Km: 12,
        loadFuelSurchargePercentAtFullPayload: 0,
        fixedOperatingCostPerTrip: 100_000,
        updatedAt: now,
      },
    });
    const makeDriver = (id: string, fullName: string) => ({
      id,
      fullName,
      licenseClass: 'C',
      fixedSalaryMonthly: 10_000_000,
      tripBasePay: 100_000,
      perKmPay: 2_000,
      updatedAt: now,
    });
    const makeOrder = (id: string, orderNumber: string) => ({
      id,
      orderNumber,
      customerId: `cust-${id}`,
      orderType: 'B2B_TRANSPORT',
      status: OrderStatus.CONFIRMED,
      packageDataStatus: 'COMPLETE',
      orderedAt: new Date('2031-01-01T00:00:00.000Z'),
      totalAmount: 1_000_000,
      version: 1,
      stops: [
        {
          id: `pickup-${id}`,
          type: StopType.PICKUP,
          sequence: 1,
          address: 'Kho',
          latitude: 10.75,
          longitude: 106.67,
          windowBasis: 'SERVICE_START',
          windowStart: null,
          windowEnd: null,
          serviceDurationMinutes: 15,
        },
        {
          id: `delivery-${id}`,
          type: StopType.DELIVERY,
          sequence: 2,
          address: 'Khách',
          latitude: 10.8,
          longitude: 106.7,
          windowBasis: 'SERVICE_START',
          windowStart: null,
          windowEnd: null,
          serviceDurationMinutes: 15,
        },
      ],
      items: [
        {
          id: `item-${id}`,
          orderId: id,
          description: 'Hàng',
          quantity: 1,
          packages: [
            {
              id: `pkg-${id}`,
              orderItemId: `item-${id}`,
              status: PackageStatus.READY,
              lengthMm: 1_000,
              widthMm: 800,
              heightMm: 800,
              weightG: 100_000n,
            },
          ],
        },
      ],
    });

    const orders = [
      makeOrder('order-confirmed', 'ORD-6-8H'),
      makeOrder('order-changed', 'ORD-11-14H'),
      makeOrder('order-other', 'ORD-OTHER'),
    ];
    const vehicles = [makeVehicle('veh-1', '51A-00001'), makeVehicle('veh-2', '51A-00002')];
    const drivers = [makeDriver('drv-1', 'Tài xế 1'), makeDriver('drv-2', 'Tài xế 2')];

    const prisma = {
      deliveryPlanningBatch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'batch-1',
          branchId,
          status: 'OFFERING',
          proposal: {
            branchId,
            planningEpochIso: planningEpoch.toISOString(),
            scheduleMode: 'NEXT_DAY',
            expiresAt: '2031-01-03T12:00:00.000Z',
            resources: {
              orders: [{ id: 'order-confirmed', version: 1 }],
              vehicles: [{ id: 'veh-1', updatedAt: now.toISOString(), vehicleTypeUpdatedAt: now.toISOString() }],
              drivers: [{ id: 'drv-1', updatedAt: now.toISOString() }],
            },
            result: {
              job_id: 'job-1',
              status: 'SUCCESS',
              package_contract_version: '1',
              total_distance_km: 10,
              total_duration_minutes: 30,
              total_cost_vnd: 100000,
              unassigned_orders: [],
              diagnostics: [],
              routes: [],
            },
          },
          appointments: [
            {
              id: 'app-1',
              orderId: 'order-confirmed',
              status: 'CONFIRMED',
              windowStart: new Date('2031-01-02T23:00:00.000Z'), // 06:00 (21600s)
              windowEnd: new Date('2031-01-03T01:00:00.000Z'),   // 08:00 (28800s)
            },
            {
              id: 'app-2',
              orderId: 'order-changed',
              status: 'CHANGE_REQUESTED',
              windowStart: new Date('2031-01-02T23:00:00.000Z'),
              windowEnd: new Date('2031-01-03T01:00:00.000Z'),
              requestedStart: new Date('2031-01-03T04:00:00.000Z'), // 11:00 (39600s)
              requestedEnd: new Date('2031-01-03T07:00:00.000Z'),   // 14:00 (50400s)
            },
          ],
        }),
      },
      deliveryAppointment: { findMany: jest.fn().mockResolvedValue([]) },
      deliveryCapacityHold: { findMany: jest.fn().mockResolvedValue([]) },
      resourceReservation: { findMany: jest.fn().mockResolvedValue([]) },
      branch: { findFirst: jest.fn().mockResolvedValue(branch) },
      vehicle: { findMany: jest.fn().mockResolvedValue(vehicles) },
      driver: { findMany: jest.fn().mockResolvedValue(drivers) },
      order: { findMany: jest.fn().mockResolvedValue(orders) },
    };
    const size = 1 + orders.length * 2;
    const mapbox = {
      getRoadMatrix: jest.fn().mockResolvedValue({
        distancesMeters: Array.from({ length: size }, () => Array(size).fill(1_000)),
        durationsSeconds: Array.from({ length: size }, () => Array(size).fill(60)),
      }),
    };
    const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
    axiosPost.mockRejectedValueOnce(new Error('stop after payload capture'));
    const service = new TripsService(
      prisma as never,
      mapbox as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.executeAutomaticOptimization(user, {
        idempotencyKey: '5c65ab86-32fc-4289-88d7-26ce1057584f',
        branchId,
        deliveryBatchId: 'batch-1',
        replanWithFleet: true,
      }),
    ).rejects.toThrow('stop after payload capture');

    const sentPayload = axiosPost.mock.calls[0][1] as {
      vehicles: Array<{ source_vehicle_id: string }>;
      orders: Array<{ id: string; delivery_window_start_sec: number; delivery_window_end_sec: number }>;
    };
    expect(new Set(sentPayload.vehicles.map((v) => v.source_vehicle_id))).toEqual(
      new Set(['veh-1', 'veh-2']),
    );
    expect(sentPayload.orders.map((o) => ({
      id: o.id,
      start: o.delivery_window_start_sec,
      end: o.delivery_window_end_sec,
    }))).toEqual([
      { id: 'order-confirmed', start: 6 * 3600, end: 8 * 3600 },
      { id: 'order-changed', start: 11 * 3600, end: 14 * 3600 },
      { id: 'order-other', start: 0, end: 604800 },
    ]);
  });
});
