import { ForbiddenException, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { authConfig } from './auth.config';
import { AccessGrant, Principal } from './access';
import { LoginDto } from './login.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly settings;
  private readonly dummyHash = bcrypt.hashSync('timing-only-not-an-account', 12);
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, config: ConfigService) {
    this.settings = authConfig(config);
  }
  async login(dto: LoginDto, ip: string) {
    await this.limitLogin(dto.username, ip);
    const user = await this.prisma.user.findUnique({ where: { username: dto.username } });
    const valid = await bcrypt.compare(dto.password, user?.password ?? this.dummyHash);
    if (!user || !valid) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: 'Sai tên đăng nhập hoặc mật khẩu' });
    const expiresAt = new Date(Date.now() + this.settings.ttl * 1000);
    const { session, grants } = await this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ active: boolean }>>`SELECT active FROM users WHERE id = ${user.id} FOR UPDATE`;
      if (!rows[0]?.active) throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên' });
      const grants = await this.loadGrants(user.id, tx);
      if (!grants.length && !['STAFF', 'CUSTOMER'].includes(user.role)) throw new ForbiddenException({ code: 'NO_SCOPE', message: 'Tài khoản chưa có phạm vi hoạt động được cấp' });
      return { grants, session: await tx.authSession.create({ data: { userId: user.id, expiresAt } }) };
    });
    const accessToken = this.jwt.sign({ sub: user.id, sid: session.id }, { expiresIn: this.settings.ttl });
    return { accessToken, expiresAt: expiresAt.toISOString(), user: await this.profile({ id: user.id, username: user.username, fullName: user.fullName, sessionId: session.id, grants, role: user.role, branchId: user.branchId, locationId: user.locationId, phone: user.phone, email: user.email }) };
  }
  // Shared counters survive restarts and expire without permanently locking an account.
  private async limitLogin(username: string, ip: string) {
    const keys = [`account:${username}`, `ip:${ip}`].map(value => createHmac('sha256', this.settings.secret).update(value).digest('hex'));
    const counts = await this.prisma.$transaction(async tx => {
      const result: number[] = [];
      for (const key of keys) {
        const rows = await tx.$queryRaw<Array<{ attempts: number }>>`
          INSERT INTO auth_login_limits (key, attempts, "expiresAt")
          VALUES (${key}, 1, now() + ${this.settings.window} * interval '1 second')
          ON CONFLICT (key) DO UPDATE SET
            attempts = CASE WHEN auth_login_limits."expiresAt" <= now() THEN 1 ELSE auth_login_limits.attempts + 1 END,
            "expiresAt" = CASE WHEN auth_login_limits."expiresAt" <= now() THEN now() + ${this.settings.window} * interval '1 second' ELSE auth_login_limits."expiresAt" END
          RETURNING attempts`;
        result.push(rows[0].attempts);
      }
      await tx.authLoginLimit.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - this.settings.window * 1000) } } });
      return result;
    });
    if (counts[0] > this.settings.limit || counts[1] > this.settings.ipLimit) throw new HttpException({ code: 'LOGIN_RATE_LIMITED', message: 'Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau cửa sổ giới hạn', retryAfterSeconds: this.settings.window }, 429);
  }
  private async loadGrants(userId: string, db: Prisma.TransactionClient = this.prisma): Promise<AccessGrant[]> {
    const scopes = await db.userRoleScope.findMany({
      where: { userId, active: true, role: { active: true }, OR: [{ scopeType: 'COMPANY', branchId: null }, { scopeType: 'BRANCH', branch: { active: true } }] },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    return scopes.filter(s => (s.role.code === 'ADMIN' && s.scopeType === 'COMPANY' && s.branchId === null) || (s.role.code === 'DISPATCHER' && s.scopeType === 'BRANCH' && !!s.branchId))
      .map(s => ({ role: s.role.code, scopeType: s.scopeType, branchId: s.branchId, permissions: s.role.permissions.map(p => p.permission.code) }));
  }
  async authenticatePayload(payload: unknown, db: Prisma.TransactionClient = this.prisma): Promise<Principal> {
    if (!payload || typeof payload !== 'object' || !('sub' in payload) || typeof payload.sub !== 'string' || !('sid' in payload) || typeof payload.sid !== 'string') throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên không hợp lệ' });
    const session = await db.authSession.findUnique({ where: { id: payload.sid }, include: { user: true } });
    if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) throw new UnauthorizedException({ code: 'SESSION_INVALID', message: 'Phiên đã hết hạn hoặc đã đăng xuất' });
    if (!session.user.active) throw new UnauthorizedException({ code: 'ACCOUNT_DISABLED', message: 'Tài khoản đã bị khóa' });
    return { id: session.userId, username: session.user.username, fullName: session.user.fullName, sessionId: session.id, role: session.user.role, branchId: session.user.branchId, locationId: session.user.locationId, phone: session.user.phone, email: session.user.email, grants: await this.loadGrants(session.userId, db) };
  }
  async authenticateToken(token: string, db: Prisma.TransactionClient = this.prisma) {
    let payload: unknown;
    try { payload = this.jwt.verify(token); } catch { throw new UnauthorizedException('Phiên không hợp lệ hoặc hết hạn'); }
    return this.authenticatePayload(payload, db);
  }
  async profile(user: Principal) {
    const company = user.grants.some(g => g.role === 'ADMIN' && g.scopeType === 'COMPANY');
    const branches = await this.prisma.branch.findMany({ where: { active: true, ...(company ? {} : { id: { in: user.grants.flatMap(g => g.branchId ? [g.branchId] : []) } }) }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });
    return { id: user.id, username: user.username, fullName: user.fullName, role: user.role, branchId: user.branchId, locationId: user.locationId, phone: user.phone, email: user.email, grants: user.grants, branches, companyScope: company, permissions: [...new Set(user.grants.flatMap(g => g.permissions))] };
  }
  async principalForWorker(userId: string): Promise<Principal> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.active) throw new ForbiddenException('Worker account is inactive');
    return { id: user.id, username: user.username, fullName: user.fullName, sessionId: '', role: user.role, branchId: user.branchId, locationId: user.locationId, grants: await this.loadGrants(user.id) };
  }
  async logout(user: Principal) {
    await this.prisma.authSession.updateMany({ where: { id: user.sessionId, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { loggedOut: true };
  }
}
