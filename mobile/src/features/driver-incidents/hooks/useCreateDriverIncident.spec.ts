import { act, renderHook } from '@testing-library/react-native';
import * as Crypto from 'expo-crypto';
import { driverIncidentsService } from '@/features/driver-incidents/services/driver-incidents.service';
import { ApiError } from '@/shared/api/api-error';
import { useCreateDriverIncident } from './useCreateDriverIncident';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock(
  '@/features/driver-incidents/services/driver-incidents.service',
  () => ({
    driverIncidentsService: { create: jest.fn() },
  }),
);
jest.mock('@/features/driver-trips/hooks/useDriverTripApiError', () => ({
  useDriverTripApiError: (() => {
    const handler = async (error: unknown) =>
      error instanceof Error ? error.message : 'Lỗi';
    return () => handler;
  })(),
}));

const input = () => ({
  type: 'VEHICLE_BREAKDOWN' as const,
  severity: 'HIGH' as const,
  description: 'Động cơ quá nhiệt, xe cần dừng kiểm tra.',
  occurredAt: new Date().toISOString(),
  affectedOrderIds: ['order-1'],
});

describe('useCreateDriverIncident', () => {
  const reloadIncidents = jest.fn(async () => undefined);
  const reloadTrip = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(Crypto.randomUUID).mockReset();
    jest
      .mocked(Crypto.randomUUID)
      .mockReturnValueOnce('key-1')
      .mockReturnValueOnce('key-2')
      .mockReturnValue('key-next');
  });

  it('create success và refresh Incident list', async () => {
    jest.mocked(driverIncidentsService.create).mockResolvedValue({} as never);
    const { result } = await renderHook(() =>
      useCreateDriverIncident('trip-1', reloadIncidents, reloadTrip),
    );
    await act(async () =>
      expect(await result.current.submit(input())).toBe(true),
    );
    expect(driverIncidentsService.create).toHaveBeenCalledWith(
      'trip-1',
      expect.objectContaining({
        idempotencyKey: 'key-1',
        affectedOrderIds: ['order-1'],
      }),
    );
    expect(reloadIncidents).toHaveBeenCalledTimes(1);
  });

  it('timeout giữ key/payload và retry thủ công dùng cùng key', async () => {
    jest
      .mocked(driverIncidentsService.create)
      .mockRejectedValueOnce(new ApiError('Timeout', 0, 'REQUEST_TIMEOUT'))
      .mockResolvedValueOnce({} as never);
    const { result } = await renderHook(() =>
      useCreateDriverIncident('trip-1', reloadIncidents, reloadTrip),
    );
    const payload = input();
    await act(async () =>
      expect(await result.current.submit(payload)).toBe(false),
    );
    expect(result.current.hasUncertainSubmission).toBe(true);
    await act(async () =>
      expect(await result.current.submit(payload)).toBe(true),
    );
    const calls = jest.mocked(driverIncidentsService.create).mock.calls;
    expect(calls[0]?.[1].idempotencyKey).toBe('key-1');
    expect(calls[1]?.[1].idempotencyKey).toBe('key-1');
  });

  it('payload thay đổi sau timeout dùng key mới', async () => {
    jest
      .mocked(driverIncidentsService.create)
      .mockRejectedValueOnce(new ApiError('Network', 0, 'NETWORK_ERROR'))
      .mockResolvedValueOnce({} as never);
    const { result } = await renderHook(() =>
      useCreateDriverIncident('trip-1', reloadIncidents, reloadTrip),
    );
    await act(async () => void (await result.current.submit(input())));
    await act(
      async () =>
        void (await result.current.submit({
          ...input(),
          description: 'Nội dung đã được chỉnh sửa hợp lệ.',
        })),
    );
    const calls = jest.mocked(driverIncidentsService.create).mock.calls;
    expect(calls[0]?.[1].idempotencyKey).toBe('key-1');
    expect(calls[1]?.[1].idempotencyKey).toBe('key-2');
  });

  it('khóa double tap khi request đang chạy', async () => {
    let resolveRequest: (() => void) | undefined;
    jest.mocked(driverIncidentsService.create).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = () => resolve({} as never);
      }),
    );
    const { result } = await renderHook(() =>
      useCreateDriverIncident('trip-1', reloadIncidents, reloadTrip),
    );
    let first: Promise<boolean>;
    await act(async () => {
      first = result.current.submit(input());
      await expect(result.current.submit(input())).resolves.toBe(false);
    });
    expect(driverIncidentsService.create).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRequest?.();
      await first!;
    });
  });

  it.each(['INVALID_TRIP_STATE', 'INCIDENT_ORDER_NOT_IN_TRIP'])(
    'refetch Trip khi Backend trả %s và giữ form data ở component',
    async (code) => {
      jest
        .mocked(driverIncidentsService.create)
        .mockRejectedValueOnce(new ApiError('Conflict', 409, code));
      const { result } = await renderHook(() =>
        useCreateDriverIncident('trip-1', reloadIncidents, reloadTrip),
      );
      await act(async () =>
        expect(await result.current.submit(input())).toBe(false),
      );
      expect(reloadTrip).toHaveBeenCalledTimes(1);
      expect(result.current.error).toContain(code);
    },
  );
});
