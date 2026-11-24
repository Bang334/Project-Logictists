import {
  normalizePhone,
  validateLogin,
  validateRegistration,
} from './auth.validation';

describe('auth validation', () => {
  it('chuẩn hóa registration giống backend', () => {
    const result = validateRegistration({
      username: '  Customer.One ',
      password: 'StrongPass123',
      confirmPassword: 'StrongPass123',
      fullName: ' Nguyễn   Văn A ',
      phone: '090-123-4567',
      email: ' USER@EXAMPLE.COM ',
    });

    expect(result).toEqual({
      success: true,
      data: {
        username: 'customer.one',
        password: 'StrongPass123',
        fullName: 'Nguyễn Văn A',
        phone: '0901234567',
        email: 'user@example.com',
      },
    });
  });

  it('từ chối dữ liệu registration sai contract', () => {
    const result = validateRegistration({
      username: 'a!',
      password: 'short',
      confirmPassword: 'different',
      fullName: '',
      phone: 'abc',
      email: 'invalid',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toEqual(
        expect.objectContaining({
          username: expect.any(String),
          password: expect.any(String),
          confirmPassword: expect.any(String),
          fullName: expect.any(String),
          phone: expect.any(String),
          email: expect.any(String),
        }),
      );
    }
  });

  it('không lowercase username đăng nhập để giữ contract tài khoản cũ', () => {
    expect(validateLogin({ username: ' Admin ', password: 'password' })).toEqual({
      success: true,
      data: { username: 'Admin', password: 'password' },
    });
  });

  it('chuẩn hóa số điện thoại', () => {
    expect(normalizePhone('+84 90.123-4567')).toBe('+84901234567');
  });
});
