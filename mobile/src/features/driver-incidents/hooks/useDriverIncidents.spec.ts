import { act, renderHook, waitFor } from '@testing-library/react-native';
import { driverIncidentsService } from '@/features/driver-incidents/services/driver-incidents.service';
import { useDriverIncidents } from './useDriverIncidents';

jest.mock(
  '@/features/driver-incidents/services/driver-incidents.service',
  () => ({
    driverIncidentsService: { getPage: jest.fn() },
  }),
);
jest.mock('@/features/driver-trips/hooks/useDriverTripApiError', () => ({
  useDriverTripApiError: (() => {
    const handler = async (error: unknown) =>
      error instanceof Error ? error.message : 'Lỗi tải sự cố';
    return () => handler;
  })(),
}));

const item = (id: string) => ({ id }) as never;

describe('useDriverIncidents', () => {
  beforeEach(() => jest.clearAllMocks());

  it('initial load, load more và reload page 1', async () => {
    jest
      .mocked(driverIncidentsService.getPage)
      .mockResolvedValueOnce({
        items: [item('one')],
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        items: [item('two')],
        page: 2,
        limit: 20,
        total: 2,
        totalPages: 2,
      })
      .mockResolvedValueOnce({
        items: [item('fresh')],
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    const { result } = await renderHook(() => useDriverIncidents('trip-1'));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => void (await result.current.loadMore()));
    expect(result.current.items).toHaveLength(2);
    await act(async () => void (await result.current.reload()));
    expect(result.current.items[0]?.id).toBe('fresh');
  });

  it('cô lập lỗi list trong hook', async () => {
    jest
      .mocked(driverIncidentsService.getPage)
      .mockRejectedValue(new Error('API incident lỗi'));
    const { result } = await renderHook(() => useDriverIncidents('trip-1'));
    await waitFor(() => expect(result.current.error).toBe('API incident lỗi'));
    expect(result.current.items).toEqual([]);
  });
});
