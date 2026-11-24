import type { DriverTripSummary } from '../types/driver-trip.types';

export const FALLBACK_DRIVER_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DAY = 86_400_000;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function resolveDriverTimezone(value: string | null | undefined) {
  if (value) {
    try {
      dayFormatter(value);
      return { timeZone: value, isFallback: false };
    } catch {
      // Invalid IANA identifiers use the operating timezone.
    }
  }
  return { timeZone: FALLBACK_DRIVER_TIMEZONE, isFallback: true };
}

export function localDayKey(instant: number, timeZone: string) {
  const parts = dayFormatter(timeZone).formatToParts(instant);
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name)?.value).join('-');
}

export function shiftDay(day: string, days: number) {
  return new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10);
}

export function mondayOf(day: string) {
  const weekday = new Date(day).getUTCDay();
  return shiftDay(day, -((weekday + 6) % 7));
}

export function localMidnight(day: string, timeZone: string) {
  // Find the earliest instant in the local date, including short/long DST days.
  const utc = Date.parse(day);
  let low = utc - 2 * DAY;
  let high = utc + 2 * DAY;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDayKey(middle, timeZone) < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function localDateRange(fromDay: string, toDay: string, timeZone: string) {
  return {
    from: new Date(localMidnight(fromDay, timeZone)).toISOString(),
    to: new Date(localMidnight(toDay, timeZone)).toISOString(),
  };
}

export function formatTripInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export function agendaForDay(trips: DriverTripSummary[], day: string, timeZone: string) {
  const start = localMidnight(day, timeZone);
  const end = localMidnight(shiftDay(day, 1), timeZone);
  return trips.flatMap((trip) => {
    const assignments = (trip.calendarAssignments ?? [trip.assignment]).filter(
      (assignment) => Date.parse(assignment.startTime) < end && Date.parse(assignment.endTime) > start,
    );
    if (!assignments.length) return [];
    return [{
      trip, assignments,
      startsAt: Math.min(...assignments.map((assignment) => Date.parse(assignment.startTime))),
    }];
  }).sort((a, b) => a.startsAt - b.startsAt || a.trip.id.localeCompare(b.trip.id));
}
