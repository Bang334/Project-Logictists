import { AuthRequest, RequirePermission } from '../auth/access';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
} from '@nestjs/common';
import { TripsService } from './trips.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { Role, TripStatus } from '@prisma/client';
import { OptimizeTripDto } from './dto/optimize-trip.dto';
import { RunAutomaticOptimizationDto } from './dto/run-automatic-optimization.dto';
import { OptimizationJobsService } from './optimization-jobs.service';
import { Roles } from '../auth/roles.decorator';
import { PublishTripDto } from './dto/publish-trip.dto';
import { UpdateTripPlanDto } from './dto/update-trip-plan.dto';
import { ApplyOptimizationCandidateDto } from './dto/apply-optimization-candidate.dto';

@Controller('trips')
@RequirePermission('trips.read')
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly optimizationJobs: OptimizationJobsService,
  ) {}

  @Get()
  findAll(
    @Req() req: AuthRequest,
    @Query('status') status?: TripStatus,
    @Query('branchId') branchId?: string,
  ) {
    return this.tripsService.findAll(req.user, status, branchId);
  }

  @Post()
  @RequirePermission('trips.plan')
  create(
    @Req() req: AuthRequest,
    @Body() createTripDto: CreateTripDto,
  ) {
    return this.tripsService.create(createTripDto, req.user);
  }

  @Post('optimize')
  @RequirePermission('trips.plan')
  optimize(@Req() req: AuthRequest, @Body() body: OptimizeTripDto) {
    return this.tripsService.runOptimization(body, req.user);
  }

  @Post('automatic-optimization')
  @RequirePermission('trips.plan')
  runAutomaticOptimization(
    @Req() req: AuthRequest,
    @Body() body: RunAutomaticOptimizationDto,
  ) {
    return this.optimizationJobs.create(req.user, body);
  }

  @Get('automatic-optimization/jobs')
  @RequirePermission('trips.plan')
  listAutomaticOptimizationJobs(
    @Req() req: AuthRequest,
    @Query('branchId') branchId?: string,
  ) {
    return this.optimizationJobs.list(req.user, branchId);
  }

  @Get('automatic-optimization/jobs/:jobId')
  @RequirePermission('trips.plan')
  getAutomaticOptimizationJob(
    @Req() req: AuthRequest,
    @Param('jobId') jobId: string,
  ) {
    return this.optimizationJobs.get(req.user, jobId);
  }

  @Post('automatic-optimization/jobs/:jobId/cancel')
  @RequirePermission('trips.plan')
  cancelAutomaticOptimizationJob(
    @Req() req: AuthRequest,
    @Param('jobId') jobId: string,
  ) {
    return this.optimizationJobs.cancel(req.user, jobId);
  }

  @Post('automatic-optimization/jobs/:jobId/apply')
  @RequirePermission('trips.plan')
  applyAutomaticOptimizationJob(
    @Req() req: AuthRequest,
    @Param('jobId') jobId: string,
    @Body() body: ApplyOptimizationCandidateDto,
  ) {
    return this.optimizationJobs.apply(req.user, jobId, body.candidateNumber);
  }

  @Get('automatic-optimization/jobs/:jobId/candidates/:candidateNumber')
  @RequirePermission('trips.plan')
  getAutomaticOptimizationCandidate(
    @Req() req: AuthRequest,
    @Param('jobId') jobId: string,
    @Param('candidateNumber', ParseIntPipe) candidateNumber: number,
  ) {
    return this.optimizationJobs.getCandidate(req.user, jobId, candidateNumber);
  }

  @Get('automatic-optimization/jobs/:jobId/export')
  @RequirePermission('trips.plan')
  async exportAutomaticOptimizationCandidates(
    @Req() req: AuthRequest,
    @Param('jobId') jobId: string,
  ) {
    const exported = await this.optimizationJobs.exportCandidates(req.user, jobId);
    return new StreamableFile(exported.buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${exported.filename}"`,
    });
  }

  @Get(':id/load-profile')
  getLoadProfile(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.tripsService.getLoadProfile(id, req.user);
  }

  @Get(':id/load-plan')
  @Roles(Role.ADMIN, Role.DISPATCHER, Role.DRIVER)
  getLoadPlan(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.tripsService.getLoadPlan(id, req.user);
  }

  @Get(':id')
  findOne(
    @Req() req: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.tripsService.findOneAuthorized(id, req.user);
  }

  @Patch(':id/publish')
  @RequirePermission('trips.publish')
  publish(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: PublishTripDto,
  ) {
    return this.tripsService.publish(id, body, req.user);
  }

  @Patch(':id/plan')
  @RequirePermission('trips.plan')
  updatePlan(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: UpdateTripPlanDto,
  ) {
    return this.tripsService.updatePlan(id, body, req.user);
  }
}
