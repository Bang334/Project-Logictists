import { NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma, TripStatus } from '@prisma/client';
import { CustomerOrderTrackingService } from '../../src/orders/customer-order-tracking.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('M3.6D.1 CustomerOrderTrackingService', () => {
  const prisma = {
    customer: { findUnique: jest.fn() },
    order: { findFirst: jest.fn() },
    trip: { findMany: jest.fn() },
  };
  const service = new CustomerOrderTrackingService(
    prisma as unknown as PrismaService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    prisma.customer.findUnique.mockResolvedValue({ id: 'customer-1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.IN_TRANSIT,
    });
    prisma.trip.findMany.mockResolvedValue([]);
  });

  it('trả NOT_ASSIGNED và trips rỗng khi Order chưa có Trip', async () => {
    await expect(
      service.findForUser('user-1', 'order-1'),
    ).resolves.toEqual({
      orderId: 'order-1',
      orderStatus: OrderStatus.IN_TRANSIT,
      trackingStatus: 'NOT_ASSIGNED',
      trips: [],
    });
  });

  it('trả 409 khi JWT User chưa liên kết Customer', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);

    await expect(service.findForUser('user-1', 'order-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'CUSTOMER_PROFILE_NOT_FOUND',
      }),
    });
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('trả cùng 404 khi Order không tồn tại hoặc không thuộc Customer', async () => {
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(service.findForUser('user-1', 'order-other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { id: 'order-other', customerId: 'customer-1' },
      select: { id: true, status: true },
    });
  });

  it('map đầy đủ nhiều Trip, latest GPS và stale theo measuredAt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-17T08:05:00.000Z'));
    prisma.trip.findMany.mockResolvedValue([
      {
        id: 'trip-1',
        tripNumber: 'TRIP-1',
        status: TripStatus.IN_PROGRESS,
        version: 4,
        plannedStartTime: new Date('2026-11-17T07:00:00.000Z'),
        stops: [{ plannedArrivalTime: new Date('2026-11-17T09:00:00.000Z') }],
        gpsEvents: [
          {
            latitude: new Prisma.Decimal('10.1234567'),
            longitude: new Prisma.Decimal('106.7654321'),
            accuracyM: new Prisma.Decimal('8.50'),
            measuredAt: new Date('2026-11-17T08:04:30.000Z'),
            receivedAt: new Date('2026-11-17T08:04:32.000Z'),
          },
        ],
      },
      {
        id: 'trip-2',
        tripNumber: 'TRIP-2',
        status: TripStatus.DISPATCHED,
        version: 2,
        plannedStartTime: new Date('2026-11-17T10:00:00.000Z'),
        stops: [],
        gpsEvents: [],
      },
      {
        id: 'trip-3',
        tripNumber: 'TRIP-3',
        status: TripStatus.COMPLETED,
        version: 9,
        plannedStartTime: new Date('2026-11-16T10:00:00.000Z'),
        stops: [{ plannedArrivalTime: new Date('2026-11-16T12:00:00.000Z') }],
        gpsEvents: [
          {
            latitude: new Prisma.Decimal('10'),
            longitude: new Prisma.Decimal('106'),
            accuracyM: null,
            measuredAt: new Date('2026-11-17T08:02:59.000Z'),
            receivedAt: new Date('2026-11-17T08:03:01.000Z'),
          },
        ],
      },
    ]);

    const result = await service.findForUser('user-1', 'order-1');

    expect(result.trackingStatus).toBe('AVAILABLE');
    expect(result.trips).toHaveLength(3);
    expect(result.trips[0]).toMatchObject({
      id: 'trip-1',
      plannedDeliveryAt: '2026-11-17T09:00:00.000Z',
      etaSource: 'PLANNED',
      vehicleLocation: {
        latitude: 10.1234567,
        longitude: 106.7654321,
        accuracyM: 8.5,
        isStale: false,
      },
    });
    expect(result.trips[1].vehicleLocation).toBeNull();
    expect(result.trips[1].plannedDeliveryAt).toBeNull();
    expect(result.trips[2].vehicleLocation).toMatchObject({ isStale: true });
    expect(JSON.stringify(result)).not.toContain('deviceSessionId');
    expect(JSON.stringify(result)).not.toContain('routeGeometry');
  });
});
