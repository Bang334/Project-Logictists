import {
  stopOfflinePresentation,
  type OfflineStopPresentation,
} from '@/features/driver-offline/selectors/offline-driver-overlay';
import type { OfflineDriverCommand } from '@/features/driver-offline/types/offline-driver-command.types';
import type { DriverTripStop } from '../types/driver-trip.types';

export const stopListFilters = {
  ALL: 'Tất cả',
  TODO: 'Chưa thực hiện',
  ACTIVE: 'Đang xử lý',
  COMPLETE: 'Đã hoàn thành',
  ATTENTION: 'Cần chú ý',
} as const;

export type StopListFilter = keyof typeof stopListFilters;

function normalize(value: string) {
  return value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd');
}

export function buildStopListRows(stops: DriverTripStop[], commands: OfflineDriverCommand[]) {
  const commandsByStop = new Map<string, OfflineDriverCommand[]>();
  for (const command of commands) {
    const matching = commandsByStop.get(command.stopId);
    if (matching) matching.push(command);
    else commandsByStop.set(command.stopId, [command]);
  }

  return [...stops]
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
    .map((stop) => ({
      stop,
      overlay: stopOfflinePresentation(stop.id, commandsByStop.get(stop.id) ?? []),
      searchText: normalize([stop.address, stop.contactName, stop.contactPhone].filter(Boolean).join(' ')),
      phoneDigits: stop.contactPhone?.replace(/\D/g, '') ?? '',
    }));
}

export type StopListRow = ReturnType<typeof buildStopListRows>[number];

function stopListCategory(stop: DriverTripStop, overlay: OfflineStopPresentation): StopListFilter {
  if (overlay === 'FAILED' || overlay === 'CONFLICT' || stop.status === 'SKIPPED') return 'ATTENTION';
  if (overlay !== 'SERVER_CONFIRMED' || stop.status === 'ARRIVED') return 'ACTIVE';
  return stop.status === 'COMPLETED' ? 'COMPLETE' : 'TODO';
}

export function filterStopListRows(rows: StopListRow[], filter: StopListFilter, query: string) {
  const text = normalize(query);
  const sequence = /^#?\d+$/.test(text) ? Number(text.replace('#', '')) : null;
  const phone = /^[+\d .()-]+$/.test(text) ? text.replace(/\D/g, '') : '';
  return rows.filter(({ stop, overlay, searchText, phoneDigits }) =>
    (filter === 'ALL' || stopListCategory(stop, overlay) === filter) &&
    (!text || stop.sequence === sequence || searchText.includes(text) || (!!phone && phoneDigits.includes(phone))),
  );
}
