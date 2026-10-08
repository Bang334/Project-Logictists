import { Module } from "@nestjs/common";
import { DriverMobileController } from "./driver-mobile.controller";
import { DriverMobileService } from "./driver-mobile.service";
@Module({
  controllers: [DriverMobileController],
  providers: [DriverMobileService],
})
export class DriverMobileModule {}
