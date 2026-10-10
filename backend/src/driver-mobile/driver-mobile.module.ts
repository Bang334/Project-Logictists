import { Module } from "@nestjs/common";
import { DriverMobileController } from "./driver-mobile.controller";
import { DriverMobileService } from "./driver-mobile.service";
import { DriverExecutionService } from "./driver-execution.service";
import { DriverPickupService } from "./driver-pickup.service";
@Module({
  controllers: [DriverMobileController],
  providers: [DriverMobileService, DriverExecutionService, DriverPickupService],
})
export class DriverMobileModule {}
