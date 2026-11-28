import { OutboxEventPublisher } from '../../../src/common/services/outbox-event.publisher';
import { EventsGateway } from '../../../src/events/events.gateway';

describe('OutboxEventPublisher', () => {
  const gateway = { emitToLocations: jest.fn(), emitTripUpdate: jest.fn(), emitDeliveryAppointment: jest.fn() } as unknown as EventsGateway;
  const optimizationQueue = { add: jest.fn() };
  const publisher = new OutboxEventPublisher(gateway, optimizationQueue as never);
  const baseEvent = {
    eventId: 'event-1',
    aggregateType: 'Order',
    aggregateId: 'order-1',
    aggregateVersion: 1,
    createdAt: new Date('2026-09-23T00:00:00.000Z'),
  };

  beforeEach(() => jest.clearAllMocks());

  it('phát thông báo hẹn nhận hàng theo customer scope, chỉ có metadata', async () => {
    await publisher.publish({ ...baseEvent, aggregateType: 'DeliveryAppointment', aggregateId: 'appointment-1', eventType: 'DELIVERY_APPOINTMENT_UPDATED', payload: { customerId: 'customer-1', appointmentId: 'appointment-1' } });
    expect(gateway.emitDeliveryAppointment).toHaveBeenCalledWith('customer-1', 'appointment-1', 1);
    expect(gateway.emitToLocations).not.toHaveBeenCalled();
  });

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

  it('gửi SMS hẹn giao và SMS chốt lịch qua webhook kèm Idempotency-Key, bỏ qua đơn hết hạn', async () => {
    const row = {
      id: 'f24d4850-3c27-4a4c-9294-17c346af84a5',
      version: 1,
      status: 'PENDING',
      recipientPhone: '+84900000000',
      batch: { status: 'OFFERING' },
      order: { orderNumber: 'ORDER-SMS-1' },
      expiresAt: new Date(Date.now() + 60_000),
      windowStart: new Date('2031-01-09T02:00:00Z'),
      windowEnd: new Date('2031-01-09T04:00:00Z'),
    };
    const prisma = { deliveryAppointment: { findUnique: jest.fn().mockResolvedValue(row) } };
    const smsPublisher = new OutboxEventPublisher(gateway, optimizationQueue as never, prisma as never);
    const send = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const prevEnv = { ...process.env };
    process.env.DELIVERY_SMS_WEBHOOK_URL = 'https://notifications.example.com/sms';
    process.env.DELIVERY_SMS_WEBHOOK_TOKEN = 'test-sms-token';
    process.env.DELIVERY_PUBLIC_WEB_URL = 'https://tms.example.com';
    process.env.DELIVERY_LINK_SECRET = 'test-link-secret-at-least-32-characters';
    try {
      const event = { ...baseEvent, aggregateId: row.id, eventType: 'DELIVERY_SMS_OFFERED', payload: {} };
      await smsPublisher.publish(event);
      await smsPublisher.publish(event);
      expect(send).toHaveBeenCalledTimes(2);
      const [url, request] = send.mock.calls[0];
      expect(url).toBe('https://notifications.example.com/sms');
      expect(request?.headers).toMatchObject({
        Authorization: 'Bearer test-sms-token',
        'Idempotency-Key': event.eventId,
      });
      expect(JSON.parse(String(request?.body))).toMatchObject({
        to: '+84900000000',
        message: expect.stringContaining('https://tms.example.com/hen-giao#'),
      });
      expect(send.mock.calls[1][1]?.body).toBe(request?.body);

      row.expiresAt = new Date(0);
      await smsPublisher.publish(event);
      expect(send).toHaveBeenCalledTimes(2);

      row.status = 'SCHEDULED';
      await smsPublisher.publish({ ...event, eventType: 'DELIVERY_SMS_SCHEDULED' });
      expect(send).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(send.mock.calls[2][1]?.body))).toMatchObject({
        to: '+84900000000',
        message: expect.stringContaining('đã chốt lịch giao'),
      });
    } finally {
      process.env = prevEnv;
      send.mockRestore();
    }
  });
});
