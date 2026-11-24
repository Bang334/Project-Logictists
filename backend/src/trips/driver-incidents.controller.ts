import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "@prisma/client";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DriverIncidentsService } from "./driver-incidents.service";
import {
  CreateDriverIncidentDto,
  QueryDriverIncidentsDto,
} from "./dto/driver-incident.dto";

@Controller("driver/trips/:tripId/incidents")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.DRIVER)
export class DriverIncidentsController {
  constructor(
    private readonly driverIncidentsService: DriverIncidentsService,
  ) {}

  @Post()
  create(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Body() dto: CreateDriverIncidentDto,
  ) {
    return this.driverIncidentsService.create(req.user.id, tripId, dto);
  }

  @Get()
  findAll(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Query() query: QueryDriverIncidentsDto,
  ) {
    return this.driverIncidentsService.findAll(req.user.id, tripId, query);
  }

  @Get(":incidentId")
  findOne(
    @Req() req: { user: { id: string } },
    @Param("tripId", ParseUUIDPipe) tripId: string,
    @Param("incidentId", ParseUUIDPipe) incidentId: string,
  ) {
    return this.driverIncidentsService.findOne(req.user.id, tripId, incidentId);
  }
}
