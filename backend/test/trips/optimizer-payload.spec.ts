import { OptimizerOrder, splitOversizedOrdersAcrossFleet } from '../../src/trips/optimizer-payload';
import { packagesToCargoUnits } from '../../src/trips/optimizer-payload';
describe('persisted Package optimizer contract', () => {
  const line = { id: 'line-a', orderId: 'order-1', description: 'Hai kiện khác nhau', quantity: 2, packages: [
    { id: 'pkg-a', orderItemId: 'line-a', lengthMm: 401, widthMm: 302, heightMm: 253, weightG: 10001n },
    { id: 'pkg-b', orderItemId: 'line-a', lengthMm: 1000, widthMm: 600, heightMm: 400, weightG: 25002n },
  ] };
  it('keeps database IDs and unequal weights, converting mm/g once', () => {
    const units = packagesToCargoUnits([line]);
    expect(units.map(u => u.id)).toEqual(['pkg-a', 'pkg-b']);
    expect(units[0]).toMatchObject({ order_id: 'order-1', order_item_id: 'line-a', length_cm: 40.1, width_cm: 30.2, height_cm: 25.3, weight_kg: 10.001, can_rotate: false });
    expect(units.reduce((sum, u) => sum + u.weight_kg, 0)).toBeCloseTo(35.003);
    expect(units).toHaveLength(2);
  });
  it('rejects legacy lines without packages rather than manufacturing IDs or dividing weights', () => {
    expect(() => packagesToCargoUnits([{ ...line, packages: [] }])).toThrow();
  });
  it('rejects duplicate and foreign package IDs and a mismatched count', () => {
    expect(() => packagesToCargoUnits([{ ...line, quantity: 3 }])).toThrow();
    expect(() => packagesToCargoUnits([line, line])).toThrow();
    expect(() => packagesToCargoUnits([{ ...line, packages: line.packages.map(p => ({ ...p, orderItemId: 'foreign' })) }])).toThrow();
  });
});

