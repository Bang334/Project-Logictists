import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async validateUser(username: string, pass: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { branch: true },
    });

    if (!user || !user.active) {
      return null;
    }

    const isMatch = await bcrypt.compare(pass, user.password);
    if (isMatch) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async login(loginDto: { username: string; pass?: string; password?: string }) {
    const rawPassword = loginDto.pass || loginDto.password;
    if (!rawPassword) {
      throw new UnauthorizedException('Mật khẩu không được để trống');
    }
    const user = await this.validateUser(loginDto.username, rawPassword);
    if (!user) {
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      branchId: user.branchId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        branch: user.branch,
      },
    };
  }
}
