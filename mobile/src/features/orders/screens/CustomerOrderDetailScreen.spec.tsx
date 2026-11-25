import { render } from '@testing-library/react-native';
import { useCustomerOrderDetail } from '@/features/orders/hooks/useCustomerOrderDetail';
import { useCustomerOrderTracking } from '@/features/orders/hooks/useCustomerOrderTracking';
import { CustomerOrderDetailScreen } from './CustomerOrderDetailScreen';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'order-1' }),
  useFocusEffect: (callback: () => void) => {
    jest.requireActual<typeof import('react')>('react').useEffect(callback, [callback]);
  },
}));

jest.mock('@/features/orders/hooks/useCustomerOrderDetail', () => ({
  useCustomerOrderDetail: jest.fn(),
}));

jest.mock('@/features/orders/hooks/useCustomerOrderTracking', () => ({
  useCustomerOrderTracking: jest.fn(),
}));

jest.mock('@/features/orders/components/OrderScreenHeader', () => ({
  OrderScreenHeader: ({ title }: { title: string }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text>{title}</Text>;
  },
}));

jest.mock('@/features/orders/components/CustomerOrderTrackingPanel', () => ({
  CustomerOrderTrackingPanel: ({ error }: { error: string | null }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text testID="tracking-panel-probe">{error ?? 'tracking-ok'}</Text>;
  },
}));

describe('M3.6D.2 CustomerOrderDetailScreen integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(useCustomerOrderDetail).mockReturnValue({
      order: {
        id: 'order-1',
        orderNumber: 'ORD-CUS-001',
        status: 'IN_TRANSIT',
        version: 3,
        notes: null,
        totalPackages: 1,
        totalWeightKg: 10,
        totalVolumeM3: 0.01,
        orderedAt: '2026-11-17T01:00:00.000Z',
        createdAt: '2026-11-17T01:00:00.000Z',
        updatedAt: '2026-11-17T01:00:00.000Z',
        stops: [],
        items: [],
      },
      isLoading: false,
      error: null,
      reload: jest.fn(async () => undefined),
    });
    jest.mocked(useCustomerOrderTracking).mockReturnValue({
      tracking: null,
      isLoading: false,
      isRefreshing: false,
      error: 'Không thể cập nhật tracking.',
      retry: jest.fn(async () => undefined),
    });
  });

  it('Order Detail vẫn hiển thị đầy đủ khi tracking lỗi riêng', async () => {
    const view = await render(<CustomerOrderDetailScreen />);

    expect(view.getByText('ORD-CUS-001')).toBeTruthy();
    expect(view.getByTestId('tracking-panel-probe').props.children).toBe(
      'Không thể cập nhật tracking.',
    );
  });
  it('refetches the authoritative order once per mismatched tracking snapshot', async () => {
    const detail = jest.mocked(useCustomerOrderDetail)('order-1');
    const tracking = jest.mocked(useCustomerOrderTracking);
    tracking.mockReturnValue({
      ...tracking('order-1'),
      tracking: { orderId: 'order-1', orderStatus: 'ASSIGNED', trackingStatus: 'AVAILABLE', trips: [] },
    });

    const view = await render(<CustomerOrderDetailScreen />);
    expect(detail.reload).toHaveBeenCalledTimes(2); // Focus and Order status mismatch.

    await view.rerender(<CustomerOrderDetailScreen />);
    expect(detail.reload).toHaveBeenCalledTimes(2);
    expect(view.getByText('Đang vận chuyển')).toBeTruthy();
    expect(view.queryByText('Đã phân chuyến')).toBeNull();

    jest.mocked(useCustomerOrderDetail).mockReturnValue({
      ...detail,
      order: { ...detail.order!, status: 'ASSIGNED', version: 4 },
    });
    await view.rerender(<CustomerOrderDetailScreen />);
    expect(detail.reload).toHaveBeenCalledTimes(2);
    expect(view.getByText('Đã phân chuyến')).toBeTruthy();
  });

});
