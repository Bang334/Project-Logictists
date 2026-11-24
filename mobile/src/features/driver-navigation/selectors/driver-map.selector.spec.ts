import { selectDriverMapLocation, selectDriverMapMarkers } from './driver-map.selector';
import type { OfflineDriverCommand } from '@/features/driver-offline/types/offline-driver-command.types';
import type { DriverTripStop } from '@/features/driver-trips/types/driver-trip.types';

function stop(id: string, sequence: number, values: Partial<DriverTripStop> = {}): DriverTripStop {
  return {
    id, sequence, stopType: 'PICKUP', status: 'PENDING', address: `Điểm ${sequence}`,
    latitude: 10 + sequence, longitude: 106 + sequence, contactName: null,
    contactPhone: null, plannedArrivalTime: null, plannedDepartureTime: null,
    actualArrivalTime: null, actualDepartureTime: null, tasks: [], ...values,
  };
}

function command(stopId: string, state: OfflineDriverCommand['state'], commandType: OfflineDriverCommand['commandType'] = 'ARRIVE_STOP'): OfflineDriverCommand {
  return {
    id: `${stopId}-${state}`, ownerUserId: 'user-1', tripId: 'trip-1', stopId,
    commandType, sequence: 1, idempotencyKey: 'key',
    payload: commandType === 'ARRIVE_STOP' ? { kind: 'ARRIVE_STOP' } : { kind: 'COMPLETE_STOP', tasks: [] },
    payloadFingerprint: 'hash', observedTripVersion: 1, wireExpectedVersion: null,
    transmissionState: 'NEVER_SENT', state, occurredAt: '2026-11-19T00:00:00.000Z',
    retryCount: 0, nextRetryAt: null, lastErrorCode: null, lastErrorMessage: null,
    serverResult: null, createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z', syncedAt: null,
  };
}

describe('driver map selector', () => {
  it('sắp marker ổn định, hỗ trợ đủ loại stop và bỏ tọa độ không hợp lệ', () => {
    const result = selectDriverMapMarkers({
      status: 'IN_PROGRESS',
      stops: [
        stop('delivery', 3, { stopType: 'DELIVERY' }),
        stop('depot-start', 1, { stopType: 'DEPOT_START', status: 'COMPLETED' }),
        stop('pickup', 2, { stopType: 'PICKUP' }),
        stop('depot-end', 4, { stopType: 'DEPOT_END' }),
        stop('invalid', 5, { latitude: 91 }),
      ],
    }, []);
    expect(result.markers.map(({ id, state }) => [id, state])).toEqual([
      ['depot-start', 'COMPLETED'], ['pickup', 'CURRENT'],
      ['delivery', 'UPCOMING'], ['depot-end', 'UPCOMING'],
    ]);
    expect(result.invalidCoordinateCount).toBe(1);
    expect(result.markers[1]?.accessibilityLabel).toContain('Điểm lấy hàng');
  });

  it('ưu tiên state chờ đồng bộ và xung đột thay vì chỉ dựa vào server', () => {
    const trip = { status: 'IN_PROGRESS' as const, stops: [stop('one', 1), stop('two', 2)] };
    expect(selectDriverMapMarkers(trip, [command('one', 'PENDING')]).markers[0]?.state).toBe('PENDING_SYNC');
    expect(selectDriverMapMarkers(trip, [command('one', 'CONFLICT')]).markers[0]?.state).toBe('CONFLICT');
  });

  it('phân biệt vị trí mới, cũ, thiếu và không hợp lệ', () => {
    const now = new Date('2026-11-19T03:10:00.000Z').getTime();
    expect(selectDriverMapLocation(null, now)).toBeNull();
    expect(selectDriverMapLocation({ latitude: 10, longitude: 106, measuredAt: '2026-11-19T03:09:00.000Z' }, now)?.isStale).toBe(false);
    expect(selectDriverMapLocation({ latitude: 10, longitude: 106, measuredAt: '2026-11-19T03:07:00.000Z' }, now)?.isStale).toBe(true);
    expect(selectDriverMapLocation({ latitude: 100, longitude: 106, measuredAt: '2026-11-19T03:09:00.000Z' }, now)).toBeNull();
  });
});
