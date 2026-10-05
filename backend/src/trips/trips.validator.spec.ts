import { TripsValidator, StopWithItems } from './trips.validator';
import { Vehicle, OrderStatus, StopType, VehicleStatus, Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

describe('TripsValidator - TMS Invariants', () => {
  const mockVehicle: Vehicle = {
    id: 'veh-1',
    plateNumber: '29H-842.15',
    model: 'Hino 500',
    vehicleType: '5 tấn',
    homeBranchId: 'branch-1',
    vehicleTypeId: null,
    payloadCapacityKg: 5000,
    volumeCapacityM3: 25,
    lengthCm: 620,
    widthCm: 215,
    heightCm: 205,
    fuelConsumptionLitersPer100Km: new Prisma.Decimal(18.5),
    loadFuelSurchargePercentAtFullPayload: new Prisma.Decimal(0),
    fixedOperatingCostPerTrip: new Prisma.Decimal(120000),
    status: VehicleStatus.AVAILABLE,
    currentLatitude: null,
    currentLongitude: null,
    lastLocationAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const createMockOrder = (
    id: string,
    orderNumber: string,
    totalWeightKg: number,
    totalVolumeM3: number,
    items: StopWithItems['order']['items'] = [],
  ): StopWithItems['order'] => ({
    id,
    orderNumber,
    customerId: 'cust-1',
    branchId: 'branch-1',
    status: OrderStatus.CONFIRMED,
    totalWeightKg,
    totalVolumeM3,
    totalPackages: items.length || 1,
    version: 1,
    packageDataStatus: 'LEGACY_REVIEW',
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    items,
  });

  const sampleItems = [
    {
      id: 'i1',
      orderId: 'ord-1',
      sku: 'ITEM-1',
      description: 'Hàng mẫu',
      packageType: 'CARTON',
      quantity: 10,
      weightKg: 1000,
      lengthCm: 100,
      widthCm: 100,
      heightCm: 100,
      volumeM3: 5,
      createdAt: new Date(),
    },
  ];

  it('uses physical grams and mm³, ignores stale projections and rejects a one-gram overload', () => {
    const packages = [1, 2].map(n => ({ id: `pkg-${n}`, orderItemId: 'i1', packageCode: `PKG-${n}`,
      lengthMm: 1, widthMm: 1, heightMm: 1, weightG: 2500000n,
      status: 'READY' as const, version: 1, measurementSource: 'USER_DECLARED', measuredAt: null,
      allowedOrientations: null, createdAt: new Date(), updatedAt: new Date() }));
    const order = { ...createMockOrder('ord-1', 'O1', 0, 0, [{ ...sampleItems[0], quantity: 2, weightKg: 0, volumeM3: 0, packages }]), packageDataStatus: 'COMPLETE' };
    const orderStop = { id: 'p1', orderId: order.id, type: StopType.PICKUP, sequence: 1, address: 'test', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 0, createdAt: new Date() };
    const stops = [{ order, orderStop }, { order, orderStop: { ...orderStop, id: 'd1', type: StopType.DELIVERY } }];
    const result = TripsValidator.calculateAndValidateLoad(mockVehicle, stops);
    expect(result.maxWeightKg).toBe(5000);
    expect(result.maxVolumeM3).toBe(2e-9);
    expect(result.loadProfile[1].currentWeightKg).toBe(0);
    packages[0].weightG += 1n;
    expect(() => TripsValidator.calculateAndValidateLoad(mockVehicle, stops)).toThrow(BadRequestException);
  });

  describe('BR03: validatePickupBeforeDelivery', () => {
    it('Hợp lệ khi Điểm PICKUP đứng trước Điểm DELIVERY', () => {
      const stops: StopWithItems[] = [
        {
          orderStop: {
            id: 's1',
            orderId: 'ord-1',
            type: StopType.PICKUP,
            sequence: 1,
            address: 'Hà Nội',
            latitude: 21.0,
            longitude: 105.8,
            contactName: 'A',
            contactPhone: '091',
            windowBasis: null, windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: createMockOrder('ord-1', 'ORD-001', 1000, 5, sampleItems),
        },
        {
          orderStop: {
            id: 's2',
            orderId: 'ord-1',
            type: StopType.DELIVERY,
            sequence: 2,
            address: 'Hải Phòng',
            latitude: 20.8,
            longitude: 106.6,
            contactName: 'B',
            contactPhone: '092',
            windowBasis: null, windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: createMockOrder('ord-1', 'ORD-001', 1000, 5, sampleItems),
        },
      ];

      expect(() => TripsValidator.validatePickupBeforeDelivery(stops)).not.toThrow();
    });

    it('Ném lỗi BadRequestException nếu Điểm DELIVERY xếp trước Điểm PICKUP (Vi phạm BR03)', () => {
      const reversedStops: StopWithItems[] = [
        {
          orderStop: {
            id: 's2',
            orderId: 'ord-1',
            type: StopType.DELIVERY,
            sequence: 1,
            address: 'Hải Phòng',
            latitude: 20.8,
            longitude: 106.6,
            contactName: 'B',
            contactPhone: '092',
            windowBasis: null, windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: createMockOrder('ord-1', 'ORD-001', 1000, 5),
        },
        {
          orderStop: {
            id: 's1',
            orderId: 'ord-1',
            type: StopType.PICKUP,
            sequence: 2,
            address: 'Hà Nội',
            latitude: 21.0,
            longitude: 105.8,
            contactName: 'A',
            contactPhone: '091',
            windowBasis: null, windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: createMockOrder('ord-1', 'ORD-001', 1000, 5),
        },
      ];

      expect(() => TripsValidator.validatePickupBeforeDelivery(reversedStops)).toThrow(BadRequestException);
    });
  });

  describe('BR04: calculateAndValidateLoad qua từng chặng', () => {
    it('Chấp nhận chuyến có tổng đơn > tải xe NẾU có giao trước khi lấy đơn sau (Không vượt tải tại bất kỳ chặng nào)', () => {
      // Xe tải 5,000 kg.
      // Order 1: 3,500 kg.
      // Order 2: 3,000 kg.
      // Tổng 2 đơn = 6,500 kg > 5,000 kg.
      // Nhưng lộ trình: Pickup 1 (+3500kg) -> Delivery 1 (-3500kg) -> Pickup 2 (+3000kg) -> Delivery 2 (-3000kg).
      // Tải max trên xe chỉ là 3500 kg <= 5000 kg -> HỢP LỆ THEO INVARIANT 5!
      const item1 = [{ id: 'i1', orderId: 'o1', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3500, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }];
      const item2 = [{ id: 'i2', orderId: 'o2', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3000, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }];

      const stops: StopWithItems[] = [
        {
          orderStop: { id: 'p1', orderId: 'o1', type: StopType.PICKUP, sequence: 1, address: 'Kho A', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o1', 'O1', 3500, 10, item1),
        },
        {
          orderStop: { id: 'd1', orderId: 'o1', type: StopType.DELIVERY, sequence: 2, address: 'Kho B', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o1', 'O1', 3500, 10, item1),
        },
        {
          orderStop: { id: 'p2', orderId: 'o2', type: StopType.PICKUP, sequence: 3, address: 'Kho C', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o2', 'O2', 3000, 10, item2),
        },
        {
          orderStop: { id: 'd2', orderId: 'o2', type: StopType.DELIVERY, sequence: 4, address: 'Kho D', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o2', 'O2', 3000, 10, item2),
        },
      ];

      const result = TripsValidator.calculateAndValidateLoad(mockVehicle, stops);
      expect(result.isValid).toBe(true);
      expect(result.maxWeightKg).toBe(3500);
      expect(result.loadProfile.length).toBe(4);
    });

    it('Ném lỗi BadRequestException nếu tải tại một chặng vượt quá tải trọng xe (Vi phạm BR04)', () => {
      // Pickup cả 2 đơn trước: 3500 + 3000 = 6500 kg > 5000 kg -> Phải ném lỗi!
      const item1 = [{ id: 'i1', orderId: 'o1', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3500, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }];
      const item2 = [{ id: 'i2', orderId: 'o2', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3000, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }];

      const overloadedStops: StopWithItems[] = [
        {
          orderStop: { id: 'p1', orderId: 'o1', type: StopType.PICKUP, sequence: 1, address: 'Kho A', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o1', 'O1', 3500, 10, item1),
        },
        {
          orderStop: { id: 'p2', orderId: 'o2', type: StopType.PICKUP, sequence: 2, address: 'Kho C', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o2', 'O2', 3000, 10, item2),
        },
        {
          orderStop: { id: 'd1', orderId: 'o1', type: StopType.DELIVERY, sequence: 3, address: 'Kho B', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o1', 'O1', 3500, 10, item1),
        },
        {
          orderStop: { id: 'd2', orderId: 'o2', type: StopType.DELIVERY, sequence: 4, address: 'Kho D', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowBasis: null, windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: createMockOrder('o2', 'O2', 3000, 10, item2),
        },
      ];

      expect(() => TripsValidator.calculateAndValidateLoad(mockVehicle, overloadedStops)).toThrow(BadRequestException);
    });
  });
});
