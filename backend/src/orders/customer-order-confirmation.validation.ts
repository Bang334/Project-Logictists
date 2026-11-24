import { UnprocessableEntityException } from '@nestjs/common';
import { Order, OrderItem, OrderStop, StopType } from '@prisma/client';
import { validateSync } from 'class-validator';
import {
  CreateCustomerOrderItemDto,
  CreateCustomerOrderStopDto,
} from './dto/create-customer-order.dto';

function validationFailure(message: string): never {
  throw new UnprocessableEntityException({
    errorCode: 'ORDER_VALIDATION_FAILED',
    message,
  });
}

function matchesTotal(actual: number, expected: number): boolean {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    actual > 0 &&
    Math.abs(actual - expected) <= expected * 1e-9
  );
}

export function validateCustomerOrderForConfirmation(
  order: Pick<Order, 'totalPackages' | 'totalWeightKg' | 'totalVolumeM3'> & {
    stops: OrderStop[];
    items: Pick<
      OrderItem,
      'description' | 'packageType' | 'quantity' | 'weightKg' | 'lengthCm' |
      'widthCm' | 'heightCm' | 'volumeM3'
    >[];
  },
) {
  const [pickup, delivery] = order.stops;
  if (
    order.stops.length !== 2 ||
    pickup.type !== StopType.PICKUP ||
    pickup.sequence !== 1 ||
    delivery.type !== StopType.DELIVERY ||
    delivery.sequence !== 2
  ) {
    validationFailure('Đơn phải có điểm lấy hàng số 1 và điểm giao hàng số 2.');
  }

  for (const stop of order.stops) {
    const storedStop = Object.assign(new CreateCustomerOrderStopDto(), {
      address: stop.address.trim(),
      latitude: stop.latitude,
      longitude: stop.longitude,
      contactName: stop.contactName.trim(),
      contactPhone: stop.contactPhone,
    });
    if (
      validateSync(storedStop).length ||
      !Number.isInteger(stop.serviceDurationMinutes) ||
      stop.serviceDurationMinutes <= 0
    ) {
      validationFailure(`Thông tin điểm dừng số ${stop.sequence} không hợp lệ.`);
    }
  }

  if (order.items.length < 1 || order.items.length > 20) {
    validationFailure('Đơn phải có từ 1 đến 20 loại kiện.');
  }

  let totalPackages = 0;
  let totalWeightKg = 0;
  let totalVolumeM3 = 0;
  for (const item of order.items) {
    const unitWeightKg = item.weightKg / item.quantity;
    const lineVolumeM3 =
      (item.lengthCm * item.widthCm * item.heightCm * item.quantity) / 1_000_000;
    const storedItem = Object.assign(new CreateCustomerOrderItemDto(), {
      description: item.description.trim(),
      packageType: item.packageType.trim(),
      quantity: item.quantity,
      unitWeightKg,
      lengthCm: item.lengthCm,
      widthCm: item.widthCm,
      heightCm: item.heightCm,
    });
    // Apply materializes physical cargo in whole grams and millimeters.
    if (
      validateSync(storedItem).length ||
      Math.round(unitWeightKg * 1_000) <= 0 ||
      [item.lengthCm, item.widthCm, item.heightCm].some(
        (dimension) => Math.round(dimension * 10) <= 0,
      ) ||
      !matchesTotal(item.volumeM3, lineVolumeM3)
    ) {
      validationFailure('Thông tin kiện hoặc thể tích dòng hàng không hợp lệ.');
    }
    totalPackages += item.quantity;
    totalWeightKg += item.weightKg;
    totalVolumeM3 += lineVolumeM3;
  }

  if (
    order.totalPackages !== totalPackages ||
    !matchesTotal(order.totalWeightKg, totalWeightKg) ||
    !matchesTotal(order.totalVolumeM3, totalVolumeM3)
  ) {
    validationFailure('Tổng số kiện, khối lượng hoặc thể tích của đơn không khớp.');
  }
}
