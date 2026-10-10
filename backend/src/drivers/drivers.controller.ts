import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, ParseEnumPipe } from '@nestjs/common';
import { DriverStatus } from '@prisma/client';
import { DriversService } from './drivers.service';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { AuthRequest, RequirePermission } from '../auth/access';

@Controller('drivers')
export class DriversController {
  constructor(private readonly service: DriversService) {}
  @RequirePermission('drivers.read')
  @Get()
  findAll(@Req() req: AuthRequest, @Query('branchId') branchId?: string, @Query('status', new ParseEnumPipe(DriverStatus, { optional: true })) status?: DriverStatus) {
    return this.service.findAll(req.user, branchId, status);
  }
  @RequirePermission('drivers.read')
  @Get('available')
  available(@Req() req: AuthRequest, @Query('branchId') branchId?: string) { return this.service.getAvailable(req.user, branchId); }
  @RequirePermission('drivers.read')
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(id, req.user); }
  @RequirePermission('drivers.manage')
  @Patch(':id')
  update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDriverDto) { return this.service.update(id, dto, req.user); }
}
