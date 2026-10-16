import { BadRequestException } from '@nestjs/common';
import { Vehicle, VehicleType, Order, OrderStop, OrderItem, Package, StopType } from '@prisma/client';
import { packageTotals } from '../orders/package-measurements';
import { assertPackageManifest } from '../orders/order-contract';

export interface StopWithItems {
  orderStop: Pick<OrderStop, 'id' | 'orderId' | 'type' | 'address'> & Partial<OrderStop>;
  order: Pick<Order, 'id' | 'orderNumber' | 'totalWeightKg' | 'totalVolumeM3'> & Partial<Order> & { items: Array<Pick<OrderItem, 'quantity' | 'weightKg' | 'volumeM3'> & Partial<OrderItem> & { packages?: Package[] }> };
}

export interface LegLoadStatus {
  stopIndex: number;
  stopAddress: string;
  stopType: StopType;
  action: "LOAD" | "UNLOAD";
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
    vehicle: Vehicle & {
      vehicleTypeRecord: Pick<VehicleType, 'payloadCapacityKg' | 'volumeCapacityM3'>;
    },
    orderedStops: StopWithItems[],
  ): ValidationResult {
    const loadProfile: LegLoadStatus[] = [];
    let currentWeightG = 0n;
    let currentVolumeMm3 = 0n;
    let maxWeight = 0;
    let maxVolume = 0;
    const errors: string[] = [];
    const capacity = vehicle.vehicleTypeRecord;

    orderedStops.forEach((stop, index) => {
      const manifest = { ...stop.order, packageDataStatus: stop.order.packageDataStatus ?? 'LEGACY_REVIEW', items: stop.order.items.map(item => ({ ...item, packages: item.packages ?? [] })) };
      const canonical = stop.order.packageDataStatus === 'COMPLETE';
      if (canonical) assertPackageManifest(manifest);
      // Legacy projections are only for historical display/validation. Never infer physical packages.
      const totals = canonical ? packageTotals(manifest.items.flatMap(item => item.packages)) : {
        weightG: BigInt(Math.round(stop.order.items.reduce((sum, item) => sum + item.weightKg, 0) * 1000)),
        volumeMm3: BigInt(Math.round(stop.order.items.reduce((sum, item) => sum + item.volumeM3, 0) * 1e9)),
      };
      const isPickup = stop.orderStop.type === StopType.PICKUP;
      const sign = isPickup ? 1n : -1n;
      currentWeightG += sign * totals.weightG;
      currentVolumeMm3 += sign * totals.volumeMm3;
      const deltaWeight = Number(sign * totals.weightG) / 1000;
      const deltaVolume = Number(sign * totals.volumeMm3) / 1e9;
      const currentWeight = Number(currentWeightG) / 1000;
      const currentVolume = Number(currentVolumeMm3) / 1e9;

      if (currentWeight > maxWeight) maxWeight = currentWeight;
      if (currentVolume > maxVolume) maxVolume = currentVolume;

      const weightUtilization =
        Math.round((currentWeight / capacity.payloadCapacityKg) * 1000) / 10;
      const volumeUtilization =
        Math.round((currentVolume / capacity.volumeCapacityM3) * 1000) / 10;

      // Kiểm tra vi phạm tải trọng
      if (currentWeightG > BigInt(Math.floor(capacity.payloadCapacityKg * 1000))) {
        errors.push(
          `Vi phạm tải trọng tại Điểm ${index + 1} (${stop.orderStop.address}): Tải trên xe đạt ${currentWeight} kg, vượt quá tải trọng cho phép của xe ${vehicle.plateNumber} (${capacity.payloadCapacityKg} kg)!`,
        );
      }

      // Kiểm tra vi phạm thể tích
      if (currentVolumeMm3 > BigInt(Math.floor(capacity.volumeCapacityM3 * 1e9))) {
        errors.push(
          `Vi phạm thể tích tại Điểm ${index + 1} (${stop.orderStop.address}): Thể tích hàng ${currentVolume} m³, vượt quá dung tích thùng xe ${vehicle.plateNumber} (${capacity.volumeCapacityM3} m³)!`,
        );
      }

      loadProfile.push({
        stopIndex: index + 1,
        stopAddress: stop.orderStop.address,
        stopType: stop.orderStop.type,
        action: isPickup ? "LOAD" : "UNLOAD",
        deltaWeightKg: deltaWeight,
        deltaVolumeM3: deltaVolume,
        currentWeightKg: currentWeight,
        currentVolumeM3: currentVolume,
        weightUtilizationPercent: weightUtilization,
        volumeUtilizationPercent: volumeUtilization,
      });
    });

    if (errors.length > 0) {
      throw new BadRequestException(errors.join(" | "));
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
