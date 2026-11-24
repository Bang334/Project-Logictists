import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "@prisma/client";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DriverGpsService } from "./driver-gps.service";

@Controller("trips")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.ADMIN, Role.DISPATCHER)
export class TripTrackingController {
  constructor(private readonly driverGpsService: DriverGpsService) {}

  @Get(":tripId/tracking/latest")
  latest(
    @Req() req: { user: { role: Role; branchId?: string | null } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
  ) {
    return this.driverGpsService.getLatest(tripId, req.user);
  }
}
