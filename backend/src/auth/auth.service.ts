import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterCustomerDto } from './dto/register-customer.dto';

const PASSWORD_HASH_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async registerCustomer(dto: RegisterCustomerDto) {
    const username = dto.username.trim().toLowerCase();
    const fullName = dto.fullName.trim().replace(/\s+/g, ' ');
    const phone = dto.phone.trim().replace(/[\s.-]/g, '');
    const email = dto.email?.trim().toLowerCase() || null;
    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: {
            username,
            password: passwordHash,
            fullName,
            phone,
            email,
            role: Role.CUSTOMER,
          },
          select: {
            id: true,
            username: true,
            fullName: true,
            phone: true,
            email: true,
            role: true,
            active: true,
            createdAt: true,
          },
        });

        const customer = await transaction.customer.create({
          data: {
            code: `CUS-${randomUUID().toUpperCase()}`,
            userId: user.id,
            name: fullName,
            phone,
            email,
          },
          select: {
            id: true,
            code: true,
            name: true,
            phone: true,
            email: true,
          },
        });

        return { user, customer };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw this.toRegistrationConflict(error);
      }
      throw error;
    }
  }

  async login(dto: LoginDto) {
    const rawPassword = dto.pass || dto.password;
    if (!rawPassword) {
      throw new UnauthorizedException('Mật khẩu không được để trống');
    }

    const user = await this.validateUser(dto.username.trim(), rawPassword);
    if (!user) {
      throw new UnauthorizedException('Sai tên đăng nhập hoặc mật khẩu');
    }

    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      branchId: user.branchId,
      locationId: user.locationId,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      user: {
        id: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        branch: user.branch,
        locationId: user.locationId,
      },
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        phone: true,
        email: true,
        active: true,
        branchId: true,
        locationId: true,
        customer: {
          select: {
            id: true,
            code: true,
            name: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!user || !user.active) {
      throw new UnauthorizedException(
        'Tài khoản không tồn tại hoặc đã bị khóa',
      );
    }

    if (user.role === Role.CUSTOMER && !user.customer) {
      throw new ConflictException({
        errorCode: 'CUSTOMER_PROFILE_NOT_FOUND',
        message: 'Tài khoản CUSTOMER chưa được liên kết với hồ sơ khách hàng',
      });
    }

    return user;
  }

  private async validateUser(username: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { branch: true },
    });

    if (!user || !user.active) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return null;
    }

    const { password: _password, ...safeUser } = user;
    return safeUser;
  }

  private isUniqueConstraintError(
    error: unknown,
  ): error is Prisma.PrismaClientKnownRequestError {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private toRegistrationConflict(
    error: Prisma.PrismaClientKnownRequestError,
  ): ConflictException {
    const target = Array.isArray(error.meta?.target)
      ? error.meta.target.map(String)
      : [String(error.meta?.target ?? '')];

    if (target.some((field) => field.includes('username'))) {
      return new ConflictException({
        errorCode: 'USERNAME_ALREADY_EXISTS',
        message: 'Tên đăng nhập đã được sử dụng',
      });
    }
    if (target.some((field) => field.includes('email'))) {
      return new ConflictException({
        errorCode: 'EMAIL_ALREADY_EXISTS',
        message: 'Email đã được sử dụng',
      });
    }
    if (target.some((field) => field.includes('phone'))) {
      return new ConflictException({
        errorCode: 'PHONE_ALREADY_EXISTS',
        message: 'Số điện thoại đã được sử dụng',
      });
    }

    return new ConflictException({
      errorCode: 'CUSTOMER_REGISTRATION_CONFLICT',
      message: 'Thông tin đăng ký đã được sử dụng',
    });
  }
}
