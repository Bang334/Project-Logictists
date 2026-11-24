import { act, renderHook } from '@testing-library/react-native';
import { jwtExpiry } from '@/features/auth/services/offline-driver-identity';
import { tokenStorage } from '@/shared/storage/token-storage';
import { driverTripsService, parseDriverTripDetail } from '../services/driver-trips.service';
import { useDriverTripDetail } from './useDriverTripDetail';

jest.mock('@/shared/storage/token-storage', () => ({ tokenStorage: { get: jest.fn() } }));
jest.mock('@/features/auth/services/offline-driver-identity', () => ({
  jwtExpiry: jest.fn(), offlineDriverIdentity: { read: async () => null },
}));
jest.mock('../storage/offline-trip-snapshots', () => ({ offlineTripSnapshots: {} }));
jest.mock('./useDriverTripApiError', () => ({ useDriverTripApiError: () => String }));

it('redacts the phone when JWT expires in an already mounted workspace', async () => {
  jest.useFakeTimers();
  const date = '2026-11-21T12:00:00.000Z';
  const detail = parseDriverTripDetail({
    id: 'trip-1', tripNumber: 'QA', status: 'IN_PROGRESS', version: 2, stopCount: 1,
    plannedStartTime: date, plannedEndTime: date, actualStartTime: date, actualEndTime: null,
    totalDistanceKm: 0, totalDurationMinutes: 0,
    assignment: { id: 'assignment', status: 'ASSIGNED', role: 'PRIMARY', startTime: date, endTime: date },
    vehicle: { id: 'vehicle', plateNumber: 'QA', model: 'QA', vehicleType: 'TRUCK' },
    stops: [{ id: 'stop-1', sequence: 1, stopType: 'PICKUP', status: 'ARRIVED', address: 'QA',
      latitude: 1, longitude: 2, contactName: 'QA', contactPhone: '0900000001',
      plannedArrivalTime: null, plannedDepartureTime: null, actualArrivalTime: date, actualDepartureTime: null, tasks: [] }],
  });
  jest.mocked(tokenStorage.get).mockResolvedValue('test-token');
  jest.mocked(jwtExpiry).mockReturnValue(Date.now() + 1000);
  const request = jest.spyOn(driverTripsService, 'getTrip').mockResolvedValue(detail);
  try {
    const { result, unmount } = await renderHook(() => useDriverTripDetail('trip-1'));
    await act(async () => { await result.current.reload(); });
    expect(result.current.trip?.stops[0]?.contactPhone).toBe('0900000001');
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(result.current.trip?.stops[0]?.contactPhone).toBeNull();
    expect(result.current.trip?.version).toBe(2);
    expect(request).toHaveBeenCalledTimes(1);
    await unmount();
  } finally {
    request.mockRestore();
    jest.useRealTimers();
  }
});
