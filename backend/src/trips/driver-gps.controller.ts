import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "@prisma/client";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DriverGpsService } from "./driver-gps.service";
import { IngestDriverGpsDto } from "./dto/driver-gps.dto";

@Controller("driver/trips")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.DRIVER)
export class DriverGpsController {
  constructor(private readonly driverGpsService: DriverGpsService) {}

  @Post(":tripId/gps")
  ingest(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Body() dto: IngestDriverGpsDto,
  ) {
    return this.driverGpsService.ingest(req.user.id, tripId, dto);
  }
}
