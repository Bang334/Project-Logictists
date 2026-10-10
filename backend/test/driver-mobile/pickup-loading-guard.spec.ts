import { assertFixedLoadingPath } from '../../src/driver-mobile/pickup-loading-guard';
const dimensions = { lengthCm: 400, widthCm: 200, heightCm: 200 };
const target = { packageId: 'target', xMm: 0, yMm: 0, zMm: 0, effectiveLengthMm: 200, effectiveWidthMm: 200, effectiveHeightMm: 200 };
describe('fixed placement execution guard', () => {
  it('allows empty floor and a side-by-side neighbour without moving it', () => {
    expect(() => assertFixedLoadingPath(target, [], dimensions)).not.toThrow();
    expect(() => assertFixedLoadingPath(target, [{ ...target, packageId: 'side', yMm: 200 }], dimensions)).not.toThrow();
  });
  it('refuses collision and a parcel blocking the rear-door translation', () => {
    expect(() => assertFixedLoadingPath(target, [{ ...target, packageId: 'blocker', xMm: 300 }], dimensions)).toThrow();
    expect(() => assertFixedLoadingPath(target, [{ ...target, packageId: 'overlap', xMm: 100 }], dimensions)).toThrow();
  });
  it.each([{ zMm: 200 }, { xMm: -1 }, { yMm: 2000 }, { effectiveLengthMm: 4001 }, { effectiveHeightMm: 2001 }, { effectiveWidthMm: 0 }])('rejects invalid or stacked placement %j', change => {
    expect(() => assertFixedLoadingPath({ ...target, ...change }, [], dimensions)).toThrow();
  });
});
