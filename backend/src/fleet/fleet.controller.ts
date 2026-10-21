import { Body, Controller, Get, Headers, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { FleetService } from './fleet.service';
import { CancelScheduleDto, CreateDriverDto, CreateVehicleDto, FleetQueryDto, IntervalQueryDto, LinkEmployeeDto, ScheduleDto, UpdateScheduleDto } from './fleet.dto';
enum Kind { vehicles = 'vehicles', drivers = 'drivers' }
@Controller('fleet')
export class FleetController {
  constructor(private readonly service: FleetService) {}
  @RequirePermission('drivers.manage') @Get('employees')
  employees(@Query() query: FleetQueryDto, @Req() req: AuthRequest) { return this.service.employees(query, req.user); }
  @RequirePermission('vehicles.manage') @Post('vehicles')
  vehicle(@Body() dto: CreateVehicleDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.service.createVehicle(dto, req.user, key); }
  @RequirePermission('drivers.manage') @Post('drivers')
  driver(@Body() dto: CreateDriverDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.service.createDriver(dto, req.user, key); }
  @RequirePermission('drivers.manage') @Post('drivers/:id/employee')
  link(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LinkEmployeeDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.service.linkEmployee(id, dto, req.user, key); }
  @RequirePermission('authenticated') @Get(':kind')
  list(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Query() query: FleetQueryDto, @Req() req: AuthRequest) { return this.service.list(kind, query, req.user); }
  @RequirePermission('authenticated') @Get(':kind/availability')
  availability(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Query() query: IntervalQueryDto, @Req() req: AuthRequest) { return this.service.availability(kind, query, req.user); }
  @RequirePermission('authenticated') @Get(':kind/:id')
  detail(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.service.detail(kind, id, req.user); }
  @RequirePermission('authenticated') @Get(':kind/:id/schedules')
  schedules(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Query() query: IntervalQueryDto, @Req() req: AuthRequest) { return this.service.schedules(kind, id, query, req.user); }
  @RequirePermission('authenticated') @Get(':kind/:id/availability')
  resourceWindow(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Query() query: IntervalQueryDto, @Req() req: AuthRequest) { return this.service.resourceWindow(kind, id, query, req.user); }
  @RequirePermission('authenticated') @Post(':kind/:id/schedules')
  createSchedule(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.service.schedule(kind, id, dto, req.user, key); }
  @RequirePermission('authenticated') @Patch(':kind/:id/schedules/:source/:scheduleId')
  updateSchedule(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Param('source') source: string, @Param('scheduleId', ParseUUIDPipe) scheduleId: string, @Body() dto: UpdateScheduleDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.service.schedule(kind, id, dto, req.user, key, scheduleId, false, source); }
  @RequirePermission('authenticated') @Post(':kind/:id/schedules/:source/:scheduleId/cancel')
  cancelSchedule(@Param('kind', new ParseEnumPipe(Kind)) kind: Kind, @Param('id', ParseUUIDPipe) id: string, @Param('source') source: string, @Param('scheduleId', ParseUUIDPipe) scheduleId: string, @Body() dto: CancelScheduleDto, @Req() req: AuthRequest, @Headers('idempotency-key') key?: string) { return this.service.schedule(kind, id, dto, req.user, key, scheduleId, true, source); }
}
