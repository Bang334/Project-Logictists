import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from '../../src/auth/dto/login.dto';
import { RegisterCustomerDto } from '../../src/auth/dto/register-customer.dto';

describe('Auth DTO', () => {
  it('chuẩn hóa dữ liệu đăng ký hợp lệ', async () => {
    const dto = plainToInstance(RegisterCustomerDto, {
      username: '  Customer.One  ',
      password: 'StrongPass123',
      fullName: '  Nguyễn   Văn A ',
      phone: '090-123-4567',
      email: '  USER@EXAMPLE.COM ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      username: 'customer.one',
      fullName: 'Nguyễn Văn A',
      phone: '0901234567',
      email: 'user@example.com',
    });
  });

  it('từ chối dữ liệu đăng ký sai định dạng', async () => {
    const dto = plainToInstance(RegisterCustomerDto, {
      username: 'a',
      password: 'short',
      fullName: '',
      phone: 'abc',
      email: 'invalid-email',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining([
        'username',
        'password',
        'fullName',
        'phone',
        'email',
      ]),
    );
  });

  it('từ chối role, branchId và customerId do client chèn vào', async () => {
    const dto = plainToInstance(RegisterCustomerDto, {
      username: 'customer.one',
      password: 'StrongPass123',
      fullName: 'Nguyễn Văn A',
      phone: '0901234567',
      role: 'ADMIN',
      branchId: 'branch-injected',
      customerId: 'customer-injected',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['role', 'branchId', 'customerId']),
    );
  });

  it('giữ tương thích cả pass cũ và password mới khi đăng nhập', async () => {
    const legacyDto = plainToInstance(LoginDto, {
      username: 'admin',
      pass: 'password',
    });
    const newDto = plainToInstance(LoginDto, {
      username: 'customer',
      password: 'password',
    });

    await expect(validate(legacyDto)).resolves.toHaveLength(0);
    await expect(validate(newDto)).resolves.toHaveLength(0);
  });
});
