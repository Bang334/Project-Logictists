import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { resolveBranchScope } from './branch-scope';

describe('resolveBranchScope', () => {
  it('cho phép admin chọn một chi nhánh khác', () => {
    expect(
      resolveBranchScope(
        { role: Role.ADMIN, branchId: 'branch-hn' },
        'branch-sgn',
      ),
    ).toBe('branch-sgn');
  });

  it('giữ dispatcher trong chi nhánh được gán', () => {
    expect(
      resolveBranchScope({ role: Role.DISPATCHER, branchId: 'branch-sgn' }),
    ).toBe('branch-sgn');
    expect(() =>
      resolveBranchScope(
        { role: Role.DISPATCHER, branchId: 'branch-sgn' },
        'branch-hn',
      ),
    ).toThrow(ForbiddenException);
  });

  it('từ chối tài khoản vận hành chưa được gán chi nhánh', () => {
    expect(() =>
      resolveBranchScope({ role: Role.DISPATCHER, branchId: null }),
    ).toThrow('Tài khoản chưa được gán chi nhánh');
  });
});
