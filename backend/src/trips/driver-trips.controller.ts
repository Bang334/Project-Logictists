import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "@prisma/client";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DriverTripsService } from "./driver-trips.service";
import { QueryDriverTripsDto } from "./dto/query-driver-trips.dto";
import { QueryDriverTripHistoryDto } from "./dto/query-driver-trip-history.dto";

@Controller("driver/trips")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.DRIVER)
export class DriverTripsController {
  constructor(private readonly driverTripsService: DriverTripsService) {}

  @Get()
  findAll(
    @Req() req: { user: { id: string } },
    @Query() query: QueryDriverTripsDto,
  ) {
    return this.driverTripsService.findAllForUser(req.user.id, query);
  }

  @Get("history")
  findHistory(
    @Req() req: { user: { id: string } },
    @Query() query: QueryDriverTripHistoryDto,
  ) {
    return this.driverTripsService.findHistoryForUser(req.user.id, query);
  }

  @Get(":id")
  findOne(
    @Req() req: { user: { id: string } },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.driverTripsService.findOneForUser(req.user.id, id);
  }
}
