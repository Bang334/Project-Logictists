import { act, fireEvent, render } from '@testing-library/react-native';
import type {
  CustomerOrderTracking,
  CustomerTrackedTrip,
} from '@/features/orders/types/order-tracking.types';
import { CustomerOrderTrackingPanel } from './CustomerOrderTrackingPanel';

const location = {
  latitude: 10.1,
  longitude: 106.1,
  accuracyM: 8,
  measuredAt: '2026-11-17T08:04:30.000Z',
  receivedAt: '2026-11-17T08:04:32.000Z',
  isStale: false,
};

const trip = (overrides: Partial<CustomerTrackedTrip> = {}): CustomerTrackedTrip => ({
  id: 'trip-1',
  tripNumber: 'TRIP-001',
  status: 'IN_PROGRESS',
  version: 4,
  plannedDeliveryAt: '2026-11-17T09:00:00.000Z',
  etaSource: 'PLANNED',
  vehicleLocation: location,
  ...overrides,
});

const available = (trips: CustomerTrackedTrip[]): CustomerOrderTracking => ({
  orderId: 'order-1',
  orderStatus: 'IN_TRANSIT',
  trackingStatus: 'AVAILABLE',
  trips,
});

describe('M3.6D.2 CustomerOrderTrackingPanel', () => {
  const onRetry = jest.fn(async () => undefined);
  const props = {
    isLoading: false,
    isRefreshing: false,
    error: null,
    onRetry,
  };

  beforeEach(() => jest.clearAllMocks());

  it('hiển thị loading riêng', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel {...props} tracking={null} isLoading />,
    );
    expect(view.getByText('Đang tải thông tin theo dõi...')).toBeTruthy();
  });

  it('hiển thị NOT_ASSIGNED như empty state, không phải lỗi', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel
        {...props}
        tracking={{
          orderId: 'order-1',
          orderStatus: 'DRAFT',
          trackingStatus: 'NOT_ASSIGNED',
          trips: [],
        }}
      />,
    );
    expect(
      view.getByText('Đơn hàng chưa được phân công chuyến vận chuyển.'),
    ).toBeTruthy();
  });

  it('render đầy đủ nhiều Trip và không bỏ phần tử sau', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel
        {...props}
        tracking={available([
          trip(),
          trip({ id: 'trip-2', tripNumber: 'TRIP-002', status: 'DISPATCHED' }),
        ])}
      />,
    );
    expect(view.getByText('TRIP-001')).toBeTruthy();
    expect(view.getByText('TRIP-002')).toBeTruthy();
    expect(view.getByText('Đang vận chuyển')).toBeTruthy();
    expect(view.getByText('Đã điều phối')).toBeTruthy();
  });

  it('phân biệt no GPS, stale và fresh', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel
        {...props}
        tracking={available([
          trip({ id: 'no-gps', tripNumber: 'NO-GPS', vehicleLocation: null }),
          trip({
            id: 'stale',
            tripNumber: 'STALE',
            vehicleLocation: { ...location, isStale: true },
          }),
          trip({ id: 'fresh', tripNumber: 'FRESH' }),
        ])}
      />,
    );
    expect(view.getByText('Chưa có dữ liệu vị trí.')).toBeTruthy();
    expect(view.getByText('Vị trí có thể đã cũ.')).toBeTruthy();
    expect(view.getByText('Vị trí vừa được cập nhật.')).toBeTruthy();
  });

  it('Trip completed dùng wording vị trí cuối, không gọi là vị trí hiện tại', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel
        {...props}
        tracking={available([trip({ status: 'COMPLETED' })])}
      />,
    );
    expect(view.getByText('Vị trí cuối của chuyến')).toBeTruthy();
    expect(view.queryByText(/Vị trí hiện tại/i)).toBeNull();
  });

  it('plannedDeliveryAt null và status lạ có fallback an toàn', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel
        {...props}
        tracking={available([
          trip({ plannedDeliveryAt: null, status: 'UNRECOGNIZED' }),
        ])}
      />,
    );
    expect(view.getByText('Chưa có thời gian giao dự kiến')).toBeTruthy();
    expect(view.getByText('Trạng thái chưa xác định')).toBeTruthy();
  });

  it('lỗi polling giữ dữ liệu cũ và cho phép retry', async () => {
    const view = await render(
      <CustomerOrderTrackingPanel
        {...props}
        tracking={available([trip()])}
        error="Không thể kết nối máy chủ."
      />,
    );
    expect(view.getByText('TRIP-001')).toBeTruthy();
    expect(view.getByText(/Không thể cập nhật dữ liệu mới/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText('Thử tải lại tracking'));
      await Promise.resolve();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
