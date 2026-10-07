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
