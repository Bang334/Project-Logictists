import { Module } from '@nestjs/common';
import { DriverMobileModule } from './driver-mobile/driver-mobile.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { DriversModule } from './drivers/drivers.module';
import { CustomersModule } from './customers/customers.module';
import { OrdersModule } from './orders/orders.module';
import { TripsModule } from './trips/trips.module';
import { MapboxModule } from './mapbox/mapbox.module';
import { EventsModule } from './events/events.module';
import { UsersModule } from './users/users.module';

import { CommonModule } from './common/common.module';
import { CatalogModule } from './catalog/catalog.module';
import { InventoryModule } from './inventory/inventory.module';
import { SalesOrdersModule } from './sales-orders/sales-orders.module';
import { AllocationModule } from './allocation/allocation.module';
import { OrderProcessingModule } from './fulfillment/fulfillment.module';
import { PickupModule } from './pickup/pickup.module';
import { RetailAnalyticsModule } from './retail-analytics/retail-analytics.module';
import { FeedbackModule } from './feedback/feedback.module';
import { LocationsModule } from './locations/locations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        config.CORS_ORIGIN = config.CORS_ORIGIN || config.WEB_ORIGIN;
        const required = [
          'DATABASE_URL',
          'JWT_SECRET',
          'CORS_ORIGIN',
        ];
        const missing = required.filter(
          (key) => typeof config[key] !== 'string' || !(config[key] as string).trim(),
        );
        if (missing.length > 0) {
          throw new Error(`Thiếu biến môi trường bắt buộc: ${missing.join(', ')}`);
        }
        if (
          config.NODE_ENV === 'production' &&
          (typeof config.REDIS_URL !== 'string' || !config.REDIS_URL.trim())
        ) {
          throw new Error('Thiếu biến môi trường bắt buộc: REDIS_URL');
        }
        if (typeof config.REDIS_URL === 'string') {
          const redisUrl = new URL(config.REDIS_URL);
          if (!['redis:', 'rediss:'].includes(redisUrl.protocol)) {
            throw new Error('REDIS_URL phải dùng redis:// hoặc rediss://');
          }
        }
        if ((config.JWT_SECRET as string).length < 32) {
          throw new Error('JWT_SECRET phải có ít nhất 32 ký tự');
        }
        if (
          typeof config.STORAGE_SIGNING_SECRET === 'string' &&
          config.STORAGE_SIGNING_SECRET.length < 32
        ) {
          throw new Error('STORAGE_SIGNING_SECRET phải có ít nhất 32 ký tự');
        }
        if ((config.CORS_ORIGIN as string).trim() === '*') {
          throw new Error('CORS_ORIGIN không được là * khi API cho phép credentials');
        }
        const webhookUrl = config.OUTBOX_NOTIFICATION_WEBHOOK_URL;
        const webhookSecret = config.OUTBOX_NOTIFICATION_WEBHOOK_SECRET;
        if (Boolean(webhookUrl) !== Boolean(webhookSecret)) {
          throw new Error(
            'OUTBOX_NOTIFICATION_WEBHOOK_URL và OUTBOX_NOTIFICATION_WEBHOOK_SECRET phải được cấu hình cùng nhau',
          );
        }
        if (typeof webhookSecret === 'string' && webhookSecret.length < 32) {
          throw new Error('OUTBOX_NOTIFICATION_WEBHOOK_SECRET phải có ít nhất 32 ký tự');
        }
        if (typeof webhookUrl === 'string') {
          const parsedWebhookUrl = new URL(webhookUrl);
          const localDevelopmentUrl =
            config.NODE_ENV !== 'production' &&
            parsedWebhookUrl.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(parsedWebhookUrl.hostname);
          if (parsedWebhookUrl.protocol !== 'https:' && !localDevelopmentUrl) {
            throw new Error('Notification webhook phải dùng HTTPS ngoài môi trường local');
          }
        }
        for (const key of [
          'OUTBOX_POLL_INTERVAL_MS',
          'OUTBOX_BATCH_SIZE',
          'OUTBOX_LEASE_MS',
          'OUTBOX_MAX_ATTEMPTS',
          'OUTBOX_RETRY_BASE_MS',
          'STORAGE_MAX_FILE_BYTES',
        ]) {
          if (config[key] !== undefined && (!Number.isInteger(Number(config[key])) || Number(config[key]) <= 0)) {
            throw new Error(`${key} phải là số nguyên dương`);
          }
        }
        return config;
      },
    }),
    PrismaModule,
    DriverMobileModule,
    CommonModule,
    CatalogModule,
    InventoryModule,
    SalesOrdersModule,
    AllocationModule,
    OrderProcessingModule,
    PickupModule,
    RetailAnalyticsModule,
    FeedbackModule,
    LocationsModule,
    MapboxModule,
    EventsModule,
    AuthModule,
    UsersModule,
    BranchesModule,
    VehiclesModule,
    DriversModule,
    CustomersModule,
    OrdersModule,
    TripsModule,
  ],
})
export class AppModule {}
