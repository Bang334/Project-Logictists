import { AppState } from 'react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { ordersService } from '@/features/orders/services/orders.service';
import type { CustomerOrderTracking } from '@/features/orders/types/order-tracking.types';
import {
  CUSTOMER_TRACKING_POLL_INTERVAL_MS,
  useCustomerOrderTracking,
} from './useCustomerOrderTracking';

let appStateListener: ((state: 'active' | 'background' | 'inactive') => void) | null = null;

jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (callback: () => void | (() => void)) => {
      React.useEffect(callback, [callback]);
    },
  };
});

jest.mock('@/features/orders/services/orders.service', () => ({
  ordersService: { getCustomerOrderTracking: jest.fn() },
}));

const mockHandleError = jest.fn(async () => 'Không thể kết nối máy chủ.');
jest.mock('./useOrderApiError', () => ({
  useOrderApiError: () => mockHandleError,
}));

const tracking: CustomerOrderTracking = {
  orderId: 'order-1',
  orderStatus: 'IN_TRANSIT',
  trackingStatus: 'AVAILABLE',
  trips: [],
};

describe('M3.6D.2 useCustomerOrderTracking', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    appStateListener = null;
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as typeof appStateListener;
      return { remove: jest.fn() };
    });
    jest.mocked(ordersService.getCustomerOrderTracking).mockResolvedValue(tracking);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('fetch ngay khi screen focus và kết thúc initial loading', async () => {
    const { result } = await renderHook(() => useCustomerOrderTracking('order-1'));

    await waitFor(() => expect(result.current.tracking).toEqual(tracking));
    expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledWith('order-1');
    expect(result.current.isLoading).toBe(false);
  });

  it('poll mỗi 30 giây và không tạo request trùng cùng nhịp', async () => {
    await renderHook(() => useCustomerOrderTracking('order-1'));
    await waitFor(() =>
      expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      jest.advanceTimersByTime(CUSTOMER_TRACKING_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(2);
  });

  it('cleanup timer khi unfocus/unmount', async () => {
    const view = await renderHook(() => useCustomerOrderTracking('order-1'));
    await waitFor(() =>
      expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(1),
    );
    await view.unmount();

    await act(async () => {
      jest.advanceTimersByTime(CUSTOMER_TRACKING_POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });
    expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(1);
  });

  it('dừng background và fetch ngay khi foreground trở lại', async () => {
    await renderHook(() => useCustomerOrderTracking('order-1'));
    await waitFor(() =>
      expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      appStateListener?.('background');
      jest.advanceTimersByTime(CUSTOMER_TRACKING_POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });
    expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(1);

    await act(async () => {
      appStateListener?.('active');
      await Promise.resolve();
    });
    expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(2);

    await act(async () => {
      appStateListener?.('active');
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(CUSTOMER_TRACKING_POLL_INTERVAL_MS);
      await Promise.resolve();
    });
    expect(ordersService.getCustomerOrderTracking).toHaveBeenCalledTimes(3);
  });

  it('giữ snapshot cuối và hiển thị lỗi nhẹ khi polling thất bại', async () => {
    const { result } = await renderHook(() => useCustomerOrderTracking('order-1'));
    await waitFor(() => expect(result.current.tracking).toEqual(tracking));
    jest
      .mocked(ordersService.getCustomerOrderTracking)
      .mockRejectedValueOnce(new Error('network'));

    await act(async () => {
      jest.advanceTimersByTime(CUSTOMER_TRACKING_POLL_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.tracking).toEqual(tracking);
    expect(result.current.error).toBe('Không thể kết nối máy chủ.');
  });
});
