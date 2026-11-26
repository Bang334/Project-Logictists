import { assertDispatchableOrder, validateOrderInput } from '../../src/orders/order-contract';
import { CreateOrderDto } from '../../src/orders/dto/create-order.dto';

describe('Order delivery grace policy', () => {
  it('xác nhận đơn không cần khách nhập cửa sổ giao', () => {
    const dto: CreateOrderDto = {
      branchId: 'branch', customerId: 'customer',
      stops: (['PICKUP', 'DELIVERY'] as const).map(type => ({
        type, address: 'Địa chỉ thử', latitude: 10, longitude: 106,
        contactName: 'Khách thử', contactPhone: '0000000000', serviceDurationMinutes: 15,
      })),
      items: [{ description: 'Kiện thử', packageType: 'CARTON', packages: [
        { lengthMm: 100, widthMm: 100, heightMm: 100, weightG: '1000' },
      ] }],
    };
    expect(() => validateOrderInput(dto, true)).not.toThrow();
    expect(() => assertDispatchableOrder({
      status: 'CONFIRMED', packageDataStatus: 'COMPLETE',
      stops: dto.stops.map(stop => ({ ...stop, windowBasis: null, windowStart: null, windowEnd: null })),
      items: [{ quantity: 1, packages: [{ ...dto.items[0].packages[0], weightG: 1000n, status: 'READY' }] }],
    })).not.toThrow();
  });
});
