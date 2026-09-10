import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { VehiclesService } from './vehicles.service';
import { VehicleStatus } from '@prisma/client';

@Controller('vehicles')
@UseGuards(AuthGuard('jwt'))
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  findAll(
    @Query('branchId') branchId?: string,
    @Query('status') status?: VehicleStatus,
    @Req() req?: { user?: { branchId?: string } },
  ) {
    return this.vehiclesService.findAll(branchId || req?.user?.branchId, status);
  }

  @Get('available')
  getAvailable(
    @Query('branchId') branchId?: string,
    @Req() req?: { user?: { branchId?: string } },
  ) {
    return this.vehiclesService.getAvailable(branchId || req?.user?.branchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vehiclesService.findOne(id);
  }
}
