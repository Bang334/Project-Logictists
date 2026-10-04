import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { OptimizationJobMetricsService } from './optimization-job-metrics.service';

@Controller('admin/optimization-jobs')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN)
export class OptimizationJobMetricsController {
  constructor(private readonly metricsService: OptimizationJobMetricsService) {}

  @Get('metrics')
  getMetrics() {
    return this.metricsService.getSnapshot();
  }
}
