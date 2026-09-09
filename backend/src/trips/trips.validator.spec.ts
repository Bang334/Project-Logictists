import { TripsValidator, StopWithItems } from './trips.validator';
import { Vehicle, OrderStatus, StopType, VehicleStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

describe('TripsValidator - TMS Invariants', () => {
  const mockVehicle: Vehicle = {
    id: 'veh-1',
    plateNumber: '29H-842.15',
    model: 'Hino 500',
    vehicleType: '5 tấn',
    homeBranchId: 'branch-1',
    payloadCapacityKg: 5000,
    volumeCapacityM3: 25,
    lengthCm: 620,
    widthCm: 215,
    heightCm: 205,
    status: VehicleStatus.AVAILABLE,
    currentLatitude: null,
    currentLongitude: null,
    lastLocationAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

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
            windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: {
            id: 'ord-1',
            orderNumber: 'ORD-001',
            customerId: 'cust-1',
            status: OrderStatus.CONFIRMED,
            totalWeightKg: 1000,
            totalVolumeM3: 5,
            totalPackages: 10,
            version: 1,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            items: [
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
            ],
          },
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
            windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: {
            id: 'ord-1',
            orderNumber: 'ORD-001',
            customerId: 'cust-1',
            status: OrderStatus.CONFIRMED,
            totalWeightKg: 1000,
            totalVolumeM3: 5,
            totalPackages: 10,
            version: 1,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            items: [
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
            ],
          },
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
            windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: {
            id: 'ord-1',
            orderNumber: 'ORD-001',
            customerId: 'cust-1',
            status: OrderStatus.CONFIRMED,
            totalWeightKg: 1000,
            totalVolumeM3: 5,
            totalPackages: 10,
            version: 1,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            items: [],
          },
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
            windowStart: null,
            windowEnd: null,
            serviceDurationMinutes: 15,
            createdAt: new Date(),
          },
          order: {
            id: 'ord-1',
            orderNumber: 'ORD-001',
            customerId: 'cust-1',
            status: OrderStatus.CONFIRMED,
            totalWeightKg: 1000,
            totalVolumeM3: 5,
            totalPackages: 10,
            version: 1,
            notes: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            items: [],
          },
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
      const stops: StopWithItems[] = [
        {
          orderStop: { id: 'p1', orderId: 'o1', type: StopType.PICKUP, sequence: 1, address: 'Kho A', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o1', orderNumber: 'O1', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3500, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i1', orderId: 'o1', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3500, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
        {
          orderStop: { id: 'd1', orderId: 'o1', type: StopType.DELIVERY, sequence: 2, address: 'Kho B', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o1', orderNumber: 'O1', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3500, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i1', orderId: 'o1', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3500, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
        {
          orderStop: { id: 'p2', orderId: 'o2', type: StopType.PICKUP, sequence: 3, address: 'Kho C', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o2', orderNumber: 'O2', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3000, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i2', orderId: 'o2', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3000, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
        {
          orderStop: { id: 'd2', orderId: 'o2', type: StopType.DELIVERY, sequence: 4, address: 'Kho D', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o2', orderNumber: 'O2', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3000, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i2', orderId: 'o2', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3000, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
      ];

      const result = TripsValidator.calculateAndValidateLoad(mockVehicle, stops);
      expect(result.isValid).toBe(true);
      expect(result.maxWeightKg).toBe(3500);
      expect(result.loadProfile.length).toBe(4);
    });

    it('Ném lỗi BadRequestException nếu tải tại một chặng vượt quá tải trọng xe (Vi phạm BR04)', () => {
      // Pickup cả 2 đơn trước: 3500 + 3000 = 6500 kg > 5000 kg -> Phải ném lỗi!
      const overloadedStops: StopWithItems[] = [
        {
          orderStop: { id: 'p1', orderId: 'o1', type: StopType.PICKUP, sequence: 1, address: 'Kho A', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o1', orderNumber: 'O1', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3500, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i1', orderId: 'o1', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3500, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
        {
          orderStop: { id: 'p2', orderId: 'o2', type: StopType.PICKUP, sequence: 2, address: 'Kho C', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o2', orderNumber: 'O2', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3000, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i2', orderId: 'o2', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3000, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
        {
          orderStop: { id: 'd1', orderId: 'o1', type: StopType.DELIVERY, sequence: 3, address: 'Kho B', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o1', orderNumber: 'O1', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3500, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i1', orderId: 'o1', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3500, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
        {
          orderStop: { id: 'd2', orderId: 'o2', type: StopType.DELIVERY, sequence: 4, address: 'Kho D', latitude: 0, longitude: 0, contactName: '', contactPhone: '', windowStart: null, windowEnd: null, serviceDurationMinutes: 15, createdAt: new Date() },
          order: { id: 'o2', orderNumber: 'O2', customerId: 'c', status: OrderStatus.CONFIRMED, totalWeightKg: 3000, totalVolumeM3: 10, totalPackages: 1, version: 1, notes: null, createdAt: new Date(), updatedAt: new Date(), items: [{ id: 'i2', orderId: 'o2', sku: '', description: '', packageType: 'CARTON', quantity: 1, weightKg: 3000, lengthCm: 0, widthCm: 0, heightCm: 0, volumeM3: 10, createdAt: new Date() }] },
        },
      ];

      expect(() => TripsValidator.calculateAndValidateLoad(mockVehicle, overloadedStops)).toThrow(BadRequestException);
    });
  });
});
