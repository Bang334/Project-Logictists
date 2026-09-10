import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
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
    @Req() req?: { user?: { branchId?: string } },
  ) {
    return this.driversService.findAll(branchId || req?.user?.branchId, status);
  }

  @Get('available')
  getAvailable(
    @Query('branchId') branchId?: string,
    @Req() req?: { user?: { branchId?: string } },
  ) {
    return this.driversService.getAvailable(branchId || req?.user?.branchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.driversService.findOne(id);
  }
}
