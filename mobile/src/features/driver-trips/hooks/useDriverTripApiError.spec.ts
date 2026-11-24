import { act, renderHook } from '@testing-library/react-native';
import { ApiError } from '@/shared/api/api-error';
import { useDriverTripApiError } from './useDriverTripApiError';

const mockLogout = jest.fn<Promise<void>, []>();

jest.mock('@/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({ logout: mockLogout }),
}));

describe('useDriverTripApiError', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogout.mockResolvedValue();
  });

  it('đăng xuất khi API trả 401', async () => {
    const { result } = await renderHook(() => useDriverTripApiError());
    await act(async () => {
      expect(
        await result.current(new ApiError('Phiên hết hạn', 401, 'HTTP_401')),
      ).toBe('Phiên hết hạn');
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('hiển thị thông báo quyền truy cập cho 403 nhưng giữ phiên', async () => {
    const { result } = await renderHook(() => useDriverTripApiError());
    await act(async () => {
      expect(
        await result.current(new ApiError('Không có quyền', 403, 'HTTP_403')),
      ).toBe('Không có quyền');
    });
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('ẩn khác biệt ownership trong lỗi 404', async () => {
    const { result } = await renderHook(() => useDriverTripApiError());
    await act(async () => {
      expect(
        await result.current(new ApiError('Internal detail', 404, 'HTTP_404')),
      ).toBe('Không tìm thấy chuyến được phân công.');
    });
  });

  it('map DRIVER_PROFILE_NOT_FOUND thành thông báo dễ hiểu', async () => {
    const { result } = await renderHook(() => useDriverTripApiError());
    await act(async () => {
      expect(
        await result.current(
          new ApiError('Conflict', 409, 'DRIVER_PROFILE_NOT_FOUND'),
        ),
      ).toBe('Tài khoản Driver chưa được liên kết với hồ sơ tài xế.');
    });
  });
});
