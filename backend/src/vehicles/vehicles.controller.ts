import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
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
  ) {
    return this.vehiclesService.findAll(branchId, status);
  }

  @Get('available')
  getAvailable(@Query('branchId') branchId?: string) {
    return this.vehiclesService.getAvailable(branchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.vehiclesService.findOne(id);
  }
}
