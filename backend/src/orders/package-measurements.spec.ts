import { packageTotals, serializePackageTotals } from './package-measurements';

describe('physical package measurements', () => {
  it('adds each physical package once, keeping unequal weights and dimensions', () => {
    const packages = [
      { lengthMm: 400, widthMm: 300, heightMm: 250, weightG: 10001n },
      { lengthMm: 1000, widthMm: 600, heightMm: 400, weightG: 25002n },
    ];
    expect(serializePackageTotals(packages)).toEqual({ totalPackages: 2, totalWeightG: '35003', totalVolumeMm3: '270000000' });
  });
  it('preserves grams and volume beyond floating-point integer precision', () => {
    expect(packageTotals([{ lengthMm: 1000001, widthMm: 1000001, heightMm: 1000001, weightG: 9007199254740993n }]))
      .toEqual({ totalPackages: 1, weightG: 9007199254740993n, volumeMm3: 1000003000003000001n });
  });
  it.each([0, -1, 0.5, NaN, Infinity])('rejects invalid canonical length %s', lengthMm => {
    expect(() => packageTotals([{ lengthMm, widthMm: 100, heightMm: 100, weightG: 1n }])).toThrow();
  });
  it.each([0n, -1n])('rejects invalid weight %s', weightG => {
    expect(() => packageTotals([{ lengthMm: 100, widthMm: 100, heightMm: 100, weightG }])).toThrow();
  });
});
