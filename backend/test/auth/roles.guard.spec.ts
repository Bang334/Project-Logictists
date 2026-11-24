import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RolesGuard } from '../../src/auth/roles.guard';

describe('RolesGuard exact role matching', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };
  const guard = new RolesGuard(reflector as unknown as Reflector);

  const contextFor = (role: Role) =>
    ({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => jest.clearAllMocks());

  it('cho phép role nằm trong metadata', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.CUSTOMER]);
    expect(guard.canActivate(contextFor(Role.CUSTOMER))).toBe(true);
  });

  it('không cho ADMIN bypass endpoint CUSTOMER-only', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.CUSTOMER]);
    expect(() => guard.canActivate(contextFor(Role.ADMIN))).toThrow(
      ForbiddenException,
    );
  });

  it('giữ endpoint không khai báo role ở chế độ authenticated-only', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(contextFor(Role.ADMIN))).toBe(true);
  });
});
