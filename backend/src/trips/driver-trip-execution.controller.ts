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
import {
  ArriveDriverStopDto,
  CompleteDriverStopDto,
  DriverTripCommandDto,
} from "./dto/driver-trip-command.dto";
import { DriverTripExecutionService } from "./driver-trip-execution.service";

@Controller("driver/trips")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.DRIVER)
export class DriverTripExecutionController {
  constructor(
    private readonly driverTripExecutionService: DriverTripExecutionService,
  ) {}

  @Post(":id/start")
  startTrip(
    @Req() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DriverTripCommandDto,
  ) {
    return this.driverTripExecutionService.startTrip(req.user.id, id, dto);
  }

  @Post(":tripId/stops/:stopId/arrive")
  arriveStop(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Body() dto: ArriveDriverStopDto,
  ) {
    return this.driverTripExecutionService.arriveStop(
      req.user.id,
      tripId,
      stopId,
      dto,
    );
  }

  @Post(":tripId/stops/:stopId/complete")
  completeStop(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Param("stopId", ParseUUIDPipe) stopId: string,
    @Body() dto: CompleteDriverStopDto,
  ) {
    return this.driverTripExecutionService.completeStop(
      req.user.id,
      tripId,
      stopId,
      dto,
    );
  }

  @Post(":id/complete")
  completeTrip(
    @Req() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DriverTripCommandDto,
  ) {
    return this.driverTripExecutionService.completeTrip(req.user.id, id, dto);
  }
}
