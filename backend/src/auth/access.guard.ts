import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { assertPermission, AuthRequest, PermissionCode } from './access';

@Injectable()
export class SessionGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http' || this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()])) return true;
    return super.canActivate(context);
  }
  handleRequest<T>(err: unknown, user: T): T {
    if (err) throw err;
    if (!user) throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại' });
    return user;
  }
}
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http' || this.reflector.getAllAndOverride<boolean>('public', [context.getHandler(), context.getClass()])) return true;
    const permission = this.reflector.getAllAndOverride<PermissionCode | 'authenticated'>('permission', [context.getHandler(), context.getClass()]);
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (!permission) { assertPermission({ ...request.user, grants: [] }, 'branches.read'); return false; }
    if (permission === 'authenticated') return true;
    const selected = request.headers['x-branch-id'];
    if (typeof selected === 'string' && selected !== 'ALL') request.user.selectedBranchId = selected;
    assertPermission(request.user, permission, request.user.selectedBranchId);
    return true;
  }
}
