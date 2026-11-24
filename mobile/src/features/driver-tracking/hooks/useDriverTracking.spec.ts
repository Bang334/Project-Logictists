import { act, renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { driverTrackingService } from '@/features/driver-tracking/services/driver-tracking.service';
import { useDriverTracking } from './useDriverTracking';

jest.mock('@/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: 'DRIVER' } }),
}));
jest.mock('@/features/driver-tracking/services/driver-tracking.service', () => ({
  driverTrackingService: {
    subscribe: jest.fn(() => jest.fn()),
    getSnapshot: jest.fn(),
    beginAfterStart: jest.fn(),
    completeAfterSuccess: jest.fn(),
    reconcileUncertainComplete: jest.fn(),
    retryPermissions: jest.fn(),
    flushForUser: jest.fn(),
    openSettings: jest.fn(),
  },
}));

describe('M3.6C useDriverTracking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(driverTrackingService.getSnapshot).mockReturnValue({
      mode: 'IDLE',
      tripId: null,
      pendingCount: 0,
      lastSyncAt: null,
      errorCode: null,
      warning: null,
    });
    jest.mocked(driverTrackingService.beginAfterStart).mockResolvedValue();
  });

  it('giải thích quyền sau START success và chỉ xin khi Driver đồng ý', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[1]?.onPress?.();
    });
    const { result } = await renderHook(() => useDriverTracking('trip-1'));
    await act(async () => {
      await result.current.lifecycle.onTripStarted({
        id: 'trip-1',
        status: 'IN_PROGRESS',
        version: 2,
      });
    });
    expect(driverTrackingService.beginAfterStart).toHaveBeenCalledWith(
      'user-1',
      'trip-1',
      true,
    );
  });

  it('Driver để sau vẫn persist session nhưng không bật permission loop', async () => {
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.[0]?.onPress?.();
    });
    const { result } = await renderHook(() => useDriverTracking('trip-1'));
    await act(async () => {
      await result.current.lifecycle.onTripStarted({
        id: 'trip-1',
        status: 'IN_PROGRESS',
        version: 2,
      });
    });
    expect(driverTrackingService.beginAfterStart).toHaveBeenCalledWith(
      'user-1',
      'trip-1',
      false,
    );
  });

  it('nút manual cho phép hỏi lại sau khi Driver từng chọn để sau', async () => {
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementationOnce((_title, _message, buttons) => {
        buttons?.[0]?.onPress?.();
      })
      .mockImplementationOnce((_title, _message, buttons) => {
        buttons?.[1]?.onPress?.();
      });
    const { result } = await renderHook(() => useDriverTracking('trip-1'));

    await act(async () => {
      await result.current.startTracking();
    });
    expect(driverTrackingService.beginAfterStart).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.startTracking();
    });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(driverTrackingService.beginAfterStart).toHaveBeenCalledWith(
      'user-1',
      'trip-1',
      true,
    );
  });

  it('COMPLETE success truyền actualEndTime để flush backlog', async () => {
    const { result } = await renderHook(() => useDriverTracking('trip-1'));
    await act(async () => {
      await result.current.lifecycle.onTripCompleted({
        id: 'trip-1',
        status: 'COMPLETED',
        version: 9,
        actualEndTime: '2026-11-17T02:00:00.000Z',
      });
    });
    expect(driverTrackingService.completeAfterSuccess).toHaveBeenCalledWith(
      'user-1',
      'trip-1',
      '2026-11-17T02:00:00.000Z',
    );
  });
});
