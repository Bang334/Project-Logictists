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
});
