import type {
  CreateOrderFormErrors,
  CreateOrderFormValues,
  CreateOrderValidationResult,
  OrderItemFormValues,
  OrderStopFormValues,
} from '@/features/orders/types/order.types';

const PHONE_PATTERN = /^\+?[0-9]{9,15}$/;

export function normalizeOrderPhone(value: string): string {
  return value.trim().replace(/[\s.-]/g, '');
}

function parseNumber(
  value: string,
  path: string,
  label: string,
  errors: CreateOrderFormErrors,
  minExclusive: number,
  max: number,
): number | null {
  const normalized = value.trim();
  const parsed = normalized === '' ? Number.NaN : Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= minExclusive || parsed > max) {
    errors[path] = `${label} phải lớn hơn ${minExclusive} và không vượt quá ${max}.`;
    return null;
  }
  return parsed;
}

function parseCoordinate(
  value: string,
  path: string,
  label: string,
  min: number,
  max: number,
  errors: CreateOrderFormErrors,
): number | null {
  const normalized = value.trim();
  const parsed = normalized === '' ? Number.NaN : Number(normalized);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    errors[path] = `${label} phải nằm trong khoảng ${min} đến ${max}.`;
    return null;
  }
  return parsed;
}

function validateStop(
  stop: OrderStopFormValues,
  prefix: 'pickup' | 'delivery',
  errors: CreateOrderFormErrors,
) {
  const address = stop.address.trim();
  const contactName = stop.contactName.trim();
  const contactPhone = normalizeOrderPhone(stop.contactPhone);
  const latitude = parseCoordinate(
    stop.latitude,
    `${prefix}.latitude`,
    'Vĩ độ',
    -90,
    90,
    errors,
  );
  const longitude = parseCoordinate(
    stop.longitude,
    `${prefix}.longitude`,
    'Kinh độ',
    -180,
    180,
    errors,
  );

  if (!address) errors[`${prefix}.address`] = 'Vui lòng nhập địa chỉ.';
  if (address.length > 500) {
    errors[`${prefix}.address`] = 'Địa chỉ không được vượt quá 500 ký tự.';
  }
  if (!contactName) {
    errors[`${prefix}.contactName`] = 'Vui lòng nhập người liên hệ.';
  }
  if (contactName.length > 200) {
    errors[`${prefix}.contactName`] = 'Tên liên hệ không được vượt quá 200 ký tự.';
  }
  if (!PHONE_PATTERN.test(contactPhone)) {
    errors[`${prefix}.contactPhone`] =
      'Số điện thoại phải có 9-15 chữ số, có thể bắt đầu bằng +.';
  }

  if (
    !address ||
    !contactName ||
    !PHONE_PATTERN.test(contactPhone) ||
    latitude === null ||
    longitude === null
  ) {
    return null;
  }
  return { address, latitude, longitude, contactName, contactPhone };
}

function validateItem(
  item: OrderItemFormValues,
  index: number,
  errors: CreateOrderFormErrors,
) {
  const prefix = `items.${index}`;
  const description = item.description.trim();
  if (!description) errors[`${prefix}.description`] = 'Vui lòng nhập tên kiện.';
  if (description.length > 500) {
    errors[`${prefix}.description`] = 'Tên kiện không được vượt quá 500 ký tự.';
  }

  const quantityValue = item.quantity.trim();
  const quantity = quantityValue === '' ? Number.NaN : Number(quantityValue);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) {
    errors[`${prefix}.quantity`] = 'Số lượng phải là số nguyên từ 1 đến 500.';
  }
  const unitWeightKg = parseNumber(
    item.unitWeightKg,
    `${prefix}.unitWeightKg`,
    'Khối lượng mỗi kiện',
    errors,
    0,
    1_000,
  );
  const lengthCm = parseNumber(
    item.lengthCm,
    `${prefix}.lengthCm`,
    'Chiều dài',
    errors,
    0,
    1_000,
  );
  const widthCm = parseNumber(
    item.widthCm,
    `${prefix}.widthCm`,
    'Chiều rộng',
    errors,
    0,
    300,
  );
  const heightCm = parseNumber(
    item.heightCm,
    `${prefix}.heightCm`,
    'Chiều cao',
    errors,
    0,
    300,
  );

  if (
    !description ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 500 ||
    unitWeightKg === null ||
    lengthCm === null ||
    widthCm === null ||
    heightCm === null
  ) {
    return null;
  }
  return {
    description,
    packageType: item.packageType,
    quantity,
    unitWeightKg,
    lengthCm,
    widthCm,
    heightCm,
  };
}

export function validateCreateOrder(
  values: CreateOrderFormValues,
): CreateOrderValidationResult {
  const errors: CreateOrderFormErrors = {};
  if (!values.branchId) errors.branchId = 'Vui lòng chọn chi nhánh.';
  if (values.items.length < 1 || values.items.length > 20) {
    errors.items = 'Đơn phải có từ 1 đến 20 loại kiện.';
  }
  const pickup = validateStop(values.pickup, 'pickup', errors);
  const delivery = validateStop(values.delivery, 'delivery', errors);
  const items = values.items.map((item, index) =>
    validateItem(item, index, errors),
  );
  const notes = values.notes.trim();
  if (notes.length > 2_000) {
    errors.notes = 'Ghi chú không được vượt quá 2000 ký tự.';
  }

  if (
    Object.keys(errors).length > 0 ||
    !pickup ||
    !delivery ||
    items.some((item) => item === null)
  ) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      branchId: values.branchId,
      pickup,
      delivery,
      items: items.filter((item) => item !== null),
      ...(notes ? { notes } : {}),
    },
  };
}
