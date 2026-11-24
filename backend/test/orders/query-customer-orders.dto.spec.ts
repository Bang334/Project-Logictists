import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { QueryCustomerOrdersDto } from '../../src/orders/dto/query-customer-orders.dto';

describe('QueryCustomerOrdersDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = { type: 'query' as const, metatype: QueryCustomerOrdersDto };

  it('áp dụng page=1, limit=20 mặc định', async () => {
    await expect(pipe.transform({}, metadata)).resolves.toMatchObject({
      page: 1,
      limit: 20,
    });
  });

  it('transform query hợp lệ và nhận OrderStatus', async () => {
    await expect(
      pipe.transform(
        { page: '2', limit: '50', status: OrderStatus.CONFIRMED },
        metadata,
      ),
    ).resolves.toMatchObject({
      page: 2,
      limit: 50,
      status: OrderStatus.CONFIRMED,
    });
  });

  it.each([
    { page: '0' },
    { page: '1.5' },
    { limit: '0' },
    { limit: '101' },
    { status: 'UNKNOWN' },
    { customerId: 'injected' },
    { branchId: 'injected' },
  ])('từ chối query không hợp lệ %#', async (query) => {
    await expect(pipe.transform(query, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
