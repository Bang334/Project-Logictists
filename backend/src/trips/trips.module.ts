import { Module } from '@nestjs/common';
import { TripsService } from './trips.service';
import { TripsController } from './trips.controller';
import { MapboxModule } from '../mapbox/mapbox.module';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { OptimizationJobsService, OPTIMIZATION_QUEUE } from './optimization-jobs.service';
import { OptimizationProcessor } from './optimization.processor';
import { OptimizationRecoveryService } from './optimization-recovery.service';
import { OptimizationJobMetricsService } from './optimization-job-metrics.service';
import { OptimizationJobMetricsController } from './optimization-job-metrics.controller';

function redisConnection(urlValue: string | undefined) {
  const url = new URL(urlValue || 'redis://127.0.0.1:6379');
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw new Error('REDIS_URL phải dùng giao thức redis:// hoặc rediss://');
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

@Module({
  imports: [
    MapboxModule,
    BullModule.registerQueueAsync({
      name: OPTIMIZATION_QUEUE,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnection(config.get<string>('REDIS_URL')),
      }),
    }),
  ],
  providers: [
    TripsService,
    OptimizationJobsService,
    OptimizationProcessor,
    OptimizationRecoveryService,
    OptimizationJobMetricsService,
  ],
  controllers: [TripsController, OptimizationJobMetricsController],
  exports: [TripsService, OptimizationJobsService],
})
export class TripsModule {}
