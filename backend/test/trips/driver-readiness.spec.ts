import { driverArrivalEvidence, assertDriverArrivalCurrent } from '../../src/trips/driver-readiness';

describe('driver readiness', () => {
  const departure = new Date('2031-01-01T16:00:00Z');
  const shift = { id: 'shift', version: 2, status: 'ACTIVE', readyAt: new Date(+departure - 60000), readyAddress: 'Independent driver point', readyLatitude: 0, readyLongitude: 0 };
  const depot = { latitude: 1, longitude: 2 };
  it('accepts zero coordinates and exact arrival boundary using provider duration', async () => {
    const map = { getRoute: jest.fn().mockResolvedValue({ durationMinutes: 1 }) };
    const db = { driverShift: { findFirst: jest.fn().mockResolvedValue(shift), findUnique: jest.fn().mockResolvedValue(shift) } };
    const evidence = await driverArrivalEvidence(db as never, map as never, 'driver', departure, depot);
    expect(map.getRoute).toHaveBeenCalledWith([[0, 0], [2, 1]]);
    expect(evidence.travelSeconds).toBe(60);
    await expect(assertDriverArrivalCurrent(db as never, evidence)).resolves.toBeUndefined();
    db.driverShift.findUnique.mockResolvedValue({ ...shift, version: 3 });
    await expect(assertDriverArrivalCurrent(db as never, evidence)).rejects.toThrow('đã thay đổi');
  });
  it('rejects arrival one second late without rounding to a minute', async () => {
    await expect(driverArrivalEvidence({ driverShift: { findFirst: async () => shift } } as never,
      { getRoute: async () => ({ durationMinutes: 61 / 60 }) } as never,
      'driver', departure, depot)).rejects.toThrow('không đủ thời gian');
  });
  it('never substitutes depot coordinates for an unknown driver position', async () => {
    const map = { getRoute: jest.fn() };
    await expect(driverArrivalEvidence({ driverShift: { findFirst: async () => ({ ...shift, readyLatitude: null }) } } as never,
      map as never, 'driver', departure, depot)).rejects.toThrow('chưa có điểm');
    expect(map.getRoute).not.toHaveBeenCalled();
  });
});
