import { Role } from '@prisma/client';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { resolveBranchScope, resolveLocationScope, assertLocationAccess } from '../../src/auth/branch-scope';
import { branchFilter, Principal } from '../../src/auth/access';
const principal = (grants: Principal['grants']): Principal => ({ id: 'u', username: 'u', fullName: 'U', sessionId: 's', grants });
const dispatcher = principal([{ role: 'DISPATCHER', scopeType: 'BRANCH', branchId: 'branch-sgn', permissions: ['trips.plan'] }]);
describe('resolveBranchScope with authoritative grants', () => {
  it('cho phép admin chọn chi nhánh khác', () => {
    expect(resolveBranchScope(principal([{ role: 'ADMIN', scopeType: 'COMPANY', branchId: null, permissions: ['trips.plan'] }]), 'branch-hn')).toBe('branch-hn');
  });
  it('giữ dispatcher trong chi nhánh được cấp', () => {
    expect(resolveBranchScope(dispatcher)).toBe('branch-sgn');
    expect(() => resolveBranchScope(dispatcher, 'branch-hn')).toThrow(ForbiddenException);
  });
  it('từ chối tài khoản thiếu scope, không mặc định toàn công ty', () => {
    expect(() => resolveBranchScope(principal([]))).toThrow(ForbiddenException);
  });
  it('hỗ trợ nhiều chi nhánh và yêu cầu chọn khi lập chuyến', () => {
    const user = principal([...dispatcher.grants, { ...dispatcher.grants[0], branchId: 'branch-hn' }]);
    expect(branchFilter(user, 'trips.plan')).toEqual({ in: ['branch-sgn', 'branch-hn'] });
    expect(resolveBranchScope(user, 'branch-hn')).toBe('branch-hn');
    expect(() => resolveBranchScope(user)).toThrow(BadRequestException);
  });
  it('không kết hợp quyền ở A với scope của B', () => {
    const user = principal([...dispatcher.grants, { ...dispatcher.grants[0], branchId: 'branch-hn', permissions: ['orders.read'] }]);
    expect(() => resolveBranchScope(user, 'branch-hn')).toThrow(ForbiddenException);
  });
});

describe('resolveLocationScope', () => {
  it('cho phép admin chọn một địa điểm bất kỳ trong chuỗi', () => {
    expect(
      resolveLocationScope(
        { role: Role.ADMIN, locationId: 'LOC-STORE-D1' },
        'LOC-PKP-D10-KING',
      ),
    ).toBe('LOC-PKP-D10-KING');
  });

  it('giữ nhân viên (STAFF) trong địa điểm được gán', () => {
    expect(
      resolveLocationScope({ role: Role.STAFF, locationId: 'LOC-STORE-D1' }),
    ).toBe('LOC-STORE-D1');
    expect(() =>
      resolveLocationScope(
        { role: Role.STAFF, locationId: 'LOC-STORE-D1' },
        'LOC-STORE-D7',
      ),
    ).toThrow(ForbiddenException);
  });

  it('từ chối tài khoản nhân viên chưa được gán địa điểm làm việc', () => {
    expect(() =>
      resolveLocationScope({ role: Role.STAFF, locationId: null }),
    ).toThrow('Tài khoản chưa được gán địa điểm làm việc');
  });
});

describe('assertLocationAccess', () => {
  it('cho phép ADMIN truy cập tài nguyên ở mọi địa điểm', () => {
    expect(() =>
      assertLocationAccess(
        { role: Role.ADMIN, locationId: null },
        'LOC-STORE-D7',
      ),
    ).not.toThrow();
  });

  it('từ chối STAFF truy cập tài nguyên ngoài địa điểm được gán', () => {
    expect(() =>
      assertLocationAccess(
        { role: Role.STAFF, locationId: 'LOC-STORE-D1' },
        'LOC-STORE-D7',
      ),
    ).toThrow(ForbiddenException);
  });
});
