import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { BigIntSerializationInterceptor } from '../../../src/common/interceptors/bigint-serialization.interceptor';

describe('BigIntSerializationInterceptor', () => {
  it('makes nested Prisma BigInt values JSON serializable without changing other values', async () => {
    const createdAt = new Date('2026-10-01T00:00:00.000Z');
    const interceptor = new BigIntSerializationInterceptor();
    const next: CallHandler = {
      handle: () =>
        of({
          id: 'product-1',
          createdAt,
          skus: [{ volumeMm3: 1234567890123456789n }],
        }),
    };

    const result = await firstValueFrom(
      interceptor.intercept({} as ExecutionContext, next),
    );

    expect(result).toEqual({
      id: 'product-1',
      createdAt,
      skus: [{ volumeMm3: '1234567890123456789' }],
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
