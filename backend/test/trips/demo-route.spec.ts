import axios from 'axios';
import { TripsService } from '../../src/trips/trips.service';

jest.mock('axios');

describe('TripsService.runDemoOptimization road geometry', () => {
  const originalToken = process.env.MAPBOX_ACCESS_TOKEN;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalToken === undefined) {
      delete process.env.MAPBOX_ACCESS_TOKEN;
    } else {
      process.env.MAPBOX_ACCESS_TOKEN = originalToken;
    }
  });

  it('enriches demo routes (>25 waypoints included) with Mapbox road geometry and caches duplicate waypoints', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'test-mapbox-token';

    const stops = Array.from({ length: 26 }, (_, idx) => {
      const orderNum = Math.floor(idx / 2) + 1;
      const orderId = `DH${orderNum}`;
      return {
        sequence: idx + 1,
        location_id: `stop-${idx + 1}`,
        location_name: `Điểm ${idx + 1}`,
        stop_type: idx % 2 === 0 ? 'PICKUP' : 'DELIVERY',
        order_id: orderId,
        allocation_id: orderId,
        order_stop_id: `os-${idx + 1}`,
        latitude: 16.05 + idx * 0.002,
        longitude: 108.15 + idx * 0.002,
        arrival_time_sec: 300 * (idx + 1),
        departure_time_sec: 300 * (idx + 1) + 60,
        items_loaded: idx % 2 === 0 ? [`K${idx + 1}`] : [],
        items_unloaded: idx % 2 === 1 ? [`K${idx}`] : [],
        current_weight_kg: 100,
      };
    });

    const buildRoute = () => ({
      route_id: 'truck-3d-01',
      vehicle_id: 'truck-3d-01',
      service_day_index: 0,
      start_time_sec: 0,
      end_time_sec: 10000,
      plate_number: '43C-889.3D',
      vehicle_length_cm: 600,
      vehicle_width_cm: 240,
      vehicle_height_cm: 200,
      driver_id: 'driver-3d-01',
      driver_name: 'Nguyễn Văn Minh',
      total_distance_km: 120,
      total_duration_minutes: 300,
      depot: { id: 'depot', name: 'Kho Hòa Khánh', latitude: 16.0738, longitude: 108.1496 },
      stops,
      spatial_validation: { is_valid: true, step_states: [] },
      cost: {
        base_fuel_cost_vnd: 500000,
        load_fuel_surcharge_vnd: 50000,
        fuel_cost_vnd: 550000,
        cargo_holding_cost_vnd: 0,
        late_delivery_penalty_vnd: 0,
        cargo_distance_ton_km: 100,
        cargo_time_ton_hours: 10,
        vehicle_fixed_cost_vnd: 450000,
        driver_fixed_salary_allocation_vnd: 500000,
        driver_trip_pay_vnd: 500000,
        total_cost_vnd: 2000000,
      },
    });

    (axios.post as jest.Mock).mockResolvedValue({
      data: {
        job_id: 'demo_3d_danang_complex',
        solver_run_count: 1,
        fully_served_candidate_count: 1,
        candidates: [
          {
            rank: 1,
            search_strategy: 'Hybrid',
            solver_objective: 100,
            is_best_found: true,
            result: {
              job_id: 'demo_3d_danang_complex',
              package_contract_version: '1',
              status: 'SUCCESS',
              routes: [buildRoute()],
              unassigned_orders: [],
              total_distance_km: 120,
              total_duration_minutes: 300,
              total_cost_vnd: 2000000,
              diagnostics: [],
            },
          },
          {
            rank: 2,
            search_strategy: 'Alt',
            solver_objective: 120,
            is_best_found: false,
            result: {
              job_id: 'demo_3d_danang_complex',
              package_contract_version: '1',
              status: 'SUCCESS',
              routes: [buildRoute()],
              unassigned_orders: [],
              total_distance_km: 120,
              total_duration_minutes: 300,
              total_cost_vnd: 2100000,
              diagnostics: [],
            },
          },
        ],
      },
    });

    const realRoadGeometry = {
      type: 'LineString',
      coordinates: [
        [108.1496, 16.0738],
        [108.1512, 16.0745],
        [108.201, 16.101],
        [108.1496, 16.0738],
      ],
      waypoint_indices: [0, 1, 2, 3],
    };
    const mockMapbox = {
      getRoute: jest.fn().mockResolvedValue({
        distanceKm: 120,
        durationMinutes: 300,
        geometry: realRoadGeometry,
        waypoints: [],
      }),
    };

    const tripsService = new TripsService(
      {} as never,
      mockMapbox as never,
      {} as never,
      {} as never,
    );

    const response = await tripsService.runDemoOptimization({
      caseId: 'demo_3d_danang_complex',
      demoStackingEnabled: true,
    });

    expect(mockMapbox.getRoute).toHaveBeenCalledTimes(1);
    expect(mockMapbox.getRoute.mock.calls[0][0]).toHaveLength(28);
    expect(response.result.routes[0].route_geometry).toEqual(realRoadGeometry);
    expect(response.candidateResults[2].routes[0].route_geometry).toEqual(realRoadGeometry);
  });

  it('forwards full effectiveSettings (budget, stacking, policy) like production dispatch when demo overrides are omitted', async () => {
    (axios.post as jest.Mock).mockResolvedValue({
      data: {
        job_id: 'demo_3d_danang_complex',
        solver_run_count: 1,
        fully_served_candidate_count: 1,
        candidates: [
          {
            rank: 1,
            search_strategy: 'Hybrid',
            solver_objective: 100,
            is_best_found: true,
            result: {
              job_id: 'demo_3d_danang_complex',
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

    const mockSettingsService = {
      resolveEffectiveSettings: jest.fn().mockResolvedValue({
        scopeType: 'COMPANY',
        branchId: null,
        stacking: {
          enabled: true,
          ownerMode: 'ANY_CUSTOMER',
          maxTiers: 4,
          liftClearanceMm: 65,
          maxTopLoadPercent: 40,
        },
        optimization: {
          defaultSearchBudgetSeconds: 60,
          maxTimeSeconds: 240,
          hybridSeedCount: 2,
          earlyStopPatience: 15,
          unassignedOrderPenaltyVnd: 1_500_000_000,
          maxRoutesPerDay: 3,
          demoAllowOverride: true,
        },
        costPenalty: {
          fuelPricePerLiter: 24_500,
          monthlyWorkingMinutes: 10_560,
          cargoHoldingCostVndPerTonHour: 500,
          workStartTime: '08:00',
          workEndTime: '17:00',
          deliveryGraceDays: 3,
          lateDeliveryPenaltyMode: 'FIXED_PER_DAY',
          lateDeliveryPenaltyValue: 100_000,
        },
      }),
    };

    const tripsService = new TripsService(
      {} as never,
      { getRoute: jest.fn() } as never,
      {} as never,
      {} as never,
      mockSettingsService as never,
    );

    const response = await tripsService.runDemoOptimization({
      caseId: 'demo_3d_danang_complex',
    });

    expect(mockSettingsService.resolveEffectiveSettings).toHaveBeenCalledWith(null);
    const [, sentPayload] = (axios.post as jest.Mock).mock.calls[0];
    expect(sentPayload).toMatchObject({
      case_id: 'demo_3d_danang_complex',
      demo_stacking_enabled: true,
      demo_stacking_owner_mode: 'ANY_CUSTOMER',
      demo_stacking_max_tiers: 4,
      demo_stacking_lift_clearance_cm: 6.5,
      demo_stacking_max_top_load_percent: 40,
      time_budget_seconds: 60,
      max_time_seconds: 240,
      early_stop_patience: 15,
      hybrid_seed_count: 2,
      policy_overrides: {
        fuel_price_per_liter_vnd: 24_500,
        monthly_working_minutes: 10_560,
        cargo_holding_cost_vnd_per_ton_hour: 500,
        unassigned_order_penalty_vnd: 1_500_000_000,
        delivery_grace_days: 3,
        late_delivery_penalty_mode: 'FIXED_PER_DAY',
        late_delivery_penalty_value: 100_000,
        max_routes_per_day: 3,
      },
    });
    expect(response.searchBudgetSeconds).toBe(60);
  });
});
