import { BadRequestException } from '@nestjs/common';
import { OrderStatus, OrderType, PackageStatus, StopType, TransportRequestStatus } from '@prisma/client';
import { TripsService } from '../../src/trips/trips.service';

describe('TripsService - Retail Multi-Source Optimization', () => {
  let service: TripsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      order: {
        findMany: jest.fn(),
      },
      driver: {
        findMany: jest.fn(),
      },
      vehicle: {
        findMany: jest.fn(),
      },
      branch: {
        findFirst: jest.fn(),
      },
    };
    service = new TripsService(prisma as never, {} as never, {} as never, {} as never);
  });

  describe('buildOptimizerOrders', () => {
    it('correctly maps multi-source RETAIL_DELIVERY transport requests to optimizer orders', () => {
      const now = new Date('2026-11-01T08:00:00.000Z');
      const order = {
        id: 'order-retail-1',
        orderNumber: 'SO-RETAIL-001',
        orderType: OrderType.RETAIL_DELIVERY,
        status: OrderStatus.CONFIRMED,
        orderedAt: now,
        totalAmount: 500000,
        stops: [
          {
            id: 'stop-pickup-1',
            type: StopType.PICKUP,
            address: 'Store A',
            latitude: 10.75,
            longitude: 106.65,
            serviceDurationMinutes: 10,
          },
          {
            id: 'stop-pickup-2',
            type: StopType.PICKUP,
            address: 'Store B',
            latitude: 10.78,
            longitude: 106.68,
            serviceDurationMinutes: 10,
          },
          {
            id: 'stop-delivery-1',
            type: StopType.DELIVERY,
            address: 'Customer Home',
            latitude: 10.8,
            longitude: 106.7,
            windowStart: new Date('2026-11-01T10:00:00.000Z'),
            windowEnd: new Date('2026-11-01T12:00:00.000Z'),
            serviceDurationMinutes: 15,
          },
        ],
        transportRequests: [
          {
            id: 'tr-1',
            requestNumber: 'TR-001',
            status: TransportRequestStatus.READY_FOR_ROUTING,
            pickupStop: {
              id: 'stop-pickup-1',
              address: 'Store A',
              latitude: 10.75,
              longitude: 106.65,
              serviceDurationMinutes: 10,
            },
            deliveryStop: {
              id: 'stop-delivery-1',
              address: 'Customer Home',
              latitude: 10.8,
              longitude: 106.7,
              windowStart: new Date('2026-11-01T10:00:00.000Z'),
              windowEnd: new Date('2026-11-01T12:00:00.000Z'),
              serviceDurationMinutes: 15,
            },
            packages: [
              {
                packageId: 'pkg-1',
                package: {
                  id: 'pkg-1',
                  sku: 'SKU-A',
                  lengthMm: 200,
                  widthMm: 150,
                  heightMm: 100,
                  weightG: BigInt(2000),
                },
              },
            ],
          },
          {
            id: 'tr-2',
            requestNumber: 'TR-002',
            status: TransportRequestStatus.READY_FOR_ROUTING,
            pickupStop: {
              id: 'stop-pickup-2',
              address: 'Store B',
              latitude: 10.78,
              longitude: 106.68,
              serviceDurationMinutes: 10,
            },
            deliveryStop: {
              id: 'stop-delivery-1',
              address: 'Customer Home',
              latitude: 10.8,
              longitude: 106.7,
              windowStart: new Date('2026-11-01T10:00:00.000Z'),
              windowEnd: new Date('2026-11-01T12:00:00.000Z'),
              serviceDurationMinutes: 15,
            },
            packages: [
              {
                packageId: 'pkg-2',
                package: {
                  id: 'pkg-2',
                  sku: 'SKU-B',
                  lengthMm: 300,
                  widthMm: 200,
                  heightMm: 150,
                  weightG: BigInt(3500),
                },
              },
            ],
          },
        ],
        items: [],
      };

      const optimizerOrders = (service as any).buildOptimizerOrders([order], now);

      expect(optimizerOrders).toHaveLength(2);

      // TR-1 (Store A -> Khách)
      expect(optimizerOrders[0].id).toBe('tr-1');
      expect(optimizerOrders[0].source_order_id).toBe('order-retail-1');
      expect(optimizerOrders[0].pickup_location.source_location_id).toBe('stop-pickup-1');
      expect(optimizerOrders[0].delivery_location.source_location_id).toBe('stop-delivery-1');
      expect(optimizerOrders[0].items).toHaveLength(1);
      expect(optimizerOrders[0].items[0].length_cm).toBe(20);
      expect(optimizerOrders[0].items[0].weight_kg).toBe(2);

      // TR-2 (Store B -> Khách)
      expect(optimizerOrders[1].id).toBe('tr-2');
      expect(optimizerOrders[1].source_order_id).toBe('order-retail-1');
      expect(optimizerOrders[1].pickup_location.source_location_id).toBe('stop-pickup-2');
      expect(optimizerOrders[1].delivery_location.source_location_id).toBe('stop-delivery-1');
      expect(optimizerOrders[1].items).toHaveLength(1);
      expect(optimizerOrders[1].items[0].length_cm).toBe(30);
      expect(optimizerOrders[1].items[0].weight_kg).toBe(3.5);
    });

    it('throws BadRequestException if RETAIL_DELIVERY order has no transport requests', () => {
      const now = new Date();
      const order = {
        id: 'order-no-tr',
        orderNumber: 'SO-NO-TR',
        orderType: OrderType.RETAIL_DELIVERY,
        status: OrderStatus.CONFIRMED,
        orderedAt: now,
        totalAmount: 100000,
        stops: [
          {
            id: 'stop-del-1',
            type: StopType.DELIVERY,
            address: 'Customer Home',
            latitude: 10.8,
            longitude: 106.7,
            windowStart: now,
            windowEnd: new Date(now.getTime() + 3600000),
          },
        ],
        transportRequests: [],
        items: [],
      };

      expect(() => (service as any).buildOptimizerOrders([order], now)).toThrow(BadRequestException);
    });
  });

  describe('ensurePhysicalPackageMapping', () => {
    it('correctly maps retail packages without requiring B2B order items', async () => {
      const tx = {
        order: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'order-retail-1',
              orderType: OrderType.RETAIL_DELIVERY,
              packages: [
                { id: 'pkg-retail-1' },
                { id: 'pkg-retail-2' },
              ],
            },
          ]),
        },
      };

      const orders = [
        {
          id: 'order-retail-1',
          orderType: OrderType.RETAIL_DELIVERY,
          packages: [
            { id: 'pkg-retail-1' },
            { id: 'pkg-retail-2' },
          ],
        },
      ];

      const mapping = await (service as any).ensurePhysicalPackageMapping(tx, orders);
      expect(mapping.get('pkg-retail-1')).toBe('pkg-retail-1');
      expect(mapping.get('pkg-retail-2')).toBe('pkg-retail-2');
    });
  });
});
