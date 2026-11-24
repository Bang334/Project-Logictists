import type { DriverTripSummary } from '../types/driver-trip.types';
import { agendaForDay, localDateRange, localDayKey, mondayOf, resolveDriverTimezone } from './driver-schedule-dates';

it('starts Monday in the operational timezone and uses actual UTC boundaries', () => {
  const zone = resolveDriverTimezone('Asia/Ho_Chi_Minh').timeZone;
  expect(localDayKey(Date.parse('2026-11-22T18:00:00Z'), zone)).toBe('2026-11-23');
  expect(mondayOf('2026-11-29')).toBe('2026-11-23');
  expect(localDateRange('2026-11-23', '2026-11-30', zone)).toEqual({
    from: '2026-11-22T17:00:00.000Z', to: '2026-11-29T17:00:00.000Z',
  });
});

it('keeps local midnights across DST and flags invalid/missing timezone fallback', () => {
  expect(localDateRange('2026-03-08', '2026-03-09', 'America/New_York')).toEqual({
    from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z',
  });
  expect(resolveDriverTimezone('Invalid/Zone')).toEqual({ timeZone: 'Asia/Ho_Chi_Minh', isFallback: true });
  expect(resolveDriverTimezone(null).isFallback).toBe(true);
});

it('shows overnight only once on each covered day and excludes an exact midnight end', () => {
  const overnight = { id: 'first', role: 'RELIEF', status: 'ASSIGNED',
    startTime: '2026-11-23T16:00:00Z', endTime: '2026-11-23T18:00:00Z' };
  const dayTwo = { ...overnight, id: 'second', startTime: '2026-11-24T01:00:00Z', endTime: '2026-11-24T17:00:00Z' };
  const trip: DriverTripSummary = { id: 'trip', tripNumber: 'TEST', version: 1, status: 'DISPATCHED', stopCount: 0,
    plannedStartTime: overnight.startTime, plannedEndTime: dayTwo.endTime, actualStartTime: null, actualEndTime: null,
    totalDistanceKm: 0, totalDurationMinutes: 0, assignment: overnight, calendarAssignments: [overnight, dayTwo],
    vehicle: { id: 'vehicle', plateNumber: 'test', model: 'test', vehicleType: 'test' } };
  expect(agendaForDay([trip], '2026-11-23', 'Asia/Ho_Chi_Minh')[0]?.assignments).toEqual([overnight]);
  const next = agendaForDay([trip], '2026-11-24', 'Asia/Ho_Chi_Minh');
  expect(next).toHaveLength(1);
  expect(next[0]?.assignments).toEqual([overnight, dayTwo]);
  expect(agendaForDay([trip], '2026-11-25', 'Asia/Ho_Chi_Minh')).toEqual([]);
});
