import type { DriverTripDetail, DriverTripSummary } from '../types/driver-trip.types';

export function canViewDriverStopPhone({ status, assignment }: Pick<DriverTripSummary, 'status' | 'assignment'>) {
  return (status === 'DISPATCHED' || status === 'IN_PROGRESS') &&
    assignment.status === 'ASSIGNED' &&
    (assignment.role === 'PRIMARY' || assignment.role === 'RELIEF');
}

export function normalizeDriverStopPhone(value: string | null): string | null {
  if (!value || /[^0-9+ ().-]/.test(value)) return null;
  const phone = value.replace(/[ ().-]/g, '');
  return /^\+?[0-9]{9,15}$/.test(phone) ? phone : null;
}

export function withoutDriverStopPhones(trip: DriverTripDetail): DriverTripDetail {
  if (!trip.stops.some((stop) => stop.contactPhone !== null)) return trip;
  return { ...trip, stops: trip.stops.map((stop) => ({ ...stop, contactPhone: null })) };
}