describe('splitOversizedOrdersAcrossFleet', () => {
  const vehicles = [
    {
      id: 'truck-a',
      length_cm: 200,
      width_cm: 100,
      height_cm: 120,
      payload_limit_kg: 1000,
    },
    {
      id: 'truck-b',
      length_cm: 200,
      width_cm: 100,
      height_cm: 120,
      payload_limit_kg: 1000,
    },
  ];

  const order = (items: OptimizerOrder['items']): OptimizerOrder => ({
    id: 'order-1',
    order_number: 'DH-001',
    pickup_location: {
      id: 'pickup-1',
      name: 'Kho',
      latitude: 12,
      longitude: 109,
    },
    delivery_location: {
      id: 'delivery-1',
      name: 'Khách',
      latitude: 12.1,
      longitude: 109.1,
    },
    items,
    ordered_at_sec: 0,
    order_value_vnd: 1_000_000,
    service_time_sec: 900,
  });

  const cargo = (id: string, weight = 600) => ({
    id,
    order_id: 'order-1',
    order_item_id: `line-${id}`,
    description: id,
    length_cm: 150,
    width_cm: 80,
    height_cm: 80,
    weight_kg: weight,
    can_rotate: true as const,
  });

  it('giữ nguyên đơn một kiện vượt khả năng mọi xe để solver từ chối có lý do', () => {
    const input = order([cargo('oversized', 1200)]);

    expect(splitOversizedOrdersAcrossFleet([input], vehicles)).toEqual([input]);
  });

  it('chia đơn nhiều kiện vượt một xe sang các xe vật lý khác nhau', () => {
    const result = splitOversizedOrdersAcrossFleet(
      [order([cargo('pkg-1'), cargo('pkg-2')])],
      vehicles,
    );

    expect(result).toHaveLength(2);
    expect(result.map((part) => part.source_order_id)).toEqual([
      'order-1',
      'order-1',
    ]);
    expect(
      new Set(result.flatMap((part) => part.items.map((item) => item.id))),
    ).toEqual(new Set(['pkg-1', 'pkg-2']));
    expect(
      new Set(result.flatMap((part) => part.allowed_source_vehicle_ids ?? [])),
    ).toEqual(new Set(['truck-a', 'truck-b']));
    expect(result[0].pickup_location.source_location_id).toBe('pickup-1');
  });

  it('không chia đơn khi toàn bộ kiện vẫn vừa một xe', () => {
    const input = order([
      { ...cargo('pkg-1', 300), length_cm: 80, width_cm: 50 },
      { ...cargo('pkg-2', 300), length_cm: 80, width_cm: 50 },
    ]);

    expect(splitOversizedOrdersAcrossFleet([input], vehicles)).toEqual([input]);
  });

  it('quay lui khi best-fit ban đầu bỏ sót một cách chia hợp lệ', () => {
    const equalVehicles = ['truck-a', 'truck-b', 'truck-c'].map((id) => ({
      id,
      length_cm: 100,
      width_cm: 10,
      height_cm: 100,
      payload_limit_kg: 100,
    }));
    const lengths = [90, 60, 50, 30, 20, 20, 20];
    const input = order(
      lengths.map((length, index) => ({
        ...cargo(`pkg-${index + 1}`, 1),
        length_cm: length,
        width_cm: 10,
      })),
    );

    const result = splitOversizedOrdersAcrossFleet([input], equalVehicles);

    expect(result).toHaveLength(3);
    expect(result.flatMap((part) => part.items)).toHaveLength(lengths.length);
    expect(
      result.every(
        (part) =>
          part.items.reduce((sum, item) => sum + item.length_cm, 0) <= 100,
      ),
    ).toBe(true);
  });

  it('dùng đúng hai xe cho hai kiện 1 tấn khi mỗi xe chở tối đa 1,9 tấn', () => {
    const fleet = ['truck-a', 'truck-b', 'truck-c'].map((id) => ({
      id,
      length_cm: 300,
      width_cm: 100,
      height_cm: 120,
      payload_limit_kg: 1900,
    }));
    const input = order([
      { ...cargo('ton-1', 1000), length_cm: 160, width_cm: 100 },
      { ...cargo('ton-2', 1000), length_cm: 140, width_cm: 100 },
    ]);

    const result = splitOversizedOrdersAcrossFleet([input], fleet);

    expect(result).toHaveLength(2);
    expect(result.map((part) => part.items.length)).toEqual([1, 1]);
  });

  it('không loại xe khi kiện chỉ vừa sau khi xoay 90 độ trên mặt sàn', () => {
    const rotationOnlyFleet = ['truck-a', 'truck-b'].map((id) => ({
      id,
      length_cm: 80,
      width_cm: 120,
      height_cm: 120,
      payload_limit_kg: 1000,
    }));
    const input = order([
      { ...cargo('rotated-1', 600), length_cm: 100, width_cm: 70 },
      { ...cargo('rotated-2', 600), length_cm: 100, width_cm: 70 },
    ]);

    const result = splitOversizedOrdersAcrossFleet(
      [input],
      rotationOnlyFleet,
    );

    expect(result).toHaveLength(2);
    expect(
      new Set(result.flatMap((part) => part.allowed_source_vehicle_ids ?? [])),
    ).toEqual(new Set(['truck-a', 'truck-b']));
  });

  it('xếp đầy các xe đang dùng thay vì tách 100 kiện nhỏ ra 100 xe', () => {
    const fleet = Array.from({ length: 100 }, (_, index) => ({
      id: `truck-${index + 1}`,
      length_cm: 100,
      width_cm: 10,
      height_cm: 100,
      payload_limit_kg: 10,
    }));
    const input = order(
      Array.from({ length: 100 }, (_, index) => ({
        ...cargo(`small-${index + 1}`, 1),
        length_cm: 10,
        width_cm: 10,
      })),
    );

    const result = splitOversizedOrdersAcrossFleet([input], fleet);

    expect(result).toHaveLength(10);
    expect(result.every((part) => part.items.length === 10)).toBe(true);
    expect(result.flatMap((part) => part.items)).toHaveLength(100);
  });
});
