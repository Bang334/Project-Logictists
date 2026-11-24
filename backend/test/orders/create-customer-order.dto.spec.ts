import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateCustomerOrderDto } from '../../src/orders/dto/create-customer-order.dto';

describe('CreateCustomerOrderDto', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const metadata = { type: 'body' as const, metatype: CreateCustomerOrderDto };
  const validBody = () => ({
    idempotencyKey: randomUUID(),
    branchId: randomUUID(),
    pickup: {
      address: ' Kho lấy hàng ',
      latitude: 10.75,
      longitude: 106.67,
      contactName: ' Người gửi ',
      contactPhone: '090-123-4567',
    },
    delivery: {
      address: 'Điểm giao',
      latitude: 21.02,
      longitude: 105.84,
      contactName: 'Người nhận',
      contactPhone: '+84901234568',
    },
    items: [
      {
        description: 'Kiện máy móc',
        quantity: 500,
        unitWeightKg: 1_000,
        lengthCm: 1_000,
        widthCm: 300,
        heightCm: 300,
      },
    ],
    notes: ' Cần kiểm tra thủ công ',
  });

  it('nhận đúng các biên trên và chuẩn hóa chuỗi/số điện thoại', async () => {
    await expect(pipe.transform(validBody(), metadata)).resolves.toMatchObject({
      pickup: {
        address: 'Kho lấy hàng',
        contactName: 'Người gửi',
        contactPhone: '0901234567',
      },
      items: [
        {
          quantity: 500,
          unitWeightKg: 1_000,
          lengthCm: 1_000,
          widthCm: 300,
          heightCm: 300,
        },
      ],
      notes: 'Cần kiểm tra thủ công',
    });
  });

  it('nhận từ 1 đến 20 loại kiện', async () => {
    const body = validBody();
    body.items = Array.from({ length: 20 }, () => ({ ...body.items[0] }));
    await expect(pipe.transform(body, metadata)).resolves.toBeDefined();
  });

  it.each([
    ['quantity bằng 0', (body: ReturnType<typeof validBody>) => (body.items[0].quantity = 0)],
    ['quantity vượt 500', (body: ReturnType<typeof validBody>) => (body.items[0].quantity = 501)],
    ['quantity không nguyên', (body: ReturnType<typeof validBody>) => (body.items[0].quantity = 1.5)],
    ['unitWeightKg bằng 0', (body: ReturnType<typeof validBody>) => (body.items[0].unitWeightKg = 0)],
    ['unitWeightKg vượt 1000', (body: ReturnType<typeof validBody>) => (body.items[0].unitWeightKg = 1_001)],
    ['length vượt 1000', (body: ReturnType<typeof validBody>) => (body.items[0].lengthCm = 1_001)],
    ['width vượt 300', (body: ReturnType<typeof validBody>) => (body.items[0].widthCm = 301)],
    ['height vượt 300', (body: ReturnType<typeof validBody>) => (body.items[0].heightCm = 301)],
    ['latitude vượt biên', (body: ReturnType<typeof validBody>) => (body.pickup.latitude = 91)],
    ['longitude vượt biên', (body: ReturnType<typeof validBody>) => (body.delivery.longitude = -181)],
    ['điện thoại sai', (body: ReturnType<typeof validBody>) => (body.pickup.contactPhone = 'abc')],
  ])('từ chối %s', async (_label, mutate) => {
    const body = validBody();
    mutate(body);
    await expect(pipe.transform(body, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('từ chối quá 20 loại kiện, NaN/Infinity và field đặc quyền', async () => {
    const tooMany = validBody();
    tooMany.items = Array.from({ length: 21 }, () => ({ ...tooMany.items[0] }));
    await expect(pipe.transform(tooMany, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const nonFinite = validBody();
    nonFinite.items[0].unitWeightKg = Number.POSITIVE_INFINITY;
    await expect(pipe.transform(nonFinite, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await expect(
      pipe.transform(
        { ...validBody(), customerId: randomUUID(), status: 'CONFIRMED' },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('không ép chuỗi hoặc boolean thành số hợp lệ', async () => {
    const body = validBody() as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    items[0].quantity = '5';
    items[0].unitWeightKg = true;
    await expect(pipe.transform(body, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
