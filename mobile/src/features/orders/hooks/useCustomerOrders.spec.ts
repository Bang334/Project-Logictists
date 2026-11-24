import { act, renderHook } from '@testing-library/react-native';
import { ordersService } from '@/features/orders/services/orders.service';
import { useCustomerOrders } from './useCustomerOrders';

const mockHandleError = jest.fn(async (error: unknown) =>
  error instanceof Error ? error.message : 'Lỗi',
);

jest.mock('@/features/orders/services/orders.service', () => ({
  ordersService: { getOrders: jest.fn() },
}));

jest.mock('./useOrderApiError', () => ({
  useOrderApiError: () => mockHandleError,
}));

describe('useCustomerOrders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(ordersService.getOrders).mockResolvedValue({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 0,
    });
  });

  it('giữ reload/refresh ổn định qua render để useFocusEffect không lặp vô hạn', async () => {
    const { result, rerender } = await renderHook(() =>
      useCustomerOrders('ALL'),
    );
    const firstReload = result.current.reload;
    const firstRefresh = result.current.refresh;

    await rerender(undefined);

    expect(result.current.reload).toBe(firstReload);
    expect(result.current.refresh).toBe(firstRefresh);
  });

  it('reload một lần chỉ gọi một request và kết thúc loading', async () => {
    const { result } = await renderHook(() => useCustomerOrders('DRAFT'));

    await act(async () => {
      await result.current.reload();
    });

    expect(ordersService.getOrders).toHaveBeenCalledTimes(1);
    expect(ordersService.getOrders).toHaveBeenCalledWith(1, 20, 'DRAFT');
    expect(result.current.isInitialLoading).toBe(false);
  });
});
