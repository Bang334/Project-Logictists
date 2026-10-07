import { Role } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { AccessGrant, Principal, requireBranch } from './access';
export function resolveBranchScope(user: Principal, requestedBranchId?: string): string {
  return requireBranch(user, 'trips.plan', requestedBranchId);
}

export type LocationScopedUser = {
  id?: string;
  locationId?: string | null;
  branchId?: string | null;
  role?: Role;
};

export type AuthenticatedUser = {
  grants?: AccessGrant[];
  id: string;
  username?: string;
  fullName?: string;
  phone?: string | null;
  email?: string | null;
  locationId?: string | null;
  branchId?: string | null;
  role?: Role;
};

/**
 * Admin có thể chọn địa điểm bất kỳ trong chuỗi; nhân viên (STAFF) chỉ được dùng
 * địa điểm đã gán trên tài khoản. Hàm này phải được gọi ở backend trước khi lọc
 * dữ liệu theo locationId do client gửi lên (RR21).
 */
export function resolveLocationScope(
  user: LocationScopedUser,
  requestedLocationId?: string,
): string {
  if (user.role === Role.ADMIN) {
    const locationId = requestedLocationId || user.locationId;
    if (!locationId) {
      throw new ForbiddenException('Hãy chọn địa điểm để tiếp tục');
    }
    return locationId;
  }

  if (!user.locationId) {
    throw new ForbiddenException('Tài khoản chưa được gán địa điểm làm việc');
  }
  if (requestedLocationId && requestedLocationId !== user.locationId) {
    throw new ForbiddenException('Không có quyền thao tác ngoài địa điểm được gán');
  }
  return user.locationId;
}

/**
 * Kiểm tra tài nguyên đã biết location thay vì tin location do client gửi.
 * ADMIN được phép thao tác liên địa điểm; các vai trò khác phải khớp location
 * được nạp lại từ database bởi JwtStrategy.
 */
export function assertLocationAccess(
  user: LocationScopedUser,
  resourceLocationId: string,
): void {
  if (user.role === Role.ADMIN) {
    return;
  }
  if (!user.locationId || user.locationId !== resourceLocationId) {
    throw new ForbiddenException('Không có quyền truy cập dữ liệu ngoài địa điểm được gán');
  }
}
