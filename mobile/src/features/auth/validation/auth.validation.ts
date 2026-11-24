import type {
  LoginFormValues,
  LoginRequest,
  RegisterCustomerRequest,
  RegisterFormValues,
  ValidationResult,
} from '@/features/auth/types/auth.types';

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const PHONE_PATTERN = /^\+?[0-9]{9,15}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizePhone(value: string): string {
  return value.trim().replace(/[\s.-]/g, '');
}

export function validateLogin(
  values: LoginFormValues,
): ValidationResult<LoginRequest> {
  const username = values.username.trim();
  const errors: Partial<Record<keyof LoginFormValues, string>> = {};

  if (!username) errors.username = 'Vui lòng nhập tên đăng nhập.';
  if (!values.password) errors.password = 'Vui lòng nhập mật khẩu.';

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }
  return { success: true, data: { username, password: values.password } };
}

export function validateRegistration(
  values: RegisterFormValues,
): ValidationResult<RegisterCustomerRequest> {
  const username = values.username.trim().toLowerCase();
  const fullName = values.fullName.trim().replace(/\s+/g, ' ');
  const phone = normalizePhone(values.phone);
  const email = values.email.trim().toLowerCase();
  const errors: Partial<Record<keyof RegisterFormValues, string>> = {};

  if (username.length < 4 || username.length > 50) {
    errors.username = 'Tên đăng nhập phải có từ 4 đến 50 ký tự.';
  } else if (!USERNAME_PATTERN.test(username)) {
    errors.username = 'Chỉ dùng chữ thường, số, dấu chấm, _ hoặc -.';
  }

  if (values.password.length < 8 || values.password.length > 72) {
    errors.password = 'Mật khẩu phải có từ 8 đến 72 ký tự.';
  }
  if (values.confirmPassword !== values.password) {
    errors.confirmPassword = 'Mật khẩu xác nhận không khớp.';
  }
  if (!fullName) {
    errors.fullName = 'Vui lòng nhập họ tên.';
  } else if (fullName.length > 100) {
    errors.fullName = 'Họ tên không được vượt quá 100 ký tự.';
  }
  if (!PHONE_PATTERN.test(phone)) {
    errors.phone = 'Số điện thoại phải có 9-15 chữ số, có thể bắt đầu bằng +.';
  }
  if (email && (email.length > 254 || !EMAIL_PATTERN.test(email))) {
    errors.email = 'Email không đúng định dạng.';
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      username,
      password: values.password,
      fullName,
      phone,
      ...(email ? { email } : {}),
    },
  };
}
