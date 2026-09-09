import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DriversService } from './drivers.service';
import { DriverStatus } from '@prisma/client';

@Controller('drivers')
@UseGuards(AuthGuard('jwt'))
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  findAll(
    @Query('branchId') branchId?: string,
    @Query('status') status?: DriverStatus,
  ) {
    return this.driversService.findAll(branchId, status);
  }

  @Get('available')
  getAvailable(@Query('branchId') branchId?: string) {
    return this.driversService.getAvailable(branchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.driversService.findOne(id);
  }
}
