import { Body, Controller, Get, Param, Patch, Post, Query, Req, ParseUUIDPipe, ParseEnumPipe } from '@nestjs/common';
import { TripStatus } from '@prisma/client';
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import { RunAutomaticOptimizationDto } from './dto/run-automatic-optimization.dto';
import { ApplyAutomaticOptimizationDto } from './dto/apply-automatic-optimization.dto';
import { AuthRequest, RequirePermission } from '../auth/access';
@Controller('trips')
export class TripsController {
  constructor(private readonly service: TripsService) {}
  @RequirePermission('trips.read')
  @Get()
  findAll(@Req() req: AuthRequest, @Query('status', new ParseEnumPipe(TripStatus, { optional: true })) status?: TripStatus, @Query('branchId') branchId?: string) { return this.service.findAll(req.user, status, branchId); }
  @RequirePermission('trips.plan')
  @Post()
  create(@Req() req: AuthRequest, @Body() dto: CreateTripDto) { return this.service.create(dto, req.user); }
  @RequirePermission('trips.plan')
  @Post('optimize')
  optimize(@Req() req: AuthRequest, @Body() dto: OptimizeTripDto) { return this.service.runOptimization(dto, req.user); }
  @RequirePermission('trips.plan')
  @Post('automatic-optimization')
  automatic(@Req() req: AuthRequest, @Body() dto: RunAutomaticOptimizationDto) { return this.service.runAutomaticOptimization(req.user, dto.branchId); }
  @RequirePermission('trips.plan')
  @Post('automatic-optimization/apply')
  apply(@Req() req: AuthRequest, @Body() dto: ApplyAutomaticOptimizationDto) { return this.service.applyAutomaticOptimization(dto, req.user); }
  @RequirePermission('trips.read')
  @Get(':id/load-profile')
  load(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.getLoadProfile(id, req.user); }
  @RequirePermission('trips.read')
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(id, req.user); }
  @RequirePermission('trips.publish')
  @Patch(':id/publish')
  publish(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.publish(id, req.user); }
}
