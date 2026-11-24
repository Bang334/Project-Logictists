import type { UserRole } from '@/types/user-role';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    role: UserRole;
    locationId: string | null;
  };
}

export interface RegisterCustomerRequest {
  username: string;
  password: string;
  fullName: string;
  phone: string;
  email?: string;
}

export interface RegisteredCustomer {
  user: {
    id: string;
    username: string;
    fullName: string;
    phone: string | null;
    email: string | null;
    role: 'CUSTOMER';
    active: boolean;
    createdAt: string;
  };
  customer: CustomerProfile;
}

export interface CustomerProfile {
  id: string;
  code: string;
  name: string;
  phone: string;
  email: string | null;
}

export interface AuthProfile {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  phone: string | null;
  email: string | null;
  active: boolean;
  branchId: string | null;
  locationId: string | null;
  customer: CustomerProfile | null;
}

export interface LoginFormValues {
  username: string;
  password: string;
}

export interface RegisterFormValues extends LoginFormValues {
  fullName: string;
  phone: string;
  email: string;
  confirmPassword: string;
}

export type FieldErrors<T> = Partial<Record<keyof T, string>>;

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: FieldErrors<T> };
