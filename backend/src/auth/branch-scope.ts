import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';

export type BranchScopedUser = {
  branchId?: string | null;
  role: Role;
};

/**
 * Admin có thể chọn chi nhánh khác; các vai trò vận hành chỉ được dùng chi
 * nhánh đã gán trên tài khoản. Hàm này phải được gọi ở backend trước khi lọc
 * dữ liệu theo branchId do client gửi lên.
 */
export function resolveBranchScope(
  user: BranchScopedUser,
  requestedBranchId?: string,
): string {
  if (user.role === Role.ADMIN) {
    const branchId = requestedBranchId || user.branchId;
    if (!branchId) {
      throw new ForbiddenException('Hãy chọn chi nhánh để tiếp tục');
    }
    return branchId;
  }

  if (!user.branchId) {
    throw new ForbiddenException('Tài khoản chưa được gán chi nhánh');
  }
  if (requestedBranchId && requestedBranchId !== user.branchId) {
    throw new ForbiddenException('Không có quyền thao tác ngoài chi nhánh được gán');
  }
  return user.branchId;
}
