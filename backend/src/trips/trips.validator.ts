import { BadRequestException, ConflictException } from '@nestjs/common';
import { Vehicle, Order, OrderStop, OrderItem, StopType } from '@prisma/client';

export interface StopWithItems {
  orderStop: OrderStop;
  order: Order & { items: OrderItem[] };
}

export interface LegLoadStatus {
  stopIndex: number;
  stopAddress: string;
  stopType: StopType;
  action: 'LOAD' | 'UNLOAD';
  deltaWeightKg: number;
  deltaVolumeM3: number;
  currentWeightKg: number;
  currentVolumeM3: number;
  weightUtilizationPercent: number;
  volumeUtilizationPercent: number;
}

export interface ValidationResult {
  isValid: boolean;
  loadProfile: LegLoadStatus[];
  maxWeightKg: number;
  maxVolumeM3: number;
  errors: string[];
}

export class TripsValidator {
  /**
   * Kiểm tra bất biến BR03: Pickup của một đơn hàng phải diễn ra TRƯỚC Delivery
   */
  static validatePickupBeforeDelivery(orderedStops: StopWithItems[]): void {
    const pickupIndices = new Map<string, number>();
    const deliveryIndices = new Map<string, number>();

    orderedStops.forEach((stop, index) => {
      const orderId = stop.orderStop.orderId;
      if (stop.orderStop.type === StopType.PICKUP) {
        pickupIndices.set(orderId, index);
      } else if (stop.orderStop.type === StopType.DELIVERY) {
        deliveryIndices.set(orderId, index);
      }
    });

    for (const [orderId, deliveryIndex] of deliveryIndices.entries()) {
      const pickupIndex = pickupIndices.get(orderId);
      if (pickupIndex === undefined) {
        throw new BadRequestException(
          `Vi phạm BR03: Đơn hàng [${orderId}] có điểm giao nhưng thiếu điểm lấy hàng trong chuyến đi!`,
        );
      }
      if (pickupIndex >= deliveryIndex) {
        throw new BadRequestException(
          `Vi phạm BR03: Điểm lấy hàng (thứ tự ${pickupIndex + 1}) không được diễn ra sau điểm giao hàng (thứ tự ${deliveryIndex + 1}) cho đơn hàng [${orderId}]!`,
        );
      }
    }
  }

  /**
   * Kiểm tra bất biến BR04: Tính tải trọng và thể tích xe qua TỪNG CHẶNG (Stop-by-Stop)
   * Tuyệt đối không để vượt tải tại bất kỳ chặng nào giữa 2 điểm dừng.
   */
  static calculateAndValidateLoad(
    vehicle: Vehicle,
    orderedStops: StopWithItems[],
  ): ValidationResult {
    const loadProfile: LegLoadStatus[] = [];
    let currentWeight = 0;
    let currentVolume = 0;
    let maxWeight = 0;
    let maxVolume = 0;
    const errors: string[] = [];

    orderedStops.forEach((stop, index) => {
      // Tính tổng khối lượng và thể tích của order tại stop này
      const stopWeight = stop.order.items.reduce((sum, item) => sum + item.weightKg, 0);
      const stopVolume = stop.order.items.reduce((sum, item) => sum + item.volumeM3, 0);

      const isPickup = stop.orderStop.type === StopType.PICKUP;
      const deltaWeight = isPickup ? stopWeight : -stopWeight;
      const deltaVolume = isPickup ? stopVolume : -stopVolume;

      currentWeight += deltaWeight;
      currentVolume += deltaVolume;

      // Làm tròn số thập phân
      currentWeight = Math.round(currentWeight * 10) / 10;
      currentVolume = Math.round(currentVolume * 100) / 100;

      if (currentWeight > maxWeight) maxWeight = currentWeight;
      if (currentVolume > maxVolume) maxVolume = currentVolume;

      const weightUtilization = Math.round((currentWeight / vehicle.payloadCapacityKg) * 1000) / 10;
      const volumeUtilization = Math.round((currentVolume / vehicle.volumeCapacityM3) * 1000) / 10;

      // Kiểm tra vi phạm tải trọng
      if (currentWeight > vehicle.payloadCapacityKg) {
        errors.push(
          `Vi phạm tải trọng tại Điểm ${index + 1} (${stop.orderStop.address}): Tải trên xe đạt ${currentWeight} kg, vượt quá tải trọng cho phép của xe ${vehicle.plateNumber} (${vehicle.payloadCapacityKg} kg)!`,
        );
      }

      // Kiểm tra vi phạm thể tích
      if (currentVolume > vehicle.volumeCapacityM3) {
        errors.push(
          `Vi phạm thể tích tại Điểm ${index + 1} (${stop.orderStop.address}): Thể tích hàng ${currentVolume} m³, vượt quá dung tích thùng xe ${vehicle.plateNumber} (${vehicle.volumeCapacityM3} m³)!`,
        );
      }

      loadProfile.push({
        stopIndex: index + 1,
        stopAddress: stop.orderStop.address,
        stopType: stop.orderStop.type,
        action: isPickup ? 'LOAD' : 'UNLOAD',
        deltaWeightKg: deltaWeight,
        deltaVolumeM3: deltaVolume,
        currentWeightKg: currentWeight,
        currentVolumeM3: currentVolume,
        weightUtilizationPercent: weightUtilization,
        volumeUtilizationPercent: volumeUtilization,
      });
    });

    if (errors.length > 0) {
      throw new BadRequestException(errors.join(' | '));
    }

    return {
      isValid: true,
      loadProfile,
      maxWeightKg: maxWeight,
      maxVolumeM3: maxVolume,
      errors: [],
    };
  }
}
