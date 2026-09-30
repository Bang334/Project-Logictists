import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { resolveBranchScope } from './branch-scope';
import { branchFilter, Principal } from './access';
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
