import { act, renderHook } from '@testing-library/react-native';
import { ApiError } from '@/shared/api/api-error';
import { useOrderApiError } from './useOrderApiError';

const mockLogout = jest.fn<Promise<void>, []>();

jest.mock('@/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

describe('useOrderApiError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogout.mockResolvedValue();
  });

  it('đăng xuất khi Customer API trả 401', async () => {
    const { result } = await renderHook(() => useOrderApiError());
    let message = '';
    await act(async () => {
      message = await result.current(
        new ApiError('Phiên đã hết hạn', 401, 'HTTP_401'),
      );
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(message).toBe('Phiên đã hết hạn');
  });

  it('giữ phiên và trả thông báo Backend cho 403/409', async () => {
    const { result } = await renderHook(() => useOrderApiError());
    await act(async () => {
      expect(
        await result.current(new ApiError('Không có quyền', 403, 'HTTP_403')),
      ).toBe('Không có quyền');
      expect(
        await result.current(new ApiError('Xung đột dữ liệu', 409, 'HTTP_409')),
      ).toBe('Xung đột dữ liệu');
    });
    expect(mockLogout).not.toHaveBeenCalled();
  });
});
