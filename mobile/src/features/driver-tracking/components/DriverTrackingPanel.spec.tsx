import { act, fireEvent, render } from '@testing-library/react-native';
import { DriverTrackingPanel } from './DriverTrackingPanel';

describe('M3.6C DriverTrackingPanel', () => {
  const actions = {
    onRetryPermission: jest.fn(async () => undefined),
    onOpenSettings: jest.fn(async () => undefined),
    onFlush: jest.fn(async () => undefined),
    onStartTracking: jest.fn(async () => undefined),
    canStartTracking: false,
    isStartingTracking: false,
  };

  beforeEach(() => jest.clearAllMocks());

  it('hiển thị background active, pending và thời gian sync', async () => {
    const view = await render(
      <DriverTrackingPanel
        {...actions}
        snapshot={{
          mode: 'BACKGROUND',
          tripId: 'trip-1',
          pendingCount: 3,
          lastSyncAt: '2026-11-17T02:00:00.000Z',
          errorCode: null,
          warning: null,
        }}
      />,
    );
    expect(view.getByText('Đang theo dõi cả khi chạy nền')).toBeTruthy();
    expect(view.getByText('Đang chờ đồng bộ 3 điểm')).toBeTruthy();
  });

  it('background denied cho phép mở Settings và thử lại quyền', async () => {
    const view = await render(
      <DriverTrackingPanel
        {...actions}
        snapshot={{
          mode: 'FOREGROUND_ONLY',
          tripId: 'trip-1',
          pendingCount: 0,
          lastSyncAt: null,
          errorCode: null,
          warning: 'BACKGROUND_PERMISSION_DENIED',
        }}
      />,
    );
    await act(async () => {
      fireEvent.press(view.getByText('Kiểm tra lại quyền vị trí'));
      fireEvent.press(view.getByText('Mở Cài đặt'));
      await Promise.resolve();
    });
    expect(
      view.getByText('Chưa được cấp quyền vị trí nền. Ứng dụng chỉ theo dõi khi đang mở.'),
    ).toBeTruthy();
    expect(view.queryByText(/queue đã đạt giới hạn/i)).toBeNull();
    expect(actions.onRetryPermission).toHaveBeenCalled();
    expect(actions.onOpenSettings).toHaveBeenCalled();
  });

  it('chỉ cảnh báo giới hạn queue khi đúng warning code', async () => {
    const view = await render(
      <DriverTrackingPanel
        {...actions}
        snapshot={{
          mode: 'BACKGROUND',
          tripId: 'trip-1',
          pendingCount: 1000,
          lastSyncAt: null,
          errorCode: null,
          warning: 'GPS_QUEUE_LIMIT_REACHED',
        }}
      />,
    );

    expect(view.getByText(/Bộ nhớ đệm GPS đã đạt giới hạn an toàn/i)).toBeTruthy();
  });

  it('cho phép bắt đầu lại tracking khi Trip đang chạy nhưng session đang idle', async () => {
    const view = await render(
      <DriverTrackingPanel
        {...actions}
        canStartTracking
        snapshot={{
          mode: 'IDLE',
          tripId: null,
          pendingCount: 0,
          lastSyncAt: null,
          errorCode: null,
          warning: null,
        }}
      />,
    );

    await act(async () => {
      fireEvent.press(view.getByText('Bắt đầu tracking'));
      await Promise.resolve();
    });

    expect(actions.onStartTracking).toHaveBeenCalledTimes(1);
  });
});
