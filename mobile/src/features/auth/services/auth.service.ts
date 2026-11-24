import { apiClient } from '@/shared/api/api-client';
import { ApiError } from '@/shared/api/api-error';
import { isUserRole } from '@/types/user-role';
import type {
  AuthProfile,
  CustomerProfile,
  LoginRequest,
  LoginResult,
  RegisterCustomerRequest,
  RegisteredCustomer,
} from '@/features/auth/types/auth.types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function invalidResponse(): never {
  throw new ApiError(
    'Dữ liệu xác thực từ máy chủ không đúng định dạng.',
    0,
    'INVALID_RESPONSE',
  );
}

function parseCustomer(value: unknown): CustomerProfile | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.code !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.phone !== 'string' ||
    !stringOrNull(value.email)
  ) {
    return invalidResponse();
  }
  return {
    id: value.id,
    code: value.code,
    name: value.name,
    phone: value.phone,
    email: value.email,
  };
}

function parseLogin(value: unknown): LoginResult {
  if (!isRecord(value) || typeof value.accessToken !== 'string') {
    return invalidResponse();
  }
  const user = value.user;
  if (
    !isRecord(user) ||
    typeof user.id !== 'string' ||
    typeof user.username !== 'string' ||
    typeof user.fullName !== 'string' ||
    !isUserRole(user.role) ||
    !stringOrNull(user.locationId)
  ) {
    return invalidResponse();
  }
  return {
    accessToken: value.accessToken,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      locationId: user.locationId,
    },
  };
}

function parseProfile(value: unknown): AuthProfile {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.username !== 'string' ||
    typeof value.fullName !== 'string' ||
    !isUserRole(value.role) ||
    !stringOrNull(value.phone) ||
    !stringOrNull(value.email) ||
    typeof value.active !== 'boolean' ||
    !stringOrNull(value.branchId) ||
    !stringOrNull(value.locationId)
  ) {
    return invalidResponse();
  }

  return {
    id: value.id,
    username: value.username,
    fullName: value.fullName,
    role: value.role,
    phone: value.phone,
    email: value.email,
    active: value.active,
    branchId: value.branchId,
    locationId: value.locationId,
    customer: parseCustomer(value.customer),
  };
}

function parseRegistration(value: unknown): RegisteredCustomer {
  if (!isRecord(value) || !isRecord(value.user)) return invalidResponse();
  const user = value.user;
  const customer = parseCustomer(value.customer);
  if (
    customer === null ||
    typeof user.id !== 'string' ||
    typeof user.username !== 'string' ||
    typeof user.fullName !== 'string' ||
    !stringOrNull(user.phone) ||
    !stringOrNull(user.email) ||
    user.role !== 'CUSTOMER' ||
    typeof user.active !== 'boolean' ||
    typeof user.createdAt !== 'string'
  ) {
    return invalidResponse();
  }
  return {
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      phone: user.phone,
      email: user.email,
      role: 'CUSTOMER',
      active: user.active,
      createdAt: user.createdAt,
    },
    customer,
  };
}

export const authService = {
  async login(request: LoginRequest): Promise<LoginResult> {
    const response = await apiClient.request('/auth/login', {
      method: 'POST',
      body: request,
    });
    return parseLogin(response);
  },

  async registerCustomer(
    request: RegisterCustomerRequest,
  ): Promise<RegisteredCustomer> {
    const response = await apiClient.request('/auth/register/customer', {
      method: 'POST',
      body: request,
    });
    return parseRegistration(response);
  },

  async getProfile(token: string): Promise<AuthProfile> {
    const response = await apiClient.request('/auth/profile', { token });
    return parseProfile(response);
  },
};
