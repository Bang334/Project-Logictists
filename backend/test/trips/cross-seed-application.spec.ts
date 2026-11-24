import { PackageStatus, StopType } from '@prisma/client';
import { spawnSync } from 'child_process';
import { resolve } from 'path';
import { TripsService } from '../../src/trips/trips.service';
import {
  assertFleetOptimizationBatchResult,
  assertFleetOptimizationResult,
} from '../../src/trips/optimizer-contract';

describe('Cross-Seed CP-SAT vehicle_profile backend application', () => {
  const service = new TripsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('áp dụng được nghiệm Cross-Seed có đổi sang xe cùng profile qua contract và buildPlannedAutomaticTrips', () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const orders = [
      {
        id: 'order-1',
        orderedAt: new Date('2026-10-05T00:00:00Z'),
        orderNumber: 'DH-001',
        version: 1,
        status: 'CONFIRMED',
        packageDataStatus: 'COMPLETE',
        items: [
          {
            id: 'line-1',
            orderId: 'order-1',
            description: 'Kiện 1',
            quantity: 1,
            packages: [
              {
                id: 'pkg-1',
                orderItemId: 'line-1',
                lengthMm: 1500,
                widthMm: 800,
                heightMm: 800,
                weightG: 600000n,
                status: PackageStatus.READY,
              },
            ],
            weightKg: 600,
            lengthCm: 150,
            widthCm: 80,
            heightCm: 80,
          },
        ],
        stops: [
          {
            id: 'pickup-1',
            type: StopType.PICKUP,
            address: 'Kho',
            latitude: 12,
            longitude: 109,
            contactName: 'Kho',
            contactPhone: '0900000000',
            windowBasis: 'SERVICE_START',
            windowStart: new Date('2026-10-06T00:00:00Z'),
            windowEnd: new Date('2026-10-06T02:00:00Z'),
            serviceDurationMinutes: 1,
          },
          {
            id: 'delivery-1',
            type: StopType.DELIVERY,
            address: 'Khách 1',
            latitude: 12.1,
            longitude: 109.1,
            contactName: 'Khách 1',
            contactPhone: '0911111111',
            windowBasis: 'SERVICE_START',
            windowStart: new Date('2026-10-06T00:00:00Z'),
            windowEnd: new Date('2026-10-06T02:00:00Z'),
            serviceDurationMinutes: 1,
          },
        ],
      },
      {
        id: 'order-2',
        orderedAt: new Date('2026-10-05T00:00:00Z'),
        orderNumber: 'DH-002',
        version: 2,
        status: 'CONFIRMED',
        packageDataStatus: 'COMPLETE',
        items: [
          {
            id: 'line-2',
            orderId: 'order-2',
            description: 'Kiện 2',
            quantity: 1,
            packages: [
              {
                id: 'pkg-2',
                orderItemId: 'line-2',
                lengthMm: 1000,
                widthMm: 800,
                heightMm: 800,
                weightG: 300000n,
                status: PackageStatus.READY,
              },
            ],
            weightKg: 300,
            lengthCm: 100,
            widthCm: 80,
            heightCm: 80,
          },
        ],
        stops: [
          {
            id: 'pickup-2',
            type: StopType.PICKUP,
            address: 'Kho',
            latitude: 12,
            longitude: 109,
            contactName: 'Kho',
            contactPhone: '0900000000',
            windowBasis: 'SERVICE_START',
            windowStart: new Date('2026-10-06T00:00:00Z'),
            windowEnd: new Date('2026-10-06T02:00:00Z'),
            serviceDurationMinutes: 1,
          },
          {
            id: 'delivery-2',
            type: StopType.DELIVERY,
            address: 'Khách 2',
            latitude: 12.12,
            longitude: 109.12,
            contactName: 'Khách 2',
            contactPhone: '0922222222',
            windowBasis: 'SERVICE_START',
            windowStart: new Date('2026-10-06T00:00:00Z'),
            windowEnd: new Date('2026-10-06T02:00:00Z'),
            serviceDurationMinutes: 1,
          },
        ],
      },
    ];

    const vehicles = [1, 2].map((index) => ({
      id: `truck-${index}`,
      plateNumber: `79C-00${index}`,
      status: 'AVAILABLE',
      licenseClass: 'C',
      updatedAt: now,
      vehicleTypeRecord: { updatedAt: now },
    }));
    const drivers = [1, 2].map((index) => ({
      id: `driver-${index}`,
      fullName: `Tài xế ${index}`,
      status: 'AVAILABLE',
      licenseClass: 'C',
      licenseExpiry: new Date('2035-01-01T00:00:00Z'),
      updatedAt: now,
    }));

    const pythonScript = `
import json
from app.cross_seed_partitioning import solve_cross_seed_set_partitioning
from app.models import (
    CargoItem, CostPolicy, DriverOption, FleetOptimizationBatchResponse,
    FleetOptimizationCandidate, FleetOptimizationRequest, FleetOptimizationResponse,
    FleetVehicle, FloorState, LocationPoint, OptimizedRoute, OrderPair,
    PlacedItem, RouteCostBreakdown, ScheduledStop, SpatialValidationResult,
)

depot = LocationPoint(id="depot:1", name="Kho", latitude=12.0, longitude=109.0)
v1 = FleetVehicle(
    id="truck-1::day:0", source_vehicle_id="truck-1", service_day_index=0, plate_number="79C-001",
    length_cm=400, width_cm=200, height_cm=200, payload_limit_kg=5000,
    available_start_sec=0, available_end_sec=86400, depot=depot,
    fuel_consumption_liters_per_100_km=12.0, fixed_operating_cost_vnd=100_000,
)
v2 = v1.model_copy(update={"id": "truck-2::day:0", "source_vehicle_id": "truck-2", "plate_number": "79C-002"})
d1 = DriverOption(id="driver-1::day:0", source_driver_id="driver-1", service_day_index=0, full_name="Tài xế 1", license_class="C", fixed_salary_monthly_vnd=15_000_000, trip_base_pay_vnd=0, per_km_pay_vnd=0)
d2 = DriverOption(id="driver-2::day:0", source_driver_id="driver-2", service_day_index=0, full_name="Tài xế 2", license_class="C", fixed_salary_monthly_vnd=15_000_000, trip_base_pay_vnd=0, per_km_pay_vnd=0)
o1 = OrderPair(
    id="order-1", order_number="DH-001",
    pickup_location=LocationPoint(id="pickup-1", name="Kho", latitude=12.0, longitude=109.0),
    delivery_location=LocationPoint(id="delivery-1", name="Khách 1", latitude=12.1, longitude=109.1),
    items=[CargoItem(id="pkg-1", order_id="order-1", length_cm=150, width_cm=80, height_cm=80, weight_kg=600)],
)
o2 = OrderPair(
    id="order-2", order_number="DH-002",
    pickup_location=LocationPoint(id="pickup-2", name="Kho", latitude=12.0, longitude=109.0),
    delivery_location=LocationPoint(id="delivery-2", name="Khách 2", latitude=12.12, longitude=109.12),
    items=[CargoItem(id="pkg-2", order_id="order-2", length_cm=100, width_cm=80, height_cm=80, weight_kg=300)],
)
req = FleetOptimizationRequest(
    job_id="backend-apply-check",
    vehicles=[v1, v2], drivers=[d1, d2], orders=[o1, o2],
    policy=CostPolicy(fuel_price_per_liter_vnd=24_000, monthly_working_minutes=12_480),
    distance_matrix_meters=[[0 if a == b else 5000 for b in range(6)] for a in range(6)],
    duration_matrix_seconds=[[0 if a == b else 60 for b in range(6)] for a in range(6)],
)
def mk_route(v, ord_obj, item_id, cost):
    return OptimizedRoute(
        route_id=v.id, vehicle_id=v.source_vehicle_id, service_day_index=0,
        start_time_sec=0, end_time_sec=300, plate_number=v.plate_number,
        vehicle_length_cm=v.length_cm, vehicle_width_cm=v.width_cm, vehicle_height_cm=v.height_cm,
        total_distance_km=10.0, total_duration_minutes=5.0, return_travel_time_sec=60, return_waiting_time_sec=0,
        depot=v.depot,
        stops=[
            ScheduledStop(sequence=1, location_id=ord_obj.pickup_location.id, order_stop_id=ord_obj.pickup_location.id, location_name="Kho", stop_type="PICKUP", order_id=ord_obj.id, allocation_id=ord_obj.id, latitude=12.0, longitude=109.0, arrival_time_sec=60, departure_time_sec=120, travel_time_sec=60, waiting_time_sec=0, service_time_sec=60, items_loaded=[item_id], items_unloaded=[], current_weight_kg=ord_obj.items[0].weight_kg),
            ScheduledStop(sequence=2, location_id=ord_obj.delivery_location.id, order_stop_id=ord_obj.delivery_location.id, location_name="Khách", stop_type="DELIVERY", order_id=ord_obj.id, allocation_id=ord_obj.id, latitude=12.1, longitude=109.1, arrival_time_sec=180, departure_time_sec=240, travel_time_sec=60, waiting_time_sec=0, service_time_sec=60, items_loaded=[], items_unloaded=[item_id], current_weight_kg=0.0),
        ],
        spatial_validation=SpatialValidationResult(
            is_valid=True, max_weight_kg=ord_obj.items[0].weight_kg, max_area_cm2=12000.0,
            step_states=[
                FloorState(step_index=1, stop_id=ord_obj.pickup_location.id, stop_type="PICKUP", action_description="load", placed_items=[PlacedItem(item_id=item_id, order_id=ord_obj.id, x=0, y=0, z=0, length_cm=ord_obj.items[0].length_cm, width_cm=ord_obj.items[0].width_cm, height_cm=ord_obj.items[0].height_cm, weight_kg=ord_obj.items[0].weight_kg)], current_weight_kg=ord_obj.items[0].weight_kg, current_occupied_area_cm2=8000.0, floor_area_cm2=80000.0, weight_utilization_percent=10.0, area_utilization_percent=10.0, is_valid=True),
                FloorState(step_index=2, stop_id=ord_obj.delivery_location.id, stop_type="DELIVERY", action_description="unload", placed_items=[], current_weight_kg=0.0, current_occupied_area_cm2=0.0, floor_area_cm2=80000.0, weight_utilization_percent=0.0, area_utilization_percent=0.0, is_valid=True),
            ],
        ),
        cost=RouteCostBreakdown(base_fuel_cost_vnd=cost-100_000, load_fuel_surcharge_vnd=0, fuel_cost_vnd=cost-100_000, cargo_holding_cost_vnd=0, late_delivery_penalty_vnd=0, cargo_distance_ton_km=1.0, cargo_time_ton_hours=0.1, vehicle_fixed_cost_vnd=0, driver_fixed_salary_allocation_vnd=100_000, driver_trip_pay_vnd=0, total_cost_vnd=cost),
    )

# Both seeds put their cheap 300k route on truck-1; Cross-Seed must remap one onto truck-2.
p0 = FleetOptimizationResponse(job_id="backend-apply-check", status="SUCCESS", routes=[mk_route(v1, o1, "pkg-1", 300_000), mk_route(v2, o2, "pkg-2", 750_000)])
p1 = FleetOptimizationResponse(job_id="backend-apply-check", status="SUCCESS", routes=[mk_route(v2, o1, "pkg-1", 720_000), mk_route(v1, o2, "pkg-2", 300_000)])
combined, obj = solve_cross_seed_set_partitioning(
    req, [p0, p1], {"order-1": {"pkg-1"}, "order-2": {"pkg-2"}},
    compare_horizons=False, allow_vehicle_profile_reassignment=True,
)
batch = FleetOptimizationBatchResponse(
    job_id="backend-apply-check",
    solver_run_count=2,
    fully_served_candidate_count=1,
    candidates=[FleetOptimizationCandidate(rank=1, search_strategy="Packing-aware Cross-Seed CP-SAT", solver_objective=obj.selection_score_vnd, is_best_found=True, result=combined)],
    diagnostics=combined.diagnostics,
)
print(batch.model_dump_json())
`;

    const run = spawnSync(
      resolve(__dirname, '../../../optimizer/.venv/Scripts/python.exe'),
      ['-X', 'utf8', '-c', pythonScript],
      {
        cwd: resolve(__dirname, '../../../optimizer'),
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    expect(run.status).toBe(0);
    const batch = JSON.parse(run.stdout);
    assertFleetOptimizationBatchResult(batch);

    const result = batch.candidates[0].result;
    assertFleetOptimizationResult(result);

    const snapshotVehicleIds = new Set(['truck-1::day:0', 'truck-2::day:0']);
    for (const r of result.routes) {
      expect(snapshotVehicleIds.has(r.route_id)).toBe(true);
    }
    expect(new Set(result.routes.map((r) => r.route_id))).toEqual(
      snapshotVehicleIds,
    );
    expect(new Set(result.routes.map((r) => r.vehicle_id))).toEqual(
      new Set(['truck-1', 'truck-2']),
    );
    expect(new Set(result.routes.map((r) => r.driver_id))).toEqual(
      new Set(['driver-1', 'driver-2']),
    );

    const proposal = {
      branchId: 'branch-1',
      planningEpochIso: '2026-10-06T00:00:00.000Z',
      expiresAt: '2026-10-06T03:00:00.000Z',
      resources: {
        orders: orders.map((order) => ({ id: order.id, version: order.version })),
        vehicles: vehicles.map((vehicle) => ({
          id: vehicle.id,
          updatedAt: vehicle.updatedAt.toISOString(),
          vehicleTypeUpdatedAt: vehicle.vehicleTypeRecord.updatedAt.toISOString(),
        })),
        drivers: drivers.map((driver) => ({
          id: driver.id,
          updatedAt: driver.updatedAt.toISOString(),
        })),
      },
      result,
    };

    const internals = service as unknown as {
      assertProposalResourcesCurrent: (
        p: unknown,
        o: unknown[],
        v: unknown[],
        d: unknown[],
      ) => void;
      buildPlannedAutomaticTrips: (
        p: unknown,
        o: unknown[],
        v: unknown[],
        d: unknown[],
      ) => Array<{
        vehicleId: string;
        driverId: string;
        orderIds: string[];
        cargoUnitIds: string[];
      }>;
    };

    expect(() =>
      internals.assertProposalResourcesCurrent(proposal, orders, vehicles, drivers),
    ).not.toThrow();

    const planned = internals.buildPlannedAutomaticTrips(
      proposal,
      orders,
      vehicles,
      drivers,
    );
    expect(planned).toHaveLength(2);
    expect(new Set(planned.map((t) => t.vehicleId))).toEqual(
      new Set(['truck-1', 'truck-2']),
    );
    expect(new Set(planned.map((t) => t.driverId))).toEqual(
      new Set(['driver-1', 'driver-2']),
    );
    expect(new Set(planned.flatMap((t) => t.cargoUnitIds))).toEqual(
      new Set(['pkg-1', 'pkg-2']),
    );
  });
});
