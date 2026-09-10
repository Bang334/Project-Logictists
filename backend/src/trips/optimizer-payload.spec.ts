import { expandOrderItemsToCargoUnits } from './optimizer-payload';

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
    expect(units.reduce((sum, unit) => sum + unit.weight_kg, 0)).toBeCloseTo(80);
    expect(units.every((unit) => unit.can_rotate === false)).toBe(true);
  });
});
