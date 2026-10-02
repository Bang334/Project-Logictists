import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  assertLocationAccess,
  resolveBranchScope,
  resolveLocationScope,
} from '../../src/auth/branch-scope';

describe('resolveBranchScope', () => {
  it('cho phép admin chọn một chi nhánh khác', () => {
    expect(
      resolveBranchScope(
        { role: Role.ADMIN, branchId: 'branch-hn' },
        'branch-sgn',
      ),
    ).toBe('branch-sgn');
  });

  it('giữ nhân viên trong chi nhánh được gán', () => {
    expect(
      resolveBranchScope({ role: Role.STAFF, branchId: 'branch-sgn' }),
    ).toBe('branch-sgn');
    expect(() =>
      resolveBranchScope(
        { role: Role.STAFF, branchId: 'branch-sgn' },
        'branch-hn',
      ),
    ).toThrow(ForbiddenException);
  });

  it('từ chối tài khoản vận hành chưa được gán chi nhánh', () => {
    expect(() =>
      resolveBranchScope({ role: Role.STAFF, branchId: null }),
    ).toThrow('Tài khoản chưa được gán chi nhánh');
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
