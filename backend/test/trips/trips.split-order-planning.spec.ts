import { BadRequestException } from '@nestjs/common';
import { PackageStatus, StopType } from '@prisma/client';
import { TripsService } from '../../src/trips/trips.service';

describe('TripsService split-order planning', () => {
  const service = new TripsService({} as never, {} as never, {} as never);
  const buildPlannedTrips = (
    proposal: Record<string, unknown>,
    routesOverride?: unknown[],
  ) => {
    if (routesOverride) {
      (proposal.result as { routes: unknown[] }).routes = routesOverride;
    }
    return (
      service as unknown as {
        buildPlannedAutomaticTrips: (
          proposal: unknown,
          orders: unknown[],
          vehicles: unknown[],
          drivers: unknown[],
        ) => Array<{ orderIds: string[]; cargoUnitIds: string[] }>;
      }
    ).buildPlannedAutomaticTrips(proposal, [order], vehicles, drivers);
  };

  const order = {
    id: 'order-large',
    orderNumber: 'DH-LARGE',
    version: 4,
    items: [
      {
        id: 'line-large',
        orderId: 'order-large',
        description: 'Kiện lớn',
        quantity: 2,
        weightKg: 1_200,
        lengthCm: 150,
        widthCm: 80,
        heightCm: 80,
      },
    ],
    stops: [
      {
        id: 'pickup-large',
        type: StopType.PICKUP,
        address: 'Kho',
        latitude: 12,
        longitude: 109,
        contactName: 'Kho',
        contactPhone: '0900000000',
      },
      {
        id: 'delivery-large',
        type: StopType.DELIVERY,
        address: 'Khách',
        latitude: 12.1,
        longitude: 109.1,
        contactName: 'Khách',
        contactPhone: '0911111111',
      },
    ],
  };
  const vehicles = [1, 2].map((index) => ({
    id: `truck-${index}`,
    plateNumber: `79C-00${index}`,
    licenseClass: 'C',
    updatedAt: new Date('2026-10-06T00:00:00Z'),
  }));
  const drivers = [1, 2].map((index) => ({
    id: `driver-${index}`,
    fullName: `Tài xế ${index}`,
    licenseClass: 'C',
    updatedAt: new Date('2026-10-06T00:00:00Z'),
  }));

  const stop = (
    part: number,
    type: 'PICKUP' | 'DELIVERY',
    sequence: number,
  ) => ({
    sequence,
    location_id: `${type === 'PICKUP' ? 'pickup' : 'delivery'}-large::split:${part}`,
    order_stop_id: type === 'PICKUP' ? 'pickup-large' : 'delivery-large',
    location_name: type === 'PICKUP' ? 'Kho' : 'Khách',
    stop_type: type,
    order_id: 'order-large',
    allocation_id: `order-large::split:${part}`,
    latitude: type === 'PICKUP' ? 12 : 12.1,
    longitude: type === 'PICKUP' ? 109 : 109.1,
    arrival_time_sec: sequence * 60,
    departure_time_sec: sequence * 60 + 30,
    items_loaded: type === 'PICKUP' ? [`line-large#${part}`] : [],
    items_unloaded: type === 'DELIVERY' ? [`line-large#${part}`] : [],
    current_weight_kg: type === 'PICKUP' ? 600 : 0,
  });
  const route = (part: number) => ({
    route_id: `truck-${part}::day:0`,
    vehicle_id: `truck-${part}`,
    service_day_index: 0,
    start_time_sec: 0,
    end_time_sec: 300,
    plate_number: `79C-00${part}`,
    vehicle_length_cm: 200,
    vehicle_width_cm: 100,
    driver_id: `driver-${part}`,
    driver_name: `Tài xế ${part}`,
    driver_license_class: 'C',
    total_distance_km: 10,
    total_duration_minutes: 5,
    stops: [stop(part, 'PICKUP', 1), stop(part, 'DELIVERY', 2)],
    spatial_validation: { is_valid: true, step_states: [] },
    cost: { total_cost_vnd: 100_000 },
  });
  const proposal = () => ({
    branchId: 'branch-1',
    planningEpochIso: '2026-10-06T00:00:00.000Z',
    expiresAt: '2026-10-06T01:00:00.000Z',
    resources: {
      orders: [{ id: 'order-large', version: 4 }],
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        updatedAt: vehicle.updatedAt.toISOString(),
      })),
      drivers: drivers.map((driver) => ({
        id: driver.id,
        updatedAt: driver.updatedAt.toISOString(),
      })),
    },
    result: { routes: [route(1), route(2)] },
  });

  it('cho phép cùng một đơn xuất hiện trên nhiều Trip khi mỗi xe nhận kiện khác nhau', () => {
    const planned = buildPlannedTrips(proposal());

    expect(planned).toHaveLength(2);
    expect(planned.every((trip) => trip.orderIds[0] === 'order-large')).toBe(
      true,
    );
    expect(new Set(planned.flatMap((trip) => trip.cargoUnitIds))).toEqual(
      new Set(['line-large#1', 'line-large#2']),
    );
  });

  it('không áp dụng khi mới phân được một phần kiện của đơn', () => {
    expect(() => buildPlannedTrips(proposal(), [route(1)])).toThrow(
      BadRequestException,
    );
  });

  it('không cho một kiện xuất hiện trên hai tuyến', () => {
    const secondRoute = route(2);
    secondRoute.stops[0].items_loaded = ['line-large#1'];
    secondRoute.stops[1].items_unloaded = ['line-large#1'];

    expect(() =>
      buildPlannedTrips(proposal(), [route(1), secondRoute]),
    ).toThrow(/bị phân công vào nhiều tuyến/);
  });

  it('dùng Package vật lý thay vì tách lại theo quantity của OrderItem', () => {
    const buildOptimizerOrders = (
      service as unknown as {
        buildOptimizerOrders: (
          orders: unknown[],
          planningEpoch: Date,
        ) => Array<{ items: Array<{ id: string; weight_kg: number }> }>;
      }
    ).buildOptimizerOrders.bind(service);
    const packedOrder = {
      ...order,
      orderedAt: new Date('2026-10-06T00:00:00Z'),
      totalAmount: { toString: () => '1000000' },
      stops: order.stops.map((orderStop) => ({
        ...orderStop,
        serviceDurationMinutes: 15,
      })),
      packages: [
        {
          id: 'package-one-box',
          packageCode: 'PKG-ONE-BOX',
          lengthMm: 2500,
          widthMm: 1200,
          heightMm: 1300,
          weightG: BigInt(2_400_000),
          status: PackageStatus.READY,
          items: [{ orderItemId: 'line-large' }],
        },
      ],
    };

    const [optimizerOrder] = buildOptimizerOrders(
      [packedOrder],
      new Date('2026-10-06T00:00:00Z'),
    );

    expect(optimizerOrder.items).toEqual([
      expect.objectContaining({
        id: 'package:package-one-box',
        weight_kg: 2400,
      }),
    ]);
  });
});
