import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  DriverStatus,
  LateDeliveryPenaltyMode,
  LocationType,
  OrderStatus,
  PackageStatus,
  Role,
  ScopeType,
  StackingOwnerMode,
  StopType,
  TripStatus,
  VehicleStatus,
} from '@prisma/client';
import axios from 'axios';
import { Principal } from '../../src/auth/access';
import { BranchesService } from '../../src/branches/branches.service';
import { SettingsService } from '../../src/settings/settings.service';
import { OptimizationJobsService } from '../../src/trips/optimization-jobs.service';
import { TripsService } from '../../src/trips/trips.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

function makeAdmin(): Principal {
  return {
    id: 'admin-1',
    username: 'admin',
    fullName: 'Quản trị hệ thống',
    sessionId: 'sess-admin',
    role: Role.ADMIN,
    branchId: null,
    grants: [
      {
        role: Role.ADMIN,
        scopeType: 'COMPANY',
        branchId: null,
        permissions: ['settings.read', 'settings.manage', 'branches.manage'],
      },
    ],
  };
}

function makeDispatcher(branchId: string): Principal {
  return {
    id: `disp-${branchId}`,
    username: `dispatcher_${branchId}`,
    fullName: `Điều phối ${branchId}`,
    sessionId: `sess-${branchId}`,
    role: Role.DISPATCHER,
    branchId,
    grants: [
      {
        role: Role.DISPATCHER,
        scopeType: 'BRANCH',
        branchId,
        // Even if .manage accidentally appeared in a raw grant row, access.ts blocks .manage for DISPATCHER
        permissions: ['settings.read', 'trips.plan'],
      },
    ],
  };
}

function makeCompanyRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-11-13T10:00:00.000Z');
  return {
    id: 'setting-company',
    scopeType: ScopeType.COMPANY,
    branchId: null,
    version: 1,
    overrideStacking: false,
    stackingEnabled: false,
    stackingOwnerMode: StackingOwnerMode.SAME_CUSTOMER,
    stackingMaxTiers: 2,
    stackingLiftClearanceMm: 50,
    stackingMaxTopLoadPercent: 30,
    overrideOptimization: false,
    defaultSearchBudgetSeconds: 10,
    maxOptimizationTimeSeconds: 120,
    hybridSeedCount: null,
    dispatchPreparationMinutes: 20,
    unassignedOrderPenaltyVnd: BigInt(1_000_000_000),
    maxRoutesPerDay: null,
    demoAllowOverride: true,
    overrideCostPenalty: false,
    fuelPricePerLiter: 23_500,
    monthlyWorkingMinutes: 10_560,
    cargoHoldingCostVndPerTonHour: 0,
    workStartTime: '08:00',
    workEndTime: '17:00',
    deliveryGraceDays: 2,
    lateDeliveryPenaltyMode: LateDeliveryPenaltyMode.NONE,
    lateDeliveryPenaltyValue: 0,
    updatedById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('SettingsService & TMS DB Policy Integration', () => {
  const admin = makeAdmin();
  const dispatcherB1 = makeDispatcher('branch-1');

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('merges COMPANY defaults and BRANCH overrides, preserving explicit maxRoutesPerDay=null', async () => {
    const companyRow = makeCompanyRow({ version: 3, maxRoutesPerDay: 5, hybridSeedCount: 2 });
    const branchRow = {
      ...makeCompanyRow(),
      id: 'setting-b1',
      scopeType: ScopeType.BRANCH,
      branchId: 'branch-1',
      version: 2,
      overrideStacking: true,
      stackingEnabled: true,
      stackingOwnerMode: StackingOwnerMode.ANY_CUSTOMER,
      stackingMaxTiers: 4,
      stackingLiftClearanceMm: 65,
      stackingMaxTopLoadPercent: 45,
      overrideOptimization: true,
      defaultSearchBudgetSeconds: 15,
      maxOptimizationTimeSeconds: 180,
      hybridSeedCount: 3,
      unassignedOrderPenaltyVnd: BigInt(2_000_000_000),
      maxRoutesPerDay: null,
      demoAllowOverride: false,
    };

    const prisma = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(companyRow),
        findUnique: jest.fn().mockResolvedValue(branchRow),
      },
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'HCM', name: 'TP.HCM' }),
      },
    };

    const service = new SettingsService(prisma as never);
    const effective = await service.resolveEffectiveSettings('branch-1');

    expect(effective.policyVersion).toBe('company:v3|branch:branch-1:v2');
    expect(effective.sources).toEqual({
      stacking: 'BRANCH',
      optimization: 'BRANCH',
      costPenalty: 'COMPANY',
    });
    expect(effective.stacking).toEqual({
      enabled: true,
      ownerMode: StackingOwnerMode.ANY_CUSTOMER,
      maxTiers: 4,
      liftClearanceMm: 65,
      maxTopLoadPercent: 45,
    });
    // Must stay null (unlimited) instead of inheriting 5 from company
    expect(effective.optimization.maxRoutesPerDay).toBeNull();
    expect(effective.optimization.hybridSeedCount).toBe(3);
    expect(effective.optimization.dispatchPreparationMinutes).toBe(20);
    expect(effective.optimization.demoAllowOverride).toBe(false);
    expect(effective.costPenalty.fuelPricePerLiter).toBe(23_500);
  });

  it('enforces RBAC: dispatcher can read company and own branch, blocked on other branch or writes', async () => {
    const companyRow = makeCompanyRow();
    const prisma = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(companyRow),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'HCM', name: 'TP.HCM' }),
      },
      auditLog: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const service = new SettingsService(prisma as never);

    await expect(service.getCompanyScoped(dispatcherB1)).resolves.toMatchObject({
      effective: { scopeType: 'COMPANY' },
    });
    await expect(service.getBranchScoped('branch-1', dispatcherB1)).resolves.toMatchObject({
      effective: { branchId: 'branch-1' },
    });

    await expect(service.getBranchScoped('branch-2', dispatcherB1)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.getEffectiveForUser(dispatcherB1, 'branch-2')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      service.getAuditLogs(dispatcherB1, { branchId: 'branch-2' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.updateCompanySettings({ expectedVersion: 1, stacking: { enabled: true } }, dispatcherB1),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.updateBranchSettings('branch-1', { expectedVersion: 0, overrideStacking: true }, dispatcherB1),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.resetBranchOverrides('branch-1', { expectedVersion: 1 }, dispatcherB1),
    ).rejects.toThrow(ForbiddenException);

    // Dispatcher unfiltered audit logs must be scoped strictly to COMPANY + granted branch
    await service.getAuditLogs(dispatcherB1, {});
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: 'SYSTEM_SETTING',
          entityId: { in: ['COMPANY', 'branch-1'] },
        }),
      }),
    );
  });

  it('throws 409 ConflictException on optimistic lock mismatch or concurrent create P2002', async () => {
    const companyRow = makeCompanyRow({ version: 2 });
    const tx = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(companyRow),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'HCM', name: 'TP.HCM' }),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new SettingsService(prisma as never);

    // Client passes stale version 1 when DB has version 2
    await expect(
      service.updateCompanySettings({ expectedVersion: 1, stacking: { enabled: true } }, admin),
    ).rejects.toThrow(ConflictException);

    // Racing transaction updateMany returns count 0
    await expect(
      service.updateCompanySettings({ expectedVersion: 2, stacking: { enabled: true } }, admin),
    ).rejects.toThrow(ConflictException);

    // Concurrent initial branch row creation hits unique constraint P2002
    await expect(
      service.updateBranchSettings('branch-1', { expectedVersion: 0, overrideStacking: true }, admin),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects invalid cross-field domain invariants with 400 BadRequestException', async () => {
    const companyRow = makeCompanyRow({ version: 1 });
    const tx = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(companyRow),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const service = new SettingsService(prisma as never);

    await expect(
      service.updateCompanySettings(
        {
          expectedVersion: 1,
          optimization: { defaultSearchBudgetSeconds: 90, maxTimeSeconds: 60 },
        },
        admin,
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(service.updateCompanySettings(
      { expectedVersion: 1, optimization: { enforceWeightBalance: true } },
      admin,
    )).rejects.toThrow(BadRequestException);

    await expect(
      service.updateCompanySettings(
        {
          expectedVersion: 1,
          costPenalty: { workStartTime: '18:00', workEndTime: '17:00' },
        },
        admin,
      ),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.updateCompanySettings(
        {
          expectedVersion: 1,
          costPenalty: {
            lateDeliveryPenaltyMode: LateDeliveryPenaltyMode.PERCENT_ORDER_VALUE_PER_DAY,
            lateDeliveryPenaltyValue: 105,
          },
        },
        admin,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('syncs non-overridden branches when COMPANY cost updates and writes AuditLog', async () => {
    const beforeCompany = makeCompanyRow({ version: 1, fuelPricePerLiter: 23_500 });
    const afterCompany = makeCompanyRow({
      version: 2,
      fuelPricePerLiter: 25_000,
      cargoHoldingCostVndPerTonHour: 12_000,
    });

    const tx = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(beforeCompany),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ branchId: 'branch-overridden' }]),
        findUniqueOrThrow: jest.fn().mockResolvedValue(afterCompany),
      },
      branch: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };

    const service = new SettingsService(prisma as never);
    const res = await service.updateCompanySettings(
      {
        expectedVersion: 1,
        costPenalty: { fuelPricePerLiter: 25_000, cargoHoldingCostVndPerTonHour: 12_000 },
      },
      admin,
    );

    expect(res.company.version).toBe(2);
    expect(tx.branch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { notIn: ['branch-overridden'] } },
        data: expect.objectContaining({
          fuelPricePerLiter: 25_000,
          cargoHoldingCostVndPerTonHour: 12_000,
        }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'SYSTEM_SETTING',
          entityId: 'COMPANY',
          action: 'UPDATE_COMPANY_SETTINGS',
        }),
      }),
    );
  });

  it('resets branch cost override back to COMPANY values and updates branches table', async () => {
    const companyRow = makeCompanyRow({ version: 4, fuelPricePerLiter: 22_000 });
    const existingBranchRow = {
      ...makeCompanyRow(),
      id: 'set-b1',
      scopeType: ScopeType.BRANCH,
      branchId: 'branch-1',
      version: 3,
      overrideCostPenalty: true,
      fuelPricePerLiter: 26_000,
    };
    const freshBranchRow = {
      ...existingBranchRow,
      version: 4,
      overrideCostPenalty: false,
      fuelPricePerLiter: null,
    };

    const tx = {
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'HCM', name: 'TP.HCM' }),
        update: jest.fn().mockResolvedValue({ id: 'branch-1' }),
      },
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(companyRow),
        findUnique: jest.fn().mockResolvedValue(existingBranchRow),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(freshBranchRow),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-reset' }),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };

    const service = new SettingsService(prisma as never);
    const result = await service.resetBranchOverrides(
      'branch-1',
      { expectedVersion: 3, groups: ['costPenalty'] },
      admin,
    );

    expect(result.effective.overrides.costPenalty).toBe(false);
    expect(result.effective.costPenalty.fuelPricePerLiter).toBe(22_000);
    expect(tx.branch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'branch-1' },
        data: expect.objectContaining({ fuelPricePerLiter: 22_000 }),
      }),
    );
  });

  it('throws 404 NotFoundException when branchId does not exist', async () => {
    const prisma = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(makeCompanyRow()),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      branch: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new SettingsService(prisma as never);
    await expect(service.resolveEffectiveSettings('missing-branch')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('TripsService reads stacking ANY_CUSTOMER & maxRoutesPerDay from DB even without env vars (NODE_ENV=production)', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevTiers = process.env.TMS_DEMO_STACK_MAX_TIERS;
    process.env.NODE_ENV = 'production';
    delete process.env.TMS_DEMO_STACK_MAX_TIERS;

    try {
      const now = new Date('2026-11-14T01:00:00.000Z');
      const branch = {
        id: 'branch-1',
        code: 'HCM',
        name: 'TP.HCM',
        active: true,
        timezone: 'Asia/Ho_Chi_Minh',
        workStartTime: '08:00',
        workEndTime: '17:00',
        fuelPricePerLiter: 23_500,
        monthlyWorkingMinutes: 10_560,
        cargoHoldingCostVndPerTonHour: 0,
        deliveryGraceDays: 2,
        lateDeliveryPenaltyMode: LateDeliveryPenaltyMode.NONE,
        lateDeliveryPenaltyValue: 0,
      };
      const depot = {
        id: 'depot-1',
        code: 'DEPOT-1',
        name: 'Kho chính',
        type: LocationType.CENTRAL_WAREHOUSE,
        managingBranchId: 'branch-1',
        latitude: 10.75,
        longitude: 106.67,
        active: true,
      };
      const dbCompany = makeCompanyRow({
        version: 5,
        stackingEnabled: true,
        stackingOwnerMode: StackingOwnerMode.ANY_CUSTOMER,
        stackingMaxTiers: 3,
        stackingLiftClearanceMm: 50,
        defaultSearchBudgetSeconds: 18,
        maxOptimizationTimeSeconds: 90,
        unassignedOrderPenaltyVnd: BigInt(1_500_000_000),
        maxRoutesPerDay: 4,
        enforceWeightBalance: true,
        weightBalancePenaltyVndPerPercent: 500,
        maxLateralImbalancePercent: 12,
        maxLongitudinalImbalancePercent: 20,
      });

      const prisma = {
        systemSetting: {
          findFirst: jest.fn().mockResolvedValue(dbCompany),
          findUnique: jest.fn().mockResolvedValue(null),
        },
        branch: {
          findUnique: jest.fn().mockResolvedValue(branch),
          findFirst: jest.fn().mockResolvedValue(branch),
        },
        deliveryCapacityHold: { findMany: jest.fn().mockResolvedValue([]) },
        deliveryPlanningBatch: { findUnique: jest.fn() },
        deliveryAppointment: { findMany: jest.fn().mockResolvedValue([]) },
        resourceReservation: { findMany: jest.fn().mockResolvedValue([]) },
        vehicle: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'veh-1',
              plateNumber: '51A-12345',
              model: 'Van',
              homeBranchId: 'branch-1',
              homeDepotLocationId: depot.id,
              homeDepotLocation: depot,
              homeBranch: branch,
              updatedAt: now,
              lastLocationAt: null,
              vehicleTypeRecord: {
                name: 'Xe van',
                lengthCm: 300,
                widthCm: 170,
                heightCm: 200,
                payloadCapacityKg: 1500,
                fuelConsumptionLitersPer100Km: 10,
                loadFuelSurchargePercentAtFullPayload: 0,
                fixedOperatingCostPerTrip: 100_000,
                updatedAt: now,
              },
            },
          ]),
        },
        driver: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'drv-1',
              fullName: 'Tài xế A',
              licenseClass: 'B2',
              fixedSalaryMonthly: 12_000_000,
              tripBasePay: 100_000,
              perKmPay: 2_000,
              updatedAt: now,
            },
          ]),
        },
        order: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'ord-1',
              orderNumber: 'ORD-001',
              orderType: 'B2B_TRANSPORT',
              status: OrderStatus.CONFIRMED,
              customerId: 'cust-1',
              packageDataStatus: 'COMPLETE',
              cargoKind: 'STANDARD',
              totalAmount: 5_000_000,
              version: 1,
              declaredValueVnd: 5_000_000,
              orderedAt: now,
              updatedAt: now,
              stops: [
                {
                  id: 'stop-p',
                  sequence: 1,
                  type: StopType.PICKUP,
                  address: 'Điểm lấy',
                  latitude: 10.76,
                  longitude: 106.68,
                  windowBasis: 'SERVICE_START',
                  windowStart: new Date('2026-11-15T01:00:00.000Z'),
                  windowEnd: new Date('2026-11-15T05:00:00.000Z'),
                  serviceDurationMinutes: 15,
                },
                {
                  id: 'stop-d',
                  sequence: 2,
                  type: StopType.DELIVERY,
                  address: 'Điểm giao',
                  latitude: 10.79,
                  longitude: 106.7,
                  windowBasis: 'SERVICE_START',
                  windowStart: new Date('2026-11-15T02:00:00.000Z'),
                  windowEnd: new Date('2026-11-15T09:00:00.000Z'),
                  serviceDurationMinutes: 15,
                },
              ],
              items: [
                {
                  id: 'item-1',
                  orderId: 'ord-1',
                  description: 'Hàng thử nghiệm',
                  quantity: 1,
                  lengthCm: 100,
                  widthCm: 80,
                  heightCm: 80,
                  weightKg: 200,
                  packages: [
                    {
                      id: 'pkg-1',
                      orderItemId: 'item-1',
                      packageCode: 'PKG-1',
                      packageSequence: 1,
                      status: PackageStatus.READY,
                      lengthMm: 1000,
                      widthMm: 800,
                      heightMm: 800,
                      weightG: BigInt(200_000),
                      cargoKind: 'STANDARD',
                      allowUpperTier: true,
                      maxTopLoadG: 300_000,
                    },
                  ],
                },
              ],
              packages: [],
            },
          ]),
        },
        optimizationJob: {
          update: jest.fn().mockResolvedValue({ id: 'job-1' }),
        },
      };

      const settingsService = new SettingsService(prisma as never);
      const mapboxService = {
        getRoadMatrix: jest.fn().mockResolvedValue({
          distancesMeters: [
            [0, 1000, 2000],
            [1000, 0, 1500],
            [2000, 1500, 0],
          ],
          durationsSeconds: [
            [0, 180, 300],
            [180, 0, 240],
            [300, 240, 0],
          ],
        }),
      };

      const mockAxiosPost = axios.post as jest.Mock;
      mockAxiosPost.mockRejectedValueOnce(new Error('stop after payload capture'));

      const tripsService = new TripsService(
        prisma as never,
        mapboxService as never,
        {} as never,
        {} as never,
        settingsService,
      );

      await expect(
        tripsService.executeAutomaticOptimization(
          dispatcherB1,
          { branchId: 'branch-1', idempotencyKey: 'idem-1' },
          'job-1',
        ),
      ).rejects.toThrow('stop after payload capture');

      const [, sentPayload] = mockAxiosPost.mock.calls[0];
      expect(sentPayload.demo_stacking).toEqual({
        max_tiers: 3,
        lift_clearance_cm: 5,
        owner_mode: 'ANY_CUSTOMER',
        max_top_load_percent: 30,
      });
      expect(sentPayload.max_time_seconds).toBe(90);
      expect(sentPayload.search_time_seconds).toBe(18);
      expect(sentPayload.policy).toMatchObject({
        max_routes_per_day: 4,
        enforce_weight_balance: true,
        weight_balance_penalty_vnd_per_percent: 500,
        max_lateral_imbalance_percent: 12,
        max_longitudinal_imbalance_percent: 20,
        unassigned_order_penalty_vnd: 1_500_000_000,
      });
      expect(prisma.optimizationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-1' },
          data: expect.objectContaining({
            policyVersion: 'company:v5|branch:branch-1:v0',
          }),
        }),
      );
    } finally {
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
      if (prevTiers !== undefined) process.env.TMS_DEMO_STACK_MAX_TIERS = prevTiers;
    }
  });

  it('TripsService.runDemoOptimization blocks client override when demoAllowOverride=false', async () => {
    const dbCompany = makeCompanyRow({
      stackingEnabled: true,
      stackingOwnerMode: StackingOwnerMode.SAME_CUSTOMER,
      defaultSearchBudgetSeconds: 12,
      maxOptimizationTimeSeconds: 45,
      demoAllowOverride: false,
    });
    const prisma = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(dbCompany),
      },
    };
    const settingsService = new SettingsService(prisma as never);
    const mockAxiosPost = axios.post as jest.Mock;
    mockAxiosPost.mockResolvedValue({
      data: {
        job_id: 'demo-job-1',
        solver_run_count: 1,
        fully_served_candidate_count: 1,
        candidates: [
          {
            rank: 1,
            search_strategy: 'balanced',
            solver_objective: 0,
            is_best_found: true,
            result: {
              job_id: 'demo-job-1',
              package_contract_version: '1',
              status: 'SUCCESS',
              routes: [],
              unassigned_orders: [],
              total_distance_km: 0,
              total_duration_minutes: 0,
              total_cost_vnd: 0,
              diagnostics: [],
            },
          },
        ],
      },
    });

    const tripsService = new TripsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      settingsService,
    );

    await tripsService.runDemoOptimization({
      caseId: 'demo-stacking',
      demoStackingEnabled: false,
      demoStackingOwnerMode: 'ANY_CUSTOMER',
      timeBudgetSeconds: 99,
    });

    const [, demoPayload] = mockAxiosPost.mock.calls[0];
    expect(demoPayload.demo_stacking_enabled).toBe(true);
    expect(demoPayload.demo_stacking_owner_mode).toBe('SAME_CUSTOMER');
    expect(demoPayload.time_budget_seconds).toBe(45);
  });

  it('BranchesService.update syncs late penalty edits into system_settings within transaction', async () => {
    const syncBranchCostOverrideFromBranchUpdate = jest.fn().mockResolvedValue(undefined);
    const updatedBranch = {
      id: 'branch-1',
      deliveryGraceDays: 5,
      lateDeliveryPenaltyMode: LateDeliveryPenaltyMode.FIXED_PER_DAY,
      lateDeliveryPenaltyValue: 150_000,
      fuelPricePerLiter: 23_500,
      monthlyWorkingMinutes: 10_560,
      cargoHoldingCostVndPerTonHour: 0,
      workStartTime: '08:00',
      workEndTime: '17:00',
    };
    const tx = {
      branch: {
        update: jest.fn().mockResolvedValue(updatedBranch),
      },
    };
    const prisma = {
      branch: {
        findUnique: jest.fn().mockResolvedValue(updatedBranch),
      },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };

    const branchesService = new BranchesService(
      prisma as never,
      {} as never,
      { syncBranchCostOverrideFromBranchUpdate } as unknown as SettingsService,
    );

    await branchesService.update(
      'branch-1',
      { deliveryGraceDays: 5, lateDeliveryPenaltyMode: LateDeliveryPenaltyMode.FIXED_PER_DAY },
      admin,
    );

    expect(syncBranchCostOverrideFromBranchUpdate).toHaveBeenCalledWith(
      tx,
      'branch-1',
      updatedBranch,
      admin,
    );
  });

  it('TripsService.publish rejects unpublished LoadPlan when DB stacking policy changed before publishing', async () => {
    const dbCompany = makeCompanyRow({
      stackingEnabled: true,
      stackingOwnerMode: StackingOwnerMode.SAME_CUSTOMER,
      stackingMaxTiers: 2,
      stackingLiftClearanceMm: 50,
    });
    const tx = {
      systemSetting: {
        findFirst: jest.fn().mockResolvedValue(dbCompany),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      branch: {
        findUnique: jest.fn().mockResolvedValue({ id: 'branch-1', code: 'HCM', name: 'TP.HCM' }),
      },
      deliveryAppointment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) },
      deliveryCapacityHold: { findFirst: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'trip-1',
          tripNumber: 'TRIP-1',
          status: TripStatus.PLANNED,
          version: 2,
          managingBranchId: 'branch-1',
          vehicleId: 'vehicle-1',
          plannedStartTime: new Date('2026-11-15T01:00:00.000Z'),
          plannedEndTime: new Date('2026-11-15T03:00:00.000Z'),
          planningSnapshot: {
            orders: [{ id: 'order-1', version: 1 }],
            vehicle: {
              id: 'vehicle-1',
              updatedAt: '2026-11-14T00:00:00.000Z',
              vehicleTypeUpdatedAt: '2026-11-14T00:00:00.000Z',
            },
            driver: { id: 'driver-1', updatedAt: '2026-11-14T00:00:00.000Z' },
          },
          vehicle: {
            id: 'vehicle-1',
            homeBranchId: 'branch-1',
            status: VehicleStatus.AVAILABLE,
            payloadCapacityKg: 1000,
            volumeCapacityM3: 10,
            plateNumber: '51A-00001',
            vehicleTypeRecord: { updatedAt: new Date('2026-11-14T00:00:00.000Z') },
          },
          assignments: [
            {
              id: 'assignment-1',
              role: 'PRIMARY',
              driverId: 'driver-1',
              driver: {
                id: 'driver-1',
                status: DriverStatus.AVAILABLE,
                licenseExpiry: new Date('2027-01-01T00:00:00.000Z'),
              },
            },
          ],
          stops: [{ id: 'stop-1', tasks: [{ id: 'task-1' }] }],
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      driverAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'order-1', version: 1, status: 'ASSIGNED' }]) },
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'vehicle-1',
          status: VehicleStatus.AVAILABLE,
          updatedAt: new Date('2026-11-14T00:00:00.000Z'),
          vehicleTypeRecord: { updatedAt: new Date('2026-11-14T00:00:00.000Z') },
        }),
      },
      driver: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'driver-1',
          status: DriverStatus.AVAILABLE,
          licenseExpiry: new Date('2027-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-11-14T00:00:00.000Z'),
        }),
      },
      resourceReservation: {
        findMany: jest.fn().mockResolvedValue([
          { vehicleId: 'vehicle-1', driverId: null, status: 'HELD' },
          { vehicleId: null, driverId: 'driver-1', status: 'HELD' },
        ]),
      },
      loadPlan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lp-1',
          validationStatus: 'VALID',
          validatorVersion: 'spatial-demo-stacking-v1',
          geometrySnapshot: {
            demoStackingPolicy: {
              max_tiers: 2,
              lift_clearance_cm: 5,
              owner_mode: 'ANY_CUSTOMER',
            },
          },
          steps: [{ stopTaskId: 'task-1', tasks: [{ id: 'task-1' }] }],
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const settingsService = new SettingsService(prisma as never);
    const tripsService = new TripsService(
      prisma as never,
      {} as never,
      { enqueue: jest.fn() } as never,
      {} as never,
      settingsService,
    );

    await expect(
      tripsService.publish(
        'trip-1',
        { expectedVersion: 2 },
        {
          id: 'user-1',
          username: 'dispatcher',
          fullName: 'Dispatcher',
          sessionId: 'session',
          branchId: 'branch-1',
          role: Role.DISPATCHER,
          grants: [
            {
              role: Role.DISPATCHER,
              scopeType: 'BRANCH',
              branchId: 'branch-1',
              permissions: ['trips.read', 'trips.plan', 'trips.publish'],
            },
          ],
        },
      ),
    ).rejects.toThrow(ConflictException);
  });
});
