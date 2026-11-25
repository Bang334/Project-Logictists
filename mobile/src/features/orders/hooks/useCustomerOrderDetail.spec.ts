import { act, renderHook } from '@testing-library/react-native';
import { ordersService } from '@/features/orders/services/orders.service';
import type { CustomerOrderDetail } from '@/features/orders/types/order.types';
import { useCustomerOrderDetail } from './useCustomerOrderDetail';

jest.mock('@/features/orders/services/orders.service', () => ({
  ordersService: { getOrder: jest.fn() },
}));
jest.mock('./useOrderApiError', () => {
  const handleError = jest.fn(async () => 'Request failed');
  return { useOrderApiError: () => handleError };
});

const currentOrder: CustomerOrderDetail = {
  id: 'order-1',
  orderNumber: 'ORD-1',
  status: 'COMPLETED',
  version: 4,
  notes: null,
  totalPackages: 1,
  totalWeightKg: 2,
  totalVolumeM3: 0.008,
  orderedAt: '2026-11-24T10:00:00.000Z',
  createdAt: '2026-11-24T10:00:00.000Z',
  updatedAt: '2026-11-24T10:02:00.000Z',
  stops: [],
  items: [],
};
const previousOrder: CustomerOrderDetail = { ...currentOrder, status: 'ASSIGNED', version: 3 };

it('ignores an older request that finishes after the newer reload', async () => {
  let finishEarlierRequest!: (value: CustomerOrderDetail) => void;
  const earlierResponse = new Promise<CustomerOrderDetail>((resolve) => {
    finishEarlierRequest = resolve;
  });
  jest.mocked(ordersService.getOrder).mockResolvedValueOnce(earlierResponse).mockResolvedValueOnce(currentOrder);
  const { result } = await renderHook(() => useCustomerOrderDetail('order-1'));

  let earlierReload!: Promise<void>;
  await act(() => { earlierReload = result.current.reload(); });
  await act(() => result.current.reload());
  await act(async () => {
    finishEarlierRequest(previousOrder);
    await earlierReload;
  });

  expect(result.current.order).toEqual(currentOrder);
  expect(result.current.isLoading).toBe(false);
});

it('keeps a later Order version when a new reload returns a stale version', async () => {
  jest.mocked(ordersService.getOrder).mockResolvedValueOnce(currentOrder).mockResolvedValueOnce(previousOrder);
  const { result } = await renderHook(() => useCustomerOrderDetail('order-1'));

  await act(() => result.current.reload());
  await act(() => result.current.reload());

  expect(result.current.order).toEqual(currentOrder);
});
