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
    axiosPost.mockResolvedValueOnce({ data: {
      job_id: 'first-attempt', solver_run_count: 1, fully_served_candidate_count: 0,
      candidates: [], no_plan_status: 'NO_COMPLETE_PLAN',
    } });
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

    const extendedPayload = axiosPost.mock.calls[1][1] as {
      vehicles: Array<{ service_day_index: number }>;
      orders: Array<{ id: string; delivery_window_end_sec: number }>;
    };
    expect(Math.max(...extendedPayload.vehicles.map(vehicle => vehicle.service_day_index))).toBe(13);
    expect(extendedPayload.orders.find(order => order.id === 'order-other')?.delivery_window_end_sec).toBe(14 * 86400);
    expect(extendedPayload.orders.find(order => order.id === 'order-confirmed')?.delivery_window_end_sec).toBe(8 * 3600);
    expect(mapbox.getRoadMatrix).toHaveBeenCalledTimes(1);
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

  it('deduplicates identical Mapbox route geometry requests across candidates in the same batch', async () => {
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
      getRoute: jest.fn().mockResolvedValue({
        distanceKm: 2,
        durationMinutes: 5,
        geometry: {
          type: 'LineString',
          coordinates: [
            [106.67, 10.75],
            [106.7, 10.8],
            [106.67, 10.75],
          ],
          waypoint_indices: [0, 1, 2],
        },
        waypoints: [],
      }),
    };

    const makeRouteResult = (totalCost: number) => ({
      package_contract_version: '1',
      job_id: 'job-dedup-1',
      status: 'SUCCESS',
      routes: [
        {
          route_id: 'vehicle-1::day:0',
          vehicle_id: 'vehicle-1',
          service_day_index: 0,
          start_time_sec: 0,
          end_time_sec: 300,
          plate_number: '51A-00001',
          vehicle_length_cm: 600,
          vehicle_width_cm: 240,
          driver_id: 'driver-1',
          driver_name: 'Tài xế',
          total_distance_km: 2,
          total_duration_minutes: 5,
          stops: [
            {
              sequence: 1,
              location_id: 'pickup-1',
              location_name: 'Kho',
              stop_type: 'PICKUP',
              order_id: 'order-1',
              allocation_id: 'order-1',
              order_stop_id: 'pickup-1',
              latitude: 10.75,
              longitude: 106.67,
              arrival_time_sec: 60,
              departure_time_sec: 120,
              items_loaded: ['package-1'],
              items_unloaded: [],
              current_weight_kg: 100,
            },
            {
              sequence: 2,
              location_id: 'delivery-1',
              location_name: 'Khách hàng',
              stop_type: 'DELIVERY',
              order_id: 'order-1',
              allocation_id: 'order-1',
              order_stop_id: 'delivery-1',
              latitude: 10.8,
              longitude: 106.7,
              arrival_time_sec: 180,
              departure_time_sec: 240,
              items_loaded: [],
              items_unloaded: ['package-1'],
              current_weight_kg: 0,
            },
          ],
          spatial_validation: {
            is_valid: true,
            max_weight_kg: 100,
            max_area_cm2: 8_000,
            step_states: [],
          },
          cost: {
            base_fuel_cost_vnd: 6_000,
            load_fuel_surcharge_vnd: 0,
            fuel_cost_vnd: 6_000,
            cargo_holding_cost_vnd: 0,
            late_delivery_penalty_vnd: 0,
            cargo_distance_ton_km: 0.2,
            cargo_time_ton_hours: 0.01,
            vehicle_fixed_cost_vnd: 100_000,
            driver_fixed_salary_allocation_vnd: 50_000,
            driver_trip_pay_vnd: 104_000,
            total_cost_vnd: totalCost,
          },
        },
      ],
      unassigned_orders: [],
      total_distance_km: 2,
      total_duration_minutes: 5,
      total_cost_vnd: totalCost,
      diagnostics: ['ok'],
    });

    const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
    axiosPost.mockResolvedValueOnce({
      data: {
        job_id: 'job-dedup-1',
        solver_run_count: 2,
        fully_served_candidate_count: 2,
        candidates: [
          {
            rank: 1,
            search_strategy: 'Hybrid ALNS (seed 0)',
            solver_objective: 260_000,
            is_best_found: true,
            result: makeRouteResult(260_000),
          },
          {
            rank: 2,
            search_strategy: 'Packing ILS (seed 0)',
            solver_objective: 265_000,
            is_best_found: false,
            result: makeRouteResult(265_000),
          },
        ],
      },
    });

    const service = new TripsService(
      prisma as never,
      mapbox as never,
      {} as never,
      {} as never,
    );
    const batch = await service.executeAutomaticOptimization(user, {
      idempotencyKey: '7f1fd5fb-1a7c-4d30-9f5c-36eb5c9fd100',
      branchId,
      searchBudgetSeconds: 30,
    });

    if (!batch) {
      throw new Error('Expected optimization candidate batch');
    }
    expect(batch.candidates).toHaveLength(2);
    expect(mapbox.getRoute).toHaveBeenCalledTimes(1);
    const geom1 = batch.candidates[0].proposal.result.routes[0].route_geometry as
      | { coordinates: [number, number][]; waypoint_indices: number[] }
      | undefined;
    const geom2 = batch.candidates[1].proposal.result.routes[0].route_geometry as
      | { coordinates: [number, number][]; waypoint_indices: number[] }
      | undefined;
    if (!geom1 || !geom2) {
      throw new Error('Expected both candidates to receive route geometry');
    }
    expect(geom1).toEqual(geom2);
    expect(geom1).not.toBe(geom2);
    expect(geom1.waypoint_indices).not.toBe(geom2.waypoint_indices);
    geom1.coordinates[0][0] = 0;
    geom1.waypoint_indices[0] = 99;
    expect(geom2.coordinates[0][0]).toBe(106.67);
    expect(geom2.waypoint_indices).toEqual([0, 1, 2]);
  });

  it('reserves dispatchPreparationMinutes and solver overhead for CURRENT_TIME and records earliestDepartureAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-21T02:00:00.000Z')); // 09:00 UTC+7
    try {
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
        name: 'Kho',
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
        orderedAt: new Date('2026-11-21T01:00:00.000Z'),
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
            windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
          },
          {
            id: 'delivery-1',
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
            id: 'item-1',
            orderId: 'order-1',
            description: 'Hàng',
            quantity: 1,
            packages: [
              {
                id: 'pkg-1',
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
        optimizationJob: { update: jest.fn().mockResolvedValue({}) },
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
      const mockSettings = {
        resolveEffectiveSettings: jest.fn().mockResolvedValue({
          policyVersion: 'company:v1',
          stacking: {
            enabled: true,
            ownerMode: 'ANY_CUSTOMER',
            maxTiers: 3,
            liftClearanceMm: 50,
            maxTopLoadPercent: 30,
          },
          optimization: {
            defaultSearchBudgetSeconds: 60,
            maxTimeSeconds: 240,
            hybridSeedCount: 0,
            earlyStopPatience: 0,
            dispatchPreparationMinutes: 20,
            unassignedOrderPenaltyVnd: 1_000_000_000,
            maxRoutesPerDay: null,
            demoAllowOverride: true,
          },
          costPenalty: {
            fuelPricePerLiter: 23_500,
            monthlyWorkingMinutes: 10_560,
            cargoHoldingCostVndPerTonHour: 0,
            workStartTime: '08:00',
            workEndTime: '17:00',
            deliveryGraceDays: 2,
            lateDeliveryPenaltyMode: 'NONE',
            lateDeliveryPenaltyValue: 0,
          },
        }),
      };
      const axiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
      axiosPost.mockRejectedValueOnce(new Error('stop after snapshot update'));
      const service = new TripsService(
        prisma as never,
        mapbox as never,
        {} as never,
        {} as never,
        mockSettings as never,
      );

      await expect(
        service.executeAutomaticOptimization(
          user,
          {
            idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            branchId,
            scheduleMode: 'CURRENT_TIME' as never,
            searchBudgetSeconds: 60,
          },
          'job-prep-1',
        ),
      ).rejects.toThrow('stop after snapshot update');

      // 09:00 + 20m prep + 60s budget + 60s overhead = 09:22:00 UTC+7 = 02:22:00Z
      expect(prisma.optimizationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-prep-1' },
          data: expect.objectContaining({
            requestSnapshot: expect.objectContaining({
              scheduleMode: 'CURRENT_TIME',
              earliestDepartureAt: '2026-11-21T02:22:00.000Z',
            }),
          }),
        }),
      );
      const payload = axiosPost.mock.calls[0][1] as { vehicles: Array<{ available_start_sec: number }> };
      expect(payload.vehicles[0].available_start_sec).toBe(9 * 3600 + 22 * 60);
    } finally {
      jest.useRealTimers();
    }
  });
});
