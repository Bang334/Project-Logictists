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
});
