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
import { OptimizationJobsService } from './optimization-jobs.service';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PublishTripDto } from './dto/publish-trip.dto';
import { UpdateTripPlanDto } from './dto/update-trip-plan.dto';

@Controller('trips')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly optimizationJobs: OptimizationJobsService,
  ) {}

  @Get()
  findAll(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Query('status') status?: TripStatus,
  ) {
    return this.tripsService.findAll(status, req.user);
  }

  @Post()
  @Roles(Role.ADMIN, Role.DISPATCHER)
  create(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Body() createTripDto: CreateTripDto,
  ) {
    return this.tripsService.create(createTripDto, req.user);
  }

  @Post('optimize')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  optimize(@Body() body: OptimizeTripDto) {
    return this.tripsService.runOptimization(body);
  }

  @Post('automatic-optimization')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  runAutomaticOptimization(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Body() body: RunAutomaticOptimizationDto,
  ) {
    return this.optimizationJobs.create(req.user, body);
  }

  @Get('automatic-optimization/jobs')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  listAutomaticOptimizationJobs(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Query('branchId') branchId?: string,
  ) {
    return this.optimizationJobs.list(req.user, branchId);
  }

  @Get('automatic-optimization/jobs/:jobId')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  getAutomaticOptimizationJob(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Param('jobId') jobId: string,
  ) {
    return this.optimizationJobs.get(req.user, jobId);
  }

  @Post('automatic-optimization/jobs/:jobId/cancel')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  cancelAutomaticOptimizationJob(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Param('jobId') jobId: string,
  ) {
    return this.optimizationJobs.cancel(req.user, jobId);
  }

  @Post('automatic-optimization/jobs/:jobId/apply')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  applyAutomaticOptimizationJob(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Param('jobId') jobId: string,
  ) {
    return this.optimizationJobs.apply(req.user, jobId);
  }

  @Get(':id/load-profile')
  getLoadProfile(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Param('id') id: string,
  ) {
    return this.tripsService.getLoadProfile(id, req.user);
  }

  @Get(':id/load-plan')
  @Roles(Role.ADMIN, Role.DISPATCHER, Role.DRIVER)
  getLoadPlan(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Param('id') id: string,
  ) {
    return this.tripsService.getLoadPlan(id, req.user);
  }

  @Get(':id')
  findOne(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Param('id') id: string,
  ) {
    return this.tripsService.findOneAuthorized(id, req.user);
  }

  @Patch(':id/publish')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  publish(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Param('id') id: string,
    @Body() body: PublishTripDto,
  ) {
    return this.tripsService.publish(id, body, req.user);
  }

  @Patch(':id/plan')
  @Roles(Role.ADMIN, Role.DISPATCHER)
  updatePlan(
    @Req() req: { user: { id: string; branchId?: string; role: Role } },
    @Param('id') id: string,
    @Body() body: UpdateTripPlanDto,
  ) {
    return this.tripsService.updatePlan(id, body, req.user);
  }
}
