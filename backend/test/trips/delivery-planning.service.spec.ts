import { Logger } from '@nestjs/common';
import { DeliveryPlanningService } from '../../src/trips/delivery-planning.service';

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
