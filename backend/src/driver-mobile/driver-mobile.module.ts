import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { DriverContinuationService } from "./driver-continuation.service";
import { DriverMobileController } from "./driver-mobile.controller";
import { DriverMobileService } from "./driver-mobile.service";
@Module({
  imports: [SettingsModule],
  controllers: [DriverMobileController],
  providers: [DriverMobileService, DriverContinuationService],
  exports: [DriverContinuationService],
})
export class DriverMobileModule {}
