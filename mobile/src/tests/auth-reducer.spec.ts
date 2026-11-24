import type { AuthProfile } from '@/features/auth/types/auth.types';
import {
  authReducer,
  initialAuthState,
} from '@/features/auth/providers/auth-reducer';

const customerProfile: AuthProfile = {
  id: 'user-1',
  username: 'customer.one',
  fullName: 'Nguyễn Văn A',
  role: 'CUSTOMER',
  phone: '0901234567',
  email: 'customer@example.com',
  active: true,
  branchId: null,
  locationId: null,
  customer: {
    id: 'customer-1',
    code: 'CUS-1',
    name: 'Nguyễn Văn A',
    phone: '0901234567',
    email: 'customer@example.com',
  },
};

describe('authReducer', () => {
  it('chuyển từ initializing sang anonymous khi không có phiên', () => {
    expect(authReducer(initialAuthState, { type: 'SIGNED_OUT' })).toEqual({
      status: 'anonymous',
      user: null,
      sessionError: null,
    });
  });

  it('chỉ có một authenticated user làm nguồn trạng thái', () => {
    expect(
      authReducer(initialAuthState, {
        type: 'AUTHENTICATED',
        user: customerProfile,
      }),
    ).toEqual({
      status: 'authenticated',
      user: customerProfile,
      sessionError: null,
    });
  });

  it('giữ trạng thái session-error riêng khi mạng lỗi', () => {
    expect(
      authReducer(initialAuthState, {
        type: 'SESSION_FAILED',
        message: 'Không thể kết nối máy chủ.',
      }),
    ).toEqual({
      status: 'session-error',
      user: null,
      sessionError: 'Không thể kết nối máy chủ.',
    });
  });
});
