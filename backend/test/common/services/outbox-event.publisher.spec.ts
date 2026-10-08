import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { OutboxEventPublisher } from '../../../src/common/services/outbox-event.publisher';
import { EventsGateway } from '../../../src/events/events.gateway';
import { encryptSensitivePayload } from '../../../src/common/security/sensitive-payload.crypto';

jest.mock('axios');

describe('OutboxEventPublisher', () => {
  const config = { get: jest.fn(), getOrThrow: jest.fn() } as unknown as ConfigService;
  const gateway = { emitToLocations: jest.fn(), emitTripUpdate: jest.fn() } as unknown as EventsGateway;
  const optimizationQueue = { add: jest.fn() };
  const publisher = new OutboxEventPublisher(config, gateway, optimizationQueue as never);
  const baseEvent = {
    eventId: 'event-1',
    aggregateType: 'SalesOrder',
    aggregateId: 'order-1',
    aggregateVersion: 1,
    createdAt: new Date('2026-09-23T00:00:00.000Z'),
  };

  beforeEach(() => jest.clearAllMocks());

  it.each(['driver.assignment.accepted', 'driver.assignment.rejected'])('delivers %s without leaking manifest/rejection reason', async eventType => {
    await publisher.publish({ ...baseEvent, aggregateType: 'DriverAssignment', aggregateId: 'assignment-1', eventType, payload: { tripId: 'trip-1', assignmentId: 'assignment-1', version: 2 } });
    expect(gateway.emitTripUpdate).toHaveBeenCalledWith({ id: 'trip-1' });
    expect(gateway.emitToLocations).not.toHaveBeenCalled();
  });

  it.each(['TRIP_CREATED', 'TRIP_PUBLISHED', 'TRIP_PLAN_UPDATED', 'OPTIMIZATION_TRIP_APPLIED'])('delivers %s through the scoped trip gateway', async eventType => {
    await publisher.publish({ ...baseEvent, aggregateType: 'Trip', aggregateId: 'trip-1', eventType, payload: {} });
    expect(gateway.emitTripUpdate).toHaveBeenCalledWith({ id: 'trip-1' });
    expect(gateway.emitToLocations).not.toHaveBeenCalled();
  });

  it('đưa optimization job vào queue từ durable outbox event', async () => {
    await publisher.publish({
      ...baseEvent,
      eventType: 'OPTIMIZATION_JOB_CREATED',
      aggregateType: 'OptimizationJob',
      aggregateId: 'job-1',
      payload: { jobId: 'job-1', branchId: 'branch-1' },
    });

    expect(optimizationQueue.add).toHaveBeenCalledWith(
      'run-automatic-optimization',
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1', attempts: 3 }),
    );
  });

  it('chỉ phát event vận hành vào location room và loại dữ liệu nhạy cảm', async () => {
    await publisher.publish({
      ...baseEvent,
      eventType: 'SALES_ORDER_CONFIRMED',
      payload: {
        pickupPointId: 'location-1',
        orderNumber: 'SO-1',
        customerPhone: '0900000000',
      },
    });

    expect(gateway.emitToLocations).toHaveBeenCalledWith(
      ['location-1'],
      'retail:event',
      expect.objectContaining({
        eventId: 'event-1',
        payload: { pickupPointId: 'location-1', orderNumber: 'SO-1' },
      }),
    );
  });

  it('không phát OTP/QR qua socket khi notification webhook chưa cấu hình', async () => {
    (config.get as jest.Mock).mockReturnValue(undefined);
    await expect(
      publisher.publish({
        ...baseEvent,
        eventType: 'RETAIL_READY_FOR_COLLECTION',
        payload: { otpCode: '123456', qrToken: 'secret' },
      }),
    ).rejects.toThrow('Chưa cấu hình notification webhook');
    expect(gateway.emitToLocations).not.toHaveBeenCalled();
  });

  it('ký HMAC khi gửi credential qua notification webhook', async () => {
    (config.get as jest.Mock).mockImplementation((key: string) =>
      key === 'OUTBOX_NOTIFICATION_WEBHOOK_URL'
        ? 'https://notify.example.test/events'
        : key === 'OUTBOX_NOTIFICATION_WEBHOOK_SECRET'
          ? 'a-secure-webhook-secret'
          : key === 'COLLECTION_TOKEN_SECRET'
            ? 'a-secure-collection-secret'
          : undefined,
    );
    (axios.post as jest.Mock).mockResolvedValue({ status: 204 });

    await publisher.publish({
      ...baseEvent,
      eventType: 'RETAIL_READY_FOR_COLLECTION',
      payload: {
        encryptedCredential: encryptSensitivePayload(
          { otpCode: '123456', qrToken: 'secret' },
          'a-secure-collection-secret',
        ),
      },
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://notify.example.test/events',
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-tms-event-id': 'event-1',
          'x-tms-signature-sha256': expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });
});
