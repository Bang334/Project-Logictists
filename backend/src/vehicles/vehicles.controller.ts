import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, ParseEnumPipe } from '@nestjs/common';
import { VehicleStatus } from '@prisma/client';
import { VehiclesService } from './vehicles.service';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { AuthRequest, RequirePermission } from '../auth/access';

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly service: VehiclesService) {}
  @RequirePermission('vehicles.read')
  @Get()
  findAll(@Req() req: AuthRequest, @Query('branchId') branchId?: string, @Query('status', new ParseEnumPipe(VehicleStatus, { optional: true })) status?: VehicleStatus) {
    return this.service.findAll(req.user, branchId, status);
  }
  @RequirePermission('vehicles.read')
  @Get('available')
  available(@Req() req: AuthRequest, @Query('branchId') branchId?: string) { return this.service.getAvailable(req.user, branchId); }
  @RequirePermission('vehicles.read')
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(id, req.user); }
  @RequirePermission('vehicles.manage')
  @Patch(':id')
  update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVehicleDto) { return this.service.update(id, dto, req.user); }
}
