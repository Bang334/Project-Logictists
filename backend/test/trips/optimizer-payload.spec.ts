import {
  expandOrderItemsToCargoUnits,
  expandPhysicalPackagesToCargoUnits,
  OptimizerOrder,
  splitOversizedOrdersAcrossFleet,
} from '../../src/trips/optimizer-payload';

describe('expandOrderItemsToCargoUnits', () => {
  it('bung nhiều loại hàng thành từng kiện và bảo toàn tổng khối lượng', () => {
    const units = expandOrderItemsToCargoUnits([
      {
        id: 'line-a',
        orderId: 'order-1',
        description: 'Thùng sữa',
        quantity: 3,
        weightKg: 30,
        lengthCm: 40,
        widthCm: 30,
        heightCm: 25,
      },
      {
        id: 'line-b',
        orderId: 'order-1',
        description: 'Kệ trưng bày',
        quantity: 2,
        weightKg: 50,
        lengthCm: 100,
        widthCm: 60,
        heightCm: 40,
      },
    ]);

    expect(units).toHaveLength(5);
    expect(units.map((unit) => unit.id)).toEqual([
      'line-a#1',
      'line-a#2',
      'line-a#3',
      'line-b#1',
      'line-b#2',
    ]);
    expect(units.reduce((sum, unit) => sum + unit.weight_kg, 0)).toBeCloseTo(
      80,
    );
    expect(units.every((unit) => unit.can_rotate === false)).toBe(true);
  });
});

describe('expandPhysicalPackagesToCargoUnits', () => {
  it('giữ một Package chứa nhiều mặt hàng thành đúng một kiện bất khả phân', () => {
    const units = expandPhysicalPackagesToCargoUnits('order-1', [
      {
        id: 'physical-package-1',
        packageCode: 'PKG-001',
        lengthMm: 1200,
        widthMm: 800,
        heightMm: 700,
        weightG: BigInt(1_500_000),
        items: [{ orderItemId: 'line-a' }, { orderItemId: 'line-b' }],
      },
    ]);

    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      id: 'package:physical-package-1',
      order_id: 'order-1',
      length_cm: 120,
      width_cm: 80,
      height_cm: 70,
      weight_kg: 1500,
    });
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
    can_rotate: false as const,
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
