import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../../src/auth/auth.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('AuthService', () => {
  const transaction = {
    user: { create: jest.fn() },
    customer: { create: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(),
    user: { findUnique: jest.fn() },
  };
  const jwt = { sign: jest.fn().mockReturnValue('signed-token') };
  let service: AuthService;

  const registrationDto = {
    username: 'customer.one',
    password: 'StrongPass123',
    fullName: 'Nguyễn Văn A',
    phone: '0901234567',
    email: 'user@example.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
    );
  });

  it('tạo User CUSTOMER và Customer trong cùng transaction, không trả password', async () => {
    transaction.user.create.mockResolvedValue({
      id: 'user-1',
      username: registrationDto.username,
      fullName: registrationDto.fullName,
      phone: registrationDto.phone,
      email: registrationDto.email,
      role: Role.CUSTOMER,
      active: true,
      createdAt: new Date(),
    });
    transaction.customer.create.mockResolvedValue({
      id: 'customer-1',
      code: 'CUS-1',
      name: registrationDto.fullName,
      phone: registrationDto.phone,
      email: registrationDto.email,
    });

    const result = await service.registerCustomer(registrationDto);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const userCreate = transaction.user.create.mock.calls[0][0];
    expect(userCreate.data).toMatchObject({
      username: registrationDto.username,
      role: Role.CUSTOMER,
    });
    expect(userCreate.data).not.toHaveProperty('branchId');
    expect(userCreate.data).not.toHaveProperty('customerId');
    await expect(
      bcrypt.compare(registrationDto.password, userCreate.data.password),
    ).resolves.toBe(true);
    expect(transaction.customer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it.each([
    ['username', 'USERNAME_ALREADY_EXISTS'],
    ['email', 'EMAIL_ALREADY_EXISTS'],
    ['phone', 'PHONE_ALREADY_EXISTS'],
  ])('chuyển P2002 của %s thành ConflictException', async (field, code) => {
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.19.1',
        meta: { target: [field] },
      }),
    );

    await expect(
      service.registerCustomer(registrationDto),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: code }),
    });
  });

  it('để transaction thất bại toàn bộ khi tạo Customer lỗi', async () => {
    transaction.user.create.mockResolvedValue({ id: 'user-will-rollback' });
    transaction.customer.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.19.1',
        meta: { target: ['phone'] },
      }),
    );

    await expect(
      service.registerCustomer(registrationDto),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.user.create).toHaveBeenCalledTimes(1);
    expect(transaction.customer.create).toHaveBeenCalledTimes(1);
  });

  it('đăng nhập thành công và giữ contract accessToken/user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'customer.one',
      password: await bcrypt.hash('StrongPass123', 4),
      fullName: 'Nguyễn Văn A',
      role: Role.CUSTOMER,
      active: true,
      branchId: null,
      branch: null,
      locationId: null,
    });

    await expect(
      service.login({ username: 'customer.one', pass: 'StrongPass123' }),
    ).resolves.toEqual({
      accessToken: 'signed-token',
      user: {
        id: 'user-1',
        username: 'customer.one',
        fullName: 'Nguyễn Văn A',
        role: Role.CUSTOMER,
        branch: null,
        locationId: null,
      },
    });
  });

  it('từ chối sai mật khẩu', async () => {
    prisma.user.findUnique.mockResolvedValue({
      password: await bcrypt.hash('correct-password', 4),
      active: true,
    });

    await expect(
      service.login({ username: 'customer.one', pass: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('từ chối tài khoản inactive', async () => {
    prisma.user.findUnique.mockResolvedValue({ active: false });

    await expect(
      service.login({ username: 'customer.one', pass: 'StrongPass123' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('trả profile CUSTOMER liên kết và không truy vấn/trả password', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'customer.one',
      role: Role.CUSTOMER,
      active: true,
      customer: { id: 'customer-1', code: 'CUS-1' },
    });

    const profile = await service.getProfile('user-1');
    expect(prisma.user.findUnique.mock.calls[0][0].select).not.toHaveProperty(
      'password',
    );
    expect(profile).not.toHaveProperty('password');
    expect(profile.customer).toMatchObject({ id: 'customer-1' });
  });

  it('báo lỗi dữ liệu khi CUSTOMER thiếu Customer relation', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: Role.CUSTOMER,
      active: true,
      customer: null,
    });

    await expect(service.getProfile('user-1')).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'CUSTOMER_PROFILE_NOT_FOUND',
      }),
    });
  });
});
