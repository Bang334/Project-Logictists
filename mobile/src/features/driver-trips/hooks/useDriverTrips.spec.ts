import { act, renderHook } from '@testing-library/react-native';
import { driverTripsService } from '@/features/driver-trips/services/driver-trips.service';
import type { DriverTripSummary } from '@/features/driver-trips/types/driver-trip.types';
import { useDriverTrips } from './useDriverTrips';

const mockHandleError = jest.fn(async () => 'Không tải được chuyến');

jest.mock('@/features/driver-trips/services/driver-trips.service', () => ({
  driverTripsService: { getTrips: jest.fn() },
}));

jest.mock('./useDriverTripApiError', () => ({
  useDriverTripApiError: () => mockHandleError,
}));

const trip = (id: string): DriverTripSummary => ({
  id,
  tripNumber: id,
  status: 'DISPATCHED',
  version: 1,
  plannedStartTime: '2026-11-16T01:00:00.000Z',
  plannedEndTime: '2026-11-16T03:00:00.000Z',
  actualStartTime: null,
  actualEndTime: null,
  totalDistanceKm: 10,
  totalDurationMinutes: 60,
  vehicle: { id: 'v', plateNumber: '43C', model: 'Hino', vehicleType: 'Truck' },
  assignment: {
    id: 'a',
    role: 'PRIMARY',
    status: 'ASSIGNED',
    startTime: '2026-11-16T01:00:00.000Z',
    endTime: '2026-11-16T03:00:00.000Z',
  },
  stopCount: 2,
});

describe('useDriverTrips', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(driverTripsService.getTrips).mockResolvedValue({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it('reload/filter và refresh dùng đúng contract, callback ổn định', async () => {
    const { result, rerender } = await renderHook(() =>
      useDriverTrips('IN_PROGRESS'),
    );
    const firstReload = result.current.reload;
    const firstRefresh = result.current.refresh;

    await act(async () => result.current.reload());
    await act(async () => result.current.refresh());
    await rerender(undefined);

    expect(driverTripsService.getTrips).toHaveBeenNthCalledWith(
      1,
      1,
      20,
      'IN_PROGRESS',
    );
    expect(driverTripsService.getTrips).toHaveBeenNthCalledWith(
      2,
      1,
      20,
      'IN_PROGRESS',
    );
    expect(result.current.reload).toBe(firstReload);
    expect(result.current.refresh).toBe(firstRefresh);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('phân trang nối dữ liệu và loại ID trùng', async () => {
    jest.mocked(driverTripsService.getTrips)
      .mockResolvedValueOnce({
        items: [trip('trip-1')],
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        items: [trip('trip-1'), trip('trip-2')],
        page: 2,
        limit: 20,
        total: 2,
        totalPages: 2,
      });
    const { result } = await renderHook(() => useDriverTrips('ALL'));

    await act(async () => result.current.reload());
    expect(result.current.hasMore).toBe(true);
    await act(async () => result.current.loadMore());

    expect(driverTripsService.getTrips).toHaveBeenLastCalledWith(
      2,
      20,
      undefined,
    );
    expect(result.current.trips.map((item) => item.id)).toEqual([
      'trip-1',
      'trip-2',
    ]);
  });

  it('giữ empty state và thông báo lỗi khi request thất bại', async () => {
    jest.mocked(driverTripsService.getTrips).mockRejectedValue(new Error('fail'));
    const { result } = await renderHook(() => useDriverTrips('ALL'));

    await act(async () => result.current.reload());

    expect(result.current.trips).toEqual([]);
    expect(result.current.error).toBe('Không tải được chuyến');
    expect(result.current.isInitialLoading).toBe(false);
  });

  it('giữ trang đầu khi tải thêm lỗi và retry đúng trang', async () => {
    jest.mocked(driverTripsService.getTrips)
      .mockResolvedValueOnce({ items: [trip('trip-1')], page: 1, limit: 20, total: 2, totalPages: 2 })
      .mockRejectedValueOnce(new Error('page unavailable'))
      .mockResolvedValueOnce({ items: [trip('trip-2')], page: 2, limit: 20, total: 2, totalPages: 2 });
    const { result } = await renderHook(() => useDriverTrips('ALL'));
    await act(async () => result.current.reload());
    await act(async () => result.current.loadMore());
    expect(result.current.trips.map((item) => item.id)).toEqual(['trip-1']);
    expect(result.current.loadMoreError).toBe('Không tải được chuyến');
    expect(result.current.error).toBeNull();
    await act(async () => result.current.loadMore());
    expect(driverTripsService.getTrips).toHaveBeenLastCalledWith(2, 20, undefined);
    expect(result.current.trips.map((item) => item.id)).toEqual(['trip-1', 'trip-2']);
  });

  it('focus reload lỗi mạng vẫn giữ snapshot của filter đang xem', async () => {
    jest.mocked(driverTripsService.getTrips)
      .mockResolvedValueOnce({ items: [trip('trip-1')], page: 1, limit: 20, total: 1, totalPages: 1 })
      .mockRejectedValueOnce(new Error('offline'));
    const { result } = await renderHook(() => useDriverTrips('DISPATCHED'));
    await act(async () => result.current.reload());
    await act(async () => result.current.reload());
    expect(result.current.trips).toHaveLength(1);
    expect(result.current.hasSnapshot).toBe(true);
    expect(result.current.error).toBe('Không tải được chuyến');
  });
});
