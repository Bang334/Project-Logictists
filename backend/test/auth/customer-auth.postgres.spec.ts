import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import request = require('supertest');
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = testDatabaseUrl ? describe : describe.skip;

describePostgres('Customer authentication (PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  const suffix = randomUUID().slice(0, 8);
  const usernamePrefix = `m1-${suffix}`;
  let sequence = 0;

  const nextPhone = () => {
    sequence += 1;
    const suiteDigits = suffix
      .replace(/[^0-9]/g, '')
      .padEnd(5, '7')
      .slice(0, 5);
    return `091${suiteDigits}${String(sequence).padStart(2, '0')}`;
  };

  const registration = (label: string) => ({
    username: `${usernamePrefix}-${label}`,
    password: 'StrongPass123',
    fullName: `M1 Test ${label}`,
    phone: nextPhone(),
    email: `${usernamePrefix}-${label}@example.com`,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = 'm1-integration-test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.customer.deleteMany({
      where: {
        OR: [
          { user: { username: { startsWith: usernamePrefix } } },
          { code: { startsWith: `IT-M1-${suffix}` } },
        ],
      },
    });
    await prisma.user.deleteMany({
      where: { username: { startsWith: usernamePrefix } },
    });
    await app.close();
  });

  it('đăng ký hợp lệ, lưu hash và không trả password', async () => {
    const dto = registration('valid');
    const response = await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(dto)
      .expect(201);

    expect(response.body.user).toMatchObject({
      username: dto.username,
      role: Role.CUSTOMER,
    });
    expect(response.body.customer).toMatchObject({
      name: dto.fullName,
      phone: dto.phone,
    });
    expect(JSON.stringify(response.body)).not.toContain('password');

    const storedUser = await prisma.user.findUniqueOrThrow({
      where: { username: dto.username },
      include: { customer: true },
    });
    expect(storedUser.customer?.userId).toBe(storedUser.id);
    await expect(
      bcrypt.compare(dto.password, storedUser.password),
    ).resolves.toBe(true);
  });

  it('trả 409 khi username trùng', async () => {
    const first = registration('duplicate-username');
    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(first)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send({
        ...registration('duplicate-username-other'),
        username: first.username,
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.errorCode).toBe('USERNAME_ALREADY_EXISTS');
      });
  });

  it('trả 409 khi email trùng theo unique constraint thực tế của User', async () => {
    const first = registration('duplicate-email');
    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(first)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send({ ...registration('duplicate-email-other'), email: first.email })
      .expect(409)
      .expect(({ body }) => {
        expect(body.errorCode).toBe('EMAIL_ALREADY_EXISTS');
      });
  });

  it('rollback User khi tạo Customer thất bại do phone trùng', async () => {
    const dto = registration('rollback');
    await prisma.customer.create({
      data: {
        code: `IT-M1-${suffix}-PHONE`,
        name: 'Phone conflict fixture',
        phone: dto.phone,
      },
    });

    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(dto)
      .expect(409)
      .expect(({ body }) => {
        expect(body.errorCode).toBe('PHONE_ALREADY_EXISTS');
      });

    await expect(
      prisma.user.findUnique({ where: { username: dto.username } }),
    ).resolves.toBeNull();
  });

  it('chỉ tạo một tài khoản khi hai request đăng ký đồng thời', async () => {
    const dto = registration('concurrent');
    const responses = await Promise.all([
      request(app.getHttpServer()).post('/auth/register/customer').send(dto),
      request(app.getHttpServer()).post('/auth/register/customer').send(dto),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    await expect(
      prisma.user.count({ where: { username: dto.username } }),
    ).resolves.toBe(1);
    await expect(
      prisma.customer.count({ where: { phone: dto.phone } }),
    ).resolves.toBe(1);
  });

  it('từ chối dữ liệu sai và role injection', async () => {
    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send({
        username: 'x',
        password: 'short',
        fullName: '',
        phone: 'invalid',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send({
        ...registration('role-injection'),
        role: Role.ADMIN,
        branchId: 'injected-branch',
        customerId: 'injected-customer',
      })
      .expect(400);
  });

  it('đăng nhập đúng, sai mật khẩu và tài khoản inactive', async () => {
    const active = registration('login-active');
    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(active)
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: active.username, pass: active.password })
      .expect(201)
      .expect(({ body }) => {
        expect(body.accessToken).toEqual(expect.any(String));
        expect(body.user.role).toBe(Role.CUSTOMER);
      });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: active.username, pass: 'WrongPass123' })
      .expect(401);

    const inactive = registration('login-inactive');
    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(inactive)
      .expect(201);
    await prisma.user.update({
      where: { username: inactive.username },
      data: { active: false },
    });

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: inactive.username, pass: inactive.password })
      .expect(401);
  });

  it('JWT hợp lệ đọc profile và JWT sai bị từ chối', async () => {
    const dto = registration('profile');
    await request(app.getHttpServer())
      .post('/auth/register/customer')
      .send(dto)
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username: dto.username, password: dto.password })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get('/auth/profile')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
    expect(response.body).toMatchObject({
      username: dto.username,
      role: Role.CUSTOMER,
      customer: { phone: dto.phone },
    });
    expect(JSON.stringify(response.body)).not.toContain('password');

    await request(app.getHttpServer())
      .get('/auth/profile')
      .set('Authorization', 'Bearer invalid-token')
      .expect(401);
  });

  it('trả lỗi dữ liệu khi CUSTOMER thiếu Customer relation', async () => {
    const username = `${usernamePrefix}-missing-relation`;
    const password = 'StrongPass123';
    await prisma.user.create({
      data: {
        username,
        password: await bcrypt.hash(password, 4),
        fullName: 'Missing relation',
        role: Role.CUSTOMER,
      },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ username, pass: password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/profile')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(409)
      .expect(({ body }) => {
        expect(body.errorCode).toBe('CUSTOMER_PROFILE_NOT_FOUND');
      });
  });
});
