import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { Role, TripStatus } from '@prisma/client';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import { RunAutomaticOptimizationDto } from './dto/run-automatic-optimization.dto';
import { ApplyAutomaticOptimizationDto } from './dto/apply-automatic-optimization.dto';

@Controller('trips')
@UseGuards(AuthGuard('jwt'))
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Get()
  findAll(@Query('status') status?: TripStatus) {
    return this.tripsService.findAll(status);
  }

  @Post()
  create(@Body() createTripDto: CreateTripDto) {
    return this.tripsService.create(createTripDto);
  }

  @Post('optimize')
  optimize(@Body() body: OptimizeTripDto) {
    return this.tripsService.runOptimization(body);
  }

  @Post('automatic-optimization')
  runAutomaticOptimization(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Body() body?: RunAutomaticOptimizationDto,
  ) {
    return this.tripsService.runAutomaticOptimization(req.user, body?.branchId);
  }

  @Post('automatic-optimization/apply')
  applyAutomaticOptimization(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Body() body: ApplyAutomaticOptimizationDto,
  ) {
    return this.tripsService.applyAutomaticOptimization(body, req.user);
  }

  @Get(':id/load-profile')
  getLoadProfile(@Param('id') id: string) {
    return this.tripsService.getLoadProfile(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tripsService.findOne(id);
  }

  @Patch(':id/publish')
  publish(@Param('id') id: string) {
    return this.tripsService.publish(id);
  }
}
