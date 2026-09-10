import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { TripStatus } from '@prisma/client';
import { OptimizeTripDto } from './dto/optimize-trip.dto';

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

  @Post('optimization-jobs')
  @HttpCode(202)
  createAutomaticOptimizationJob(
    @Req() req: { user: { id: string; branchId?: string } },
  ) {
    return this.tripsService.createAutomaticOptimizationJob(req.user);
  }

  @Get('optimization-jobs/:jobId')
  getOptimizationJob(
    @Param('jobId') jobId: string,
    @Req() req: { user: { id: string; branchId?: string; role?: string } },
  ) {
    return this.tripsService.findOptimizationJob(jobId, req.user);
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
