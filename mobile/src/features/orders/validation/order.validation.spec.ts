import type { CreateOrderFormValues } from '@/features/orders/types/order.types';
import {
  normalizeOrderPhone,
  validateCreateOrder,
} from './order.validation';

function validForm(): CreateOrderFormValues {
  return {
    branchId: 'branch-1',
    pickup: {
      address: ' Kho Hà Nội ',
      latitude: '21.0278',
      longitude: '105.8342',
      contactName: ' Người gửi ',
      contactPhone: '090-111-2222',
    },
    delivery: {
      address: 'Đà Nẵng',
      latitude: '16.0544',
      longitude: '108.2022',
      contactName: 'Người nhận',
      contactPhone: '+84912223333',
    },
    items: [
      {
        clientId: 'item-1',
        description: ' Kiện thiết bị ',
        packageType: 'CRATE',
        quantity: '500',
        unitWeightKg: '1000',
        lengthCm: '1000',
        widthCm: '300',
        heightCm: '300',
      },
    ],
    notes: ' Chờ kiểm tra ',
  };
}

describe('validateCreateOrder', () => {
  it('chuẩn hóa form hợp lệ và nhận đúng các biên trên', () => {
    const result = validateCreateOrder(validForm());
    expect(result).toEqual({
      success: true,
      data: {
        branchId: 'branch-1',
        pickup: {
          address: 'Kho Hà Nội',
          latitude: 21.0278,
          longitude: 105.8342,
          contactName: 'Người gửi',
          contactPhone: '0901112222',
        },
        delivery: {
          address: 'Đà Nẵng',
          latitude: 16.0544,
          longitude: 108.2022,
          contactName: 'Người nhận',
          contactPhone: '+84912223333',
        },
        items: [
          {
            description: 'Kiện thiết bị',
            packageType: 'CRATE',
            quantity: 500,
            unitWeightKg: 1000,
            lengthCm: 1000,
            widthCm: 300,
            heightCm: 300,
          },
        ],
        notes: 'Chờ kiểm tra',
      },
    });
  });

  it('chuẩn hóa phone giống Backend', () => {
    expect(normalizeOrderPhone(' +84 90.123-4567 ')).toBe('+84901234567');
  });

  it.each([
    ['quantity', '0'],
    ['quantity', '1.5'],
    ['quantity', '501'],
    ['unitWeightKg', '1000.1'],
    ['lengthCm', '1001'],
    ['widthCm', '301'],
    ['heightCm', 'Infinity'],
  ] as const)('từ chối %s=%s', (field, value) => {
    const form = validForm();
    form.items[0]![field] = value;
    const result = validateCreateOrder(form);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errors[`items.0.${field}`]).toBeTruthy();
  });

  it('từ chối tọa độ, phone, branch và số loại kiện sai', () => {
    const form = validForm();
    form.branchId = '';
    form.pickup.latitude = '91';
    form.delivery.longitude = '-181';
    form.pickup.contactPhone = 'abc';
    form.items = [];
    const result = validateCreateOrder(form);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toMatchObject({
        branchId: expect.any(String),
        'pickup.latitude': expect.any(String),
        'pickup.contactPhone': expect.any(String),
        'delivery.longitude': expect.any(String),
        items: expect.any(String),
      });
    }
  });

  it('nhận 20 loại kiện và từ chối 21 loại', () => {
    const form = validForm();
    form.items = Array.from({ length: 20 }, (_, index) => ({
      ...form.items[0]!,
      clientId: `item-${index}`,
    }));
    expect(validateCreateOrder(form).success).toBe(true);
    form.items.push({ ...form.items[0]!, clientId: 'item-21' });
    expect(validateCreateOrder(form).success).toBe(false);
  });
});
