import { Module } from "@nestjs/common";
import { TripsService } from "./trips.service";
import { TripsController } from "./trips.controller";
import { MapboxModule } from "../mapbox/mapbox.module";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  OptimizationJobsService,
  OPTIMIZATION_QUEUE,
} from "./optimization-jobs.service";
import { OptimizationProcessor } from "./optimization.processor";
import { OptimizationRecoveryService } from "./optimization-recovery.service";
import { OptimizationJobMetricsService } from "./optimization-job-metrics.service";
import { OptimizationJobMetricsController } from "./optimization-job-metrics.controller";
import { DriverTripsController } from "./driver-trips.controller";
import { DriverTripsService } from "./driver-trips.service";
import { DriverTripExecutionController } from "./driver-trip-execution.controller";
import { DriverTripExecutionService } from "./driver-trip-execution.service";
import { DriverPodController } from "./driver-pod.controller";
import { DriverPodService } from "./driver-pod.service";
import { DriverGpsController } from "./driver-gps.controller";
import { DriverGpsService } from "./driver-gps.service";
import { TripTrackingController } from "./trip-tracking.controller";
import { DriverIncidentsController } from "./driver-incidents.controller";
import { DriverIncidentsService } from "./driver-incidents.service";

function redisConnection(urlValue: string | undefined) {
  const url = new URL(urlValue || "redis://127.0.0.1:6379");
  if (!["redis:", "rediss:"].includes(url.protocol)) {
    throw new Error("REDIS_URL phải dùng giao thức redis:// hoặc rediss://");
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
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
        connection: redisConnection(config.get<string>("REDIS_URL")),
      }),
    }),
  ],
  providers: [
    TripsService,
    OptimizationJobsService,
    OptimizationProcessor,
    OptimizationRecoveryService,
    OptimizationJobMetricsService,
    DriverTripsService,
    DriverTripExecutionService,
    DriverPodService,
    DriverGpsService,
    DriverIncidentsService,
  ],
  controllers: [
    TripsController,
    DriverTripsController,
    DriverTripExecutionController,
    DriverPodController,
    DriverGpsController,
    TripTrackingController,
    DriverIncidentsController,
    OptimizationJobMetricsController,
  ],
  exports: [TripsService, OptimizationJobsService],
})
export class TripsModule {}
