import {
  DRIVER_INCIDENT_SEVERITIES,
  DRIVER_INCIDENT_TYPES,
  type CreateDriverIncidentInput,
} from '@/features/driver-incidents/types/driver-incident.types';
import type { DriverTripDetail } from '@/features/driver-trips/types/driver-trip.types';
import {
  getTripIncidentOrderOptions,
  validateDriverIncidentInput,
} from './driver-incident.validation';

const now = new Date('2026-11-18T02:00:00.000Z');
const valid = (): CreateDriverIncidentInput => ({
  type: 'VEHICLE_BREAKDOWN',
  severity: 'MEDIUM',
  description: '  Mô tả sự cố có đủ độ dài.  ',
  occurredAt: now.toISOString(),
  affectedOrderIds: [],
});

describe('driver incident validation', () => {
  it.each(DRIVER_INCIDENT_TYPES)('chấp nhận type %s', (type) => {
    expect(
      validateDriverIncidentInput({ ...valid(), type }, now).value?.type,
    ).toBe(type);
  });

  it.each(DRIVER_INCIDENT_SEVERITIES)('chấp nhận severity %s', (severity) => {
    expect(
      validateDriverIncidentInput({ ...valid(), severity }, now).value
        ?.severity,
    ).toBe(severity);
  });

  it('trim description và sort affected Orders', () => {
    const result = validateDriverIncidentInput(
      { ...valid(), affectedOrderIds: ['order-b', 'order-a'] },
      now,
    );
    expect(result.value).toMatchObject({
      description: 'Mô tả sự cố có đủ độ dài.',
      affectedOrderIds: ['order-a', 'order-b'],
    });
  });

  it.each([
    { description: 'quá ngắn' },
    { description: 'x'.repeat(2001) },
    { occurredAt: new Date(now.getTime() + 6 * 60 * 1000).toISOString() },
    { occurredAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() },
    { occurredAt: 'invalid' },
    { affectedOrderIds: ['same', 'same'] },
    {
      affectedOrderIds: Array.from(
        { length: 101 },
        (_, index) => `order-${index}`,
      ),
    },
  ])('từ chối dữ liệu không hợp lệ %#', (override) => {
    expect(
      validateDriverIncidentInput({ ...valid(), ...override }, now).value,
    ).toBeUndefined();
  });

  it('cho phép không chọn, một hoặc nhiều Order', () => {
    for (const affectedOrderIds of [[], ['a'], ['a', 'b']]) {
      expect(
        validateDriverIncidentInput({ ...valid(), affectedOrderIds }, now)
          .value,
      ).toBeDefined();
    }
  });
});

describe('getTripIncidentOrderOptions', () => {
  it('lấy unique Order từ StopTask và không đưa Customer data vào option', () => {
    const order = { id: 'order-1', orderNumber: 'ORD-001' };
    const trip = {
      stops: [
        { tasks: [{ order }, { order: null }] },
        {
          tasks: [
            { order },
            { order: { id: 'order-2', orderNumber: 'ORD-002' } },
          ],
        },
      ],
    } as DriverTripDetail;
    expect(getTripIncidentOrderOptions(trip)).toEqual([
      order,
      { id: 'order-2', orderNumber: 'ORD-002' },
    ]);
  });
});
