import type { DriverTripDetail } from '@/features/driver-trips/types/driver-trip.types';
import {
  DRIVER_INCIDENT_SEVERITIES,
  DRIVER_INCIDENT_TYPES,
  type CreateDriverIncidentInput,
  type DriverIncidentOrderReference,
} from '@/features/driver-incidents/types/driver-incident.types';

const MAX_FUTURE_MS = 5 * 60 * 1000;
const MAX_PAST_MS = 24 * 60 * 60 * 1000;

export interface DriverIncidentValidationResult {
  value?: CreateDriverIncidentInput;
  errors: Partial<Record<keyof CreateDriverIncidentInput, string>>;
}

export function validateDriverIncidentInput(
  input: CreateDriverIncidentInput,
  now = new Date(),
): DriverIncidentValidationResult {
  const errors: DriverIncidentValidationResult['errors'] = {};
  const description = input.description.trim();
  const occurredAt = new Date(input.occurredAt);

  if (!DRIVER_INCIDENT_TYPES.includes(input.type)) {
    errors.type = 'Loại sự cố không hợp lệ.';
  }
  if (!DRIVER_INCIDENT_SEVERITIES.includes(input.severity)) {
    errors.severity = 'Mức độ sự cố không hợp lệ.';
  }
  if (description.length < 10) {
    errors.description = 'Mô tả phải có ít nhất 10 ký tự.';
  } else if (description.length > 2000) {
    errors.description = 'Mô tả không được vượt quá 2000 ký tự.';
  }
  if (Number.isNaN(occurredAt.getTime())) {
    errors.occurredAt = 'Thời điểm xảy ra không hợp lệ.';
  } else {
    const offset = occurredAt.getTime() - now.getTime();
    if (offset > MAX_FUTURE_MS) {
      errors.occurredAt =
        'Thời điểm xảy ra không được quá 5 phút trong tương lai.';
    } else if (offset < -MAX_PAST_MS) {
      errors.occurredAt =
        'Thời điểm xảy ra không được quá 24 giờ trong quá khứ.';
    }
  }
  if (input.affectedOrderIds.length > 100) {
    errors.affectedOrderIds = 'Chỉ được chọn tối đa 100 đơn hàng.';
  } else if (
    new Set(input.affectedOrderIds).size !== input.affectedOrderIds.length
  ) {
    errors.affectedOrderIds = 'Danh sách đơn hàng không được trùng lặp.';
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    value: {
      ...input,
      description,
      occurredAt: occurredAt.toISOString(),
      affectedOrderIds: [...input.affectedOrderIds].sort(),
    },
  };
}

export function incidentInputFingerprint(input: CreateDriverIncidentInput) {
  return JSON.stringify({
    ...input,
    description: input.description.trim(),
    occurredAt: new Date(input.occurredAt).toISOString(),
    affectedOrderIds: [...input.affectedOrderIds].sort(),
  });
}

export function getTripIncidentOrderOptions(
  trip: DriverTripDetail,
): DriverIncidentOrderReference[] {
  const byId = new Map<string, DriverIncidentOrderReference>();
  for (const stop of trip.stops) {
    for (const task of stop.tasks) {
      if (task.order) byId.set(task.order.id, task.order);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.orderNumber.localeCompare(right.orderNumber),
  );
}
