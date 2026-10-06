import 'dotenv/config';
import { randomUUID } from 'crypto';
import { OrderStatus, PackageStatus, Role } from '@prisma/client';
import { OutboxService } from '../../src/common/services/outbox.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { signOptimizationProposal } from '../../src/trips/optimization-proposal';
import { TripsService } from '../../src/trips/trips.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('Split-order application concurrency (PostgreSQL)', () => {
  let prisma: PrismaService;
  let service: TripsService;
  const suffix = randomUUID();
  const secret = `integration-secret-${suffix}`;
  const ids = {
    branch: randomUUID(),
    customer: randomUUID(),
    order: randomUUID(),
    item: randomUUID(),
    pickup: randomUUID(),
    delivery: randomUUID(),
    packageOne: randomUUID(),
    packageTwo: randomUUID(),
    vehicleOne: randomUUID(),
    vehicleTwo: randomUUID(),
    driverOne: randomUUID(),
    driverTwo: randomUUID(),
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.OPTIMIZATION_PROPOSAL_SECRET = secret;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new TripsService(
      prisma,
      {} as never,
      new OutboxService(prisma),
    );

    await prisma.branch.create({
      data: {
        id: ids.branch,
        code: `IT-SPLIT-${suffix}`,
        name: 'Split order integration test',
        address: 'Integration test only',
        latitude: 12,
        longitude: 109,
      },
    });
    await prisma.customer.create({
      data: {
        id: ids.customer,
        code: `CUS-${suffix}`,
        name: 'Integration customer',
        phone: `it-${suffix}`,
      },
    });
    await prisma.vehicle.createMany({
      data: [ids.vehicleOne, ids.vehicleTwo].map((id, index) => ({
        id,
        plateNumber: `IT-${suffix.slice(0, 6)}-${index + 1}`,
        model: 'Integration truck',
        vehicleType: 'TRUCK',
        homeBranchId: ids.branch,
        payloadCapacityKg: 1000,
        volumeCapacityM3: 20,
        lengthCm: 300,
        widthCm: 200,
        heightCm: 200,
      })),
    });
    await prisma.driver.createMany({
      data: [ids.driverOne, ids.driverTwo].map((id, index) => ({
        id,
        fullName: `Integration driver ${index + 1}`,
        citizenId: `CIT-${suffix}-${index}`,
        phone: `DRV-${suffix}-${index}`,
        licenseNumber: `LIC-${suffix}-${index}`,
        licenseClass: 'C',
        licenseExpiry: new Date('2035-01-01T00:00:00.000Z'),
        homeBranchId: ids.branch,
      })),
    });
    await prisma.order.create({
      data: {
        id: ids.order,
        orderNumber: `ORD-${suffix}`,
        customerId: ids.customer,
        branchId: ids.branch,
        totalPackages: 2,
        totalWeightKg: 1200,
        items: {
          create: {
            id: ids.item,
            description: 'Hai kiện nguyên vẹn',
            quantity: 2,
            weightKg: 1200,
            lengthCm: 150,
            widthCm: 80,
            heightCm: 80,
            volumeM3: 1.92,
          },
        },
        stops: {
          create: [
            {
              id: ids.pickup,
              type: 'PICKUP',
              sequence: 1,
              address: 'Kho integration',
              latitude: 12,
              longitude: 109,
              contactName: 'Kho',
              contactPhone: '0900000000',
            },
            {
              id: ids.delivery,
              type: 'DELIVERY',
              sequence: 2,
              address: 'Khách integration',
              latitude: 12.1,
              longitude: 109.1,
              contactName: 'Khách',
              contactPhone: '0911111111',
            },
          ],
        },
      },
    });
    await prisma.package.createMany({
      data: [ids.packageOne, ids.packageTwo].map((id, index) => ({
        id,
        orderId: ids.order,
        packageCode: `PKG-${suffix}-${index + 1}`,
        lengthMm: 1500,
        widthMm: 800,
        heightMm: 800,
        weightG: BigInt(600_000),
        allowedOrientations: ['DEFAULT'],
        measurementSource: 'INTEGRATION_TEST',
        status: PackageStatus.READY,
      })),
    });
    await prisma.packageItem.createMany({
      data: [ids.packageOne, ids.packageTwo].map((packageId) => ({
        packageId,
        orderItemId: ids.item,
        quantity: 1,
      })),
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const trips = await prisma.trip.findMany({
      where: { managingBranchId: ids.branch },
      select: { id: true },
    });
    const tripIds = trips.map((trip) => trip.id);
    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { in: tripIds } },
    });
    await prisma.loadPlan.deleteMany({ where: { tripId: { in: tripIds } } });
    await prisma.resourceReservation.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await prisma.driverAssignment.deleteMany({
      where: { tripId: { in: tripIds } },
    });
    await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    await prisma.package.deleteMany({ where: { orderId: ids.order } });
    await prisma.order.deleteMany({ where: { id: ids.order } });
    await prisma.driver.deleteMany({ where: { homeBranchId: ids.branch } });
    await prisma.vehicle.deleteMany({ where: { homeBranchId: ids.branch } });
    await prisma.customer.deleteMany({ where: { id: ids.customer } });
    await prisma.branch.deleteMany({ where: { id: ids.branch } });
    await prisma.$disconnect();
    delete process.env.OPTIMIZATION_PROPOSAL_SECRET;
  });

  const cost = {
    base_fuel_cost_vnd: 0,
    load_fuel_surcharge_vnd: 0,
    fuel_cost_vnd: 0,
    cargo_holding_cost_vnd: 0,
    late_delivery_penalty_vnd: 0,
    cargo_distance_ton_km: 0,
    cargo_time_ton_hours: 0,
    vehicle_fixed_cost_vnd: 0,
    driver_fixed_salary_allocation_vnd: 0,
    driver_trip_pay_vnd: 0,
    total_cost_vnd: 0,
  };

  it('atomically assigns every package once when two apply requests race', async () => {
    const [order, vehicles, drivers] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: ids.order } }),
      prisma.vehicle.findMany({
        where: { id: { in: [ids.vehicleOne, ids.vehicleTwo] } },
        orderBy: { id: 'asc' },
      }),
      prisma.driver.findMany({
        where: { id: { in: [ids.driverOne, ids.driverTwo] } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const packageIds = [ids.packageOne, ids.packageTwo];
    const route = (index: number) => {
      const packageItemId = `package:${packageIds[index]}`;
      const pickupStopId = `${ids.pickup}::split:${index + 1}`;
      const deliveryStopId = `${ids.delivery}::split:${index + 1}`;
      const placedItem = {
        item_id: packageItemId,
        order_id: ids.order,
        x: 0,
        y: 0,
        length_cm: 150,
        width_cm: 80,
        height_cm: 80,
        weight_kg: 600,
      };
      return {
        route_id: `route-${index + 1}`,
        vehicle_id: vehicles[index].id,
        service_day_index: 0,
        start_time_sec: 0,
        end_time_sec: 1800,
        plate_number: vehicles[index].plateNumber,
        vehicle_length_cm: vehicles[index].lengthCm,
        vehicle_width_cm: vehicles[index].widthCm,
        driver_id: drivers[index].id,
        driver_name: drivers[index].fullName,
        driver_license_class: drivers[index].licenseClass,
        total_distance_km: 10,
        total_duration_minutes: 30,
        stops: [
          {
            sequence: 1,
            location_id: pickupStopId,
            location_name: 'Kho integration',
            stop_type: 'PICKUP' as const,
            order_id: ids.order,
            allocation_id: `${ids.order}::split:${index + 1}`,
            order_stop_id: ids.pickup,
            latitude: 12,
            longitude: 109,
            arrival_time_sec: 60,
            departure_time_sec: 120,
            items_loaded: [packageItemId],
            items_unloaded: [],
            current_weight_kg: 600,
          },
          {
            sequence: 2,
            location_id: deliveryStopId,
            location_name: 'Khách integration',
            stop_type: 'DELIVERY' as const,
            order_id: ids.order,
            allocation_id: `${ids.order}::split:${index + 1}`,
            order_stop_id: ids.delivery,
            latitude: 12.1,
            longitude: 109.1,
            arrival_time_sec: 1200,
            departure_time_sec: 1260,
            items_loaded: [],
            items_unloaded: [packageItemId],
            current_weight_kg: 0,
          },
        ],
        spatial_validation: {
          is_valid: true,
          max_weight_kg: 600,
          max_area_cm2: 12_000,
          step_states: [
            {
              step_index: 1,
              stop_id: pickupStopId,
              stop_type: 'PICKUP',
              action_description: 'Xếp một kiện',
              placed_items: [placedItem],
              current_weight_kg: 600,
              current_occupied_area_cm2: 12_000,
              floor_area_cm2: 60_000,
              weight_utilization_percent: 60,
              area_utilization_percent: 20,
              is_valid: true,
              package_access_paths: [],
            },
            {
              step_index: 2,
              stop_id: deliveryStopId,
              stop_type: 'DELIVERY',
              action_description: 'Dỡ một kiện',
              placed_items: [],
              current_weight_kg: 0,
              current_occupied_area_cm2: 0,
              floor_area_cm2: 60_000,
              weight_utilization_percent: 0,
              area_utilization_percent: 0,
              is_valid: true,
              package_access_paths: [],
            },
          ],
        },
        cost,
      };
    };
    const routes = [route(0), route(1)];
    const proposal = {
      branchId: ids.branch,
      planningEpochIso: new Date(Date.now() + 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      resources: {
        orders: [{ id: order.id, version: order.version }],
        vehicles: vehicles.map((vehicle) => ({
          id: vehicle.id,
          updatedAt: vehicle.updatedAt.toISOString(),
        })),
        drivers: drivers.map((driver) => ({
          id: driver.id,
          updatedAt: driver.updatedAt.toISOString(),
        })),
      },
      result: {
        job_id: `job-${suffix}`,
        status: 'SUCCESS' as const,
        routes,
        unassigned_orders: [],
        total_distance_km: 20,
        total_duration_minutes: 60,
        total_cost_vnd: 0,
        diagnostics: [],
      },
    };
    const dto = {
      proposal,
      signature: signOptimizationProposal(proposal, secret),
    };
    const user = { id: randomUUID(), role: Role.ADMIN };

    const outcomes = await Promise.allSettled([
      service.applyAutomaticOptimization(dto, user),
      service.applyAutomaticOptimization(dto, user),
    ]);
    if (outcomes.every((outcome) => outcome.status === 'rejected')) {
      throw new Error(
        outcomes
          .map((outcome) =>
            outcome.status === 'rejected'
              ? String(outcome.reason?.message ?? outcome.reason)
              : 'fulfilled',
          )
          .join(' | '),
      );
    }

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await prisma.trip.count({ where: { managingBranchId: ids.branch } })).toBe(2);
    expect(
      await prisma.order.findUniqueOrThrow({ where: { id: ids.order } }),
    ).toMatchObject({ status: OrderStatus.ASSIGNED, version: order.version + 1 });
    expect(
      await prisma.package.count({
        where: { orderId: ids.order, status: PackageStatus.ALLOCATED },
      }),
    ).toBe(2);

    const tasks = await prisma.stopTask.findMany({
      where: { orderId: ids.order },
      include: { tripStop: true },
    });
    expect(tasks).toHaveLength(4);
    for (const packageId of packageIds) {
      expect(
        new Set(
          tasks
            .filter((task) => task.packageId === packageId)
            .map((task) => task.tripStop.tripId),
        ).size,
      ).toBe(1);
    }
  });
});
