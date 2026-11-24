export const USER_ROLES = [
  'ADMIN',
  'STAFF',
  'DISPATCHER',
  'DRIVER',
  'CUSTOMER',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.some((role) => role === value);
}
