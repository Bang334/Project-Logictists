import { act, renderHook } from '@testing-library/react-native';
import { ordersService } from '@/features/orders/services/orders.service';
import { ApiError } from '@/shared/api/api-error';
import { useCreateCustomerOrder } from './useCreateCustomerOrder';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('@/features/orders/services/orders.service', () => ({
  ordersService: { createOrder: jest.fn() },
}));
jest.mock('./useOrderApiError', () => ({
  useOrderApiError: () => async (error: unknown) =>
    error instanceof Error ? error.message : 'Lỗi',
}));

const Crypto = jest.requireMock('expo-crypto') as {
  randomUUID: jest.Mock<string, []>;
};

const payload = {
  branchId: 'branch-1',
  pickup: {
    address: 'A', latitude: 10, longitude: 106, contactName: 'A', contactPhone: '0900000001',
  },
  delivery: {
    address: 'B', latitude: 11, longitude: 107, contactName: 'B', contactPhone: '0900000002',
  },
  items: [
    {
      description: 'Box', packageType: 'CARTON' as const, quantity: 1,
      unitWeightKg: 10, lengthCm: 10, widthCm: 10, heightCm: 10,
    },
  ],
};

const created = {
  id: 'order-1',
  orderNumber: 'ORD-CUS-1',
  status: 'DRAFT' as const,
  version: 1,
  totalPackages: 1,
  totalWeightKg: 10,
  totalVolumeM3: 0.001,
  createdAt: '2026-11-15T00:00:00.000Z',
  orderedAt: '2026-11-15T00:00:00.000Z',
  branch: { id: 'branch-1', code: 'DAD', name: 'Đà Nẵng' },
};

describe('useCreateCustomerOrder idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Crypto.randomUUID.mockReset();
    Crypto.randomUUID
      .mockReturnValueOnce('key-1')
      .mockReturnValueOnce('key-2')
      .mockReturnValue('key-next');
  });

  it('giữ nguyên key khi retry cùng payload sau timeout', async () => {
    jest
      .mocked(ordersService.createOrder)
      .mockRejectedValueOnce(new ApiError('Timeout', 0, 'REQUEST_TIMEOUT'))
      .mockResolvedValueOnce(created);
    const { result } = await renderHook(() => useCreateCustomerOrder());

    await act(async () => {
      await expect(result.current.submit(payload)).rejects.toThrow('Timeout');
    });
    expect(result.current.hasUncertainSubmission).toBe(true);
    await act(async () => {
      await result.current.submit(payload);
    });

    const calls = jest.mocked(ordersService.createOrder).mock.calls;
    expect(calls[0]?.[0].idempotencyKey).toBe('key-1');
    expect(calls[1]?.[0].idempotencyKey).toBe('key-1');
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it('dùng key mới khi payload thay đổi sau kết quả chưa rõ', async () => {
    jest
      .mocked(ordersService.createOrder)
      .mockRejectedValueOnce(new ApiError('Mất mạng', 0, 'NETWORK_ERROR'))
      .mockResolvedValueOnce(created);
    const { result } = await renderHook(() => useCreateCustomerOrder());
    await act(async () => {
      await expect(result.current.submit(payload)).rejects.toThrow('Mất mạng');
    });
    await act(async () => {
      await result.current.submit({ ...payload, notes: 'Nội dung đã sửa' });
    });
    const calls = jest.mocked(ordersService.createOrder).mock.calls;
    expect(calls[0]?.[0].idempotencyKey).toBe('key-1');
    expect(calls[1]?.[0].idempotencyKey).toBe('key-2');
  });

  it('khóa double tap trong khi request đang chạy', async () => {
    let resolveRequest: ((value: typeof created) => void) | undefined;
    jest.mocked(ordersService.createOrder).mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const { result } = await renderHook(() => useCreateCustomerOrder());
    let firstRequest: Promise<unknown> | undefined;
    await act(async () => {
      firstRequest = result.current.submit(payload);
      await expect(result.current.submit(payload)).resolves.toBeNull();
    });
    expect(ordersService.createOrder).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveRequest?.(created);
      await firstRequest;
    });
  });
});
