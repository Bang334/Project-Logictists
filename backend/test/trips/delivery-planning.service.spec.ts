import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { DeliveryPlanningService } from '../../src/trips/delivery-planning.service';
import {
  normalizeRecipientPhone,
  recipientLink,
  verifyRecipientToken,
} from '../../src/common/services/delivery-sms';
import { DeliveryResponse } from '../../src/trips/dto/delivery-planning.dto';

describe('DeliveryPlanningService expiration polling', () => {
  it('skips timer ticks during a stalled scan and resumes after a failed scan', async () => {
    jest.useFakeTimers();
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const findMany = jest.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Pool timeout')), 32_000);
      }))
      .mockResolvedValue([]);
    const service = new DeliveryPlanningService(
      { deliveryPlanningBatch: { findMany } } as never,
      {} as never, {} as never, {} as never, {} as never,
    );

    try {
      service.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(findMany).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(15_000);
      expect(log).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledTimes(2);
    } finally {
      service.onModuleDestroy();
      log.mockRestore();
      jest.useRealTimers();
    }
  });
});

describe('Recipient SMS link and validation', () => {
  const prevSecret = process.env.DELIVERY_LINK_SECRET;

  beforeEach(() => {
    process.env.DELIVERY_LINK_SECRET = 'test-delivery-link-secret-32-chars-min';
  });

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.DELIVERY_LINK_SECRET;
    else process.env.DELIVERY_LINK_SECRET = prevSecret;
  });

  it('signs and verifies recipient link token with timing-safe HMAC', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const url = recipientLink({ id }, 'https://tms.example.com/');
    expect(url.startsWith('https://tms.example.com/hen-giao#')).toBe(true);
    const token = new URL(url).hash.slice(1);
    expect(verifyRecipientToken(token)).toBe(id);
    expect(() => verifyRecipientToken(`${token}x`)).toThrow(NotFoundException);
    expect(() => verifyRecipientToken('not-a-valid-token')).toThrow(NotFoundException);
  });

  it('normalizes Vietnamese and E.164 recipient phones', () => {
    expect(normalizeRecipientPhone('0901 234 567')).toBe('+84901234567');
    expect(normalizeRecipientPhone('84901234567')).toBe('+84901234567');
    expect(normalizeRecipientPhone('+84-901-234-567')).toBe('+84901234567');
    expect(() => normalizeRecipientPhone('000')).toThrow('Số điện thoại người nhận không hợp lệ');
  });

  it('masks expired PENDING recipient links as EXPIRED and rejects invalid recipient decisions', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const token = new URL(recipientLink({ id }, 'https://tms.example.com')).hash.slice(1);
    const service = new DeliveryPlanningService(
      {
        deliveryAppointment: {
          findFirst: jest.fn().mockResolvedValue({
            id,
            batchId: 'b1',
            orderId: 'o1',
            windowStart: new Date('2031-01-03T02:00:00Z'),
            windowEnd: new Date('2031-01-03T04:00:00Z'),
            expiresAt: new Date('2020-01-01T00:00:00Z'),
            status: 'PENDING',
            version: 1,
            requestedStart: null,
            requestedEnd: null,
            responseNote: null,
            order: { orderNumber: 'DH-001' },
            batch: { status: 'OFFERING' },
          }),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const view = await service.recipientAppointment(token);
    expect(view.status).toBe('EXPIRED');
    expect(() =>
      service.respondAsRecipient(token, {
        version: 1,
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        decision: DeliveryResponse.DECLINED,
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.respondAsRecipient(token, {
        version: 1,
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        decision: DeliveryResponse.CHANGE_REQUESTED,
        requestedStart: '2031-01-03T02:00:00Z',
      }),
    ).toThrow('Cần chọn ngày và đủ hai mốc giờ');
  });
});
