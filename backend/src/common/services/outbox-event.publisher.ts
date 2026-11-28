import { Injectable, Optional } from '@nestjs/common';
import { OutboxEvent, Prisma } from '@prisma/client';
import { EventsGateway } from '../../events/events.gateway';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { formatDeliverySmsWindow, recipientLink } from './delivery-sms';

type PublishableOutboxEvent = Pick<
  OutboxEvent,
  'eventId' | 'eventType' | 'aggregateType' | 'aggregateId' | 'aggregateVersion' | 'payload' | 'createdAt'
>;

@Injectable()
export class OutboxEventPublisher {
  constructor(
    private readonly eventsGateway: EventsGateway,
    @InjectQueue('optimization') private readonly optimizationQueue: Queue,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async publish(event: PublishableOutboxEvent): Promise<void> {
    if (event.eventType === 'DELIVERY_SMS_OFFERED' || event.eventType === 'DELIVERY_SMS_SCHEDULED') {
      await this.publishDeliverySms(event);
      return;
    }
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
    if (
      [
        'TRIP_CREATED',
        'TRIP_PUBLISHED',
        'TRIP_PLAN_UPDATED',
        'OPTIMIZATION_TRIP_APPLIED',
        'TRIP_DELIVERY_FAILED',
        'TRIP_PICKUP_CONFIRMED',
        'TRIP_DELIVERY_CONFIRMED',
        'TRIP_RETURNED_TO_HUB',
      ].includes(event.eventType)
    ) {
      await this.eventsGateway.emitTripUpdate({ id: event.aggregateId });
      return;
    }
    if (event.eventType === 'OPTIMIZATION_JOB_CREATED') {
      await this.publishOptimizationJob(event);
      return;
    }
    throw new Error('Không có transport cho event type ' + event.eventType);
  }

  private async publishDeliverySms(event: PublishableOutboxEvent): Promise<void> {
    if (!this.prisma) {
      throw new Error('Thiếu PrismaService để gửi SMS hẹn giao');
    }
    const row = await this.prisma.deliveryAppointment.findUnique({
      where: { id: event.aggregateId },
      include: { batch: { select: { status: true } }, order: { select: { orderNumber: true } } },
    });
    if (!row?.recipientPhone || row.version !== event.aggregateVersion) return;
    const offered = event.eventType === 'DELIVERY_SMS_OFFERED';
    if (
      offered
        ? row.status !== 'PENDING' || row.batch.status !== 'OFFERING' || row.expiresAt <= new Date()
        : row.status !== 'SCHEDULED'
    ) {
      return;
    }

    const webhook = process.env.DELIVERY_SMS_WEBHOOK_URL;
    const webhookToken = process.env.DELIVERY_SMS_WEBHOOK_TOKEN;
    const publicUrl = process.env.DELIVERY_PUBLIC_WEB_URL;
    if (!webhook || !webhookToken || (offered && !publicUrl)) {
      throw new Error('Thiếu cấu hình dịch vụ SMS');
    }
    const windowLabel = formatDeliverySmsWindow(row.windowStart, row.windowEnd);
    const message = offered
      ? `Đơn ${row.order.orderNumber}: dự kiến giao ${windowLabel}. Xác nhận hoặc đổi giờ: ${recipientLink(row, publicUrl)}`
      : `Đơn ${row.order.orderNumber}: đã chốt lịch giao ${windowLabel}.`;

    const response = await fetch(webhook, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${webhookToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': event.eventId,
      },
      body: JSON.stringify({ to: row.recipientPhone, message }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new Error(`Dịch vụ SMS trả HTTP ${response.status}`);
    }
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
