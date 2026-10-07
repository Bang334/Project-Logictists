import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxEvent, Prisma } from '@prisma/client';
import axios from 'axios';
import { createHmac } from 'crypto';
import { EventsGateway } from '../../events/events.gateway';
import { decryptSensitivePayload } from '../security/sensitive-payload.crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

type PublishableOutboxEvent = Pick<
  OutboxEvent,
  'eventId' | 'eventType' | 'aggregateType' | 'aggregateId' | 'aggregateVersion' | 'payload' | 'createdAt'
>;

const SOCKET_EVENT_TYPES = new Set([
  'SALES_ORDER_CONFIRMED',
  'SALES_ORDER_CANCELLED',
  'SALES_ORDER_ALLOCATED',
  'RETAIL_FULFILLMENT_CREATED',
  'RETAIL_PICKING_COMPLETED',
  'RETAIL_PACKAGE_READY_FOR_TRANSFER',
  'RETAIL_HANDOVER_COMPLETED',
  'RETAIL_TRANSFER_SHIPMENT_CREATED',
  'RETAIL_CUSTOMER_COLLECTED',
  'RETAIL_PAYMENT_COMPLETED',
  'RETAIL_REFUND_PROCESSED',
]);

@Injectable()
export class OutboxEventPublisher {
  constructor(
    private readonly config: ConfigService,
    private readonly eventsGateway: EventsGateway,
    @InjectQueue('optimization') private readonly optimizationQueue: Queue,
  ) {}

  async publish(event: PublishableOutboxEvent): Promise<void> {
    if (['TRIP_CREATED', 'TRIP_PUBLISHED', 'TRIP_PLAN_UPDATED'].includes(event.eventType)) {
      await this.eventsGateway.emitTripUpdate({ id: event.aggregateId });
      return;
    }
    if (event.eventType === 'OPTIMIZATION_JOB_CREATED') {
      await this.publishOptimizationJob(event);
      return;
    }
    if (event.eventType === 'RETAIL_READY_FOR_COLLECTION') {
      await this.publishCustomerNotification(event);
      return;
    }
    if (!SOCKET_EVENT_TYPES.has(event.eventType)) {
      throw new Error(`Không có transport cho event type ${event.eventType}`);
    }

    const payload = this.asObject(event.payload);
    const locationIds = this.extractLocationIds(payload);
    if (locationIds.length === 0) {
      throw new Error(`Event ${event.eventType} thiếu location scope`);
    }
    const { customerPhone: _customerPhone, otpCode: _otpCode, qrToken: _qrToken, ...safePayload } = payload;
    await this.eventsGateway.emitToLocations(locationIds, 'retail:event', {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      occurredAt: event.createdAt.toISOString(),
      payload: safePayload,
    });
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

  private async publishCustomerNotification(event: PublishableOutboxEvent) {
    const webhookUrl = this.config.get<string>('OUTBOX_NOTIFICATION_WEBHOOK_URL');
    const webhookSecret = this.config.get<string>('OUTBOX_NOTIFICATION_WEBHOOK_SECRET');
    if (!webhookUrl || !webhookSecret) {
      throw new Error('Chưa cấu hình notification webhook cho mã nhận hàng');
    }

    const storedPayload = this.asObject(event.payload);
    const encryptedCredential = storedPayload.encryptedCredential;
    if (typeof encryptedCredential !== 'string') {
      throw new Error('Notification event thiếu encrypted credential');
    }
    const collectionSecret =
      this.config.get<string>('COLLECTION_TOKEN_SECRET') ||
      this.config.getOrThrow<string>('JWT_SECRET');
    const credential = decryptSensitivePayload(encryptedCredential, collectionSecret);
    const { encryptedCredential: _encryptedCredential, ...notificationMetadata } = storedPayload;
    const body = JSON.stringify({
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      occurredAt: event.createdAt.toISOString(),
      payload: { ...notificationMetadata, ...credential },
    });
    const signature = createHmac('sha256', webhookSecret).update(body).digest('hex');
    await axios.post(webhookUrl, body, {
      headers: {
        'content-type': 'application/json',
        'x-tms-event-id': event.eventId,
        'x-tms-signature-sha256': signature,
      },
      timeout: 5000,
    });
  }

  private asObject(payload: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
      throw new Error('Outbox payload phải là JSON object');
    }
    return payload as Record<string, Prisma.JsonValue>;
  }

  private extractLocationIds(payload: Record<string, Prisma.JsonValue>): string[] {
    const keys = [
      'locationId',
      'pickupPointId',
      'sourceLocationId',
      'allocatedSourceId',
      'destinationPickupPointId',
    ];
    return keys
      .map((key) => payload[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  }
}
