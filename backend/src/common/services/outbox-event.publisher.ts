import { Injectable } from '@nestjs/common';
import { OutboxEvent, Prisma } from '@prisma/client';
import { EventsGateway } from '../../events/events.gateway';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

type PublishableOutboxEvent = Pick<
  OutboxEvent,
  'eventId' | 'eventType' | 'aggregateType' | 'aggregateId' | 'aggregateVersion' | 'payload' | 'createdAt'
>;

@Injectable()
export class OutboxEventPublisher {
  constructor(
    private readonly eventsGateway: EventsGateway,
    @InjectQueue('optimization') private readonly optimizationQueue: Queue,
  ) {}

  async publish(event: PublishableOutboxEvent): Promise<void> {
    if (event.eventType === 'DELIVERY_APPOINTMENT_UPDATED') {
      const payload = this.asObject(event.payload);
      if (typeof payload.customerId !== 'string' || typeof payload.appointmentId !== 'string') throw new Error('Delivery event thiếu scope');
      await this.eventsGateway.emitDeliveryAppointment(payload.customerId, payload.appointmentId, event.aggregateVersion);
      return;
    }
    if (['driver.assignment.accepted', 'driver.assignment.rejected'].includes(event.eventType)) {
      const payload = this.asObject(event.payload);
      if (typeof payload.tripId !== 'string') throw new Error('Driver assignment event thiếu tripId');
      // Existing gateway reauthorizes each dispatcher before snapshot invalidation.
      await this.eventsGateway.emitTripUpdate({ id: payload.tripId });
      return;
    }
    if (['TRIP_CREATED', 'TRIP_PUBLISHED', 'TRIP_PLAN_UPDATED', 'OPTIMIZATION_TRIP_APPLIED'].includes(event.eventType)) {
      await this.eventsGateway.emitTripUpdate({ id: event.aggregateId });
      return;
    }
    if (event.eventType === 'OPTIMIZATION_JOB_CREATED') {
      await this.publishOptimizationJob(event);
      return;
    }
    throw new Error('Không có transport cho event type ' + event.eventType);
  }

  private async publishOptimizationJob(event: PublishableOutboxEvent) {
    const payload = this.asObject(event.payload);
    const jobId = payload.jobId;
    if (typeof jobId !== 'string' || jobId !== event.aggregateId) {
      throw new Error('Optimization outbox event có jobId không hợp lệ');
    }
    await this.optimizationQueue.add(
      'run-automatic-optimization',
      { jobId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  }

  private asObject(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
      throw new Error('Outbox payload phải là JSON object');
    }
    return payload as Record<string, Prisma.JsonValue>;
  }
}
