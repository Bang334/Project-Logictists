import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { JwtStrategy } from '../../src/auth/jwt.strategy';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('JwtStrategy', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const config = { getOrThrow: jest.fn().mockReturnValue('test-secret') };
  let strategy: JwtStrategy;

  beforeEach(() => {
    jest.clearAllMocks();
    strategy = new JwtStrategy(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  it('nạp lại user active từ database cho JWT hợp lệ', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'customer.one',
      role: Role.CUSTOMER,
      active: true,
    });

    await expect(
      strategy.validate({
        sub: 'user-1',
        username: 'customer.one',
        role: Role.CUSTOMER,
      }),
    ).resolves.toMatchObject({ id: 'user-1', active: true });
  });

  it.each([null, { id: 'user-1', active: false }])(
    'từ chối JWT khi user không tồn tại hoặc inactive',
    async (storedUser) => {
      prisma.user.findUnique.mockResolvedValue(storedUser);

      await expect(
        strategy.validate({
          sub: 'user-1',
          username: 'customer.one',
          role: Role.CUSTOMER,
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});
