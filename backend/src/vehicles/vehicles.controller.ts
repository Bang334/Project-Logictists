import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { VehiclesService } from './vehicles.service';
import { Role, VehicleStatus } from '@prisma/client';
import { resolveBranchScope } from '../auth/branch-scope';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';

@Controller('vehicles')
@UseGuards(AuthGuard('jwt'))
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  findAll(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Query('branchId') branchId?: string,
    @Query('status') status?: VehicleStatus,
  ) {
    const effectiveBranchId =
      req.user.role === Role.ADMIN
        ? (branchId && branchId !== 'ALL' ? branchId : undefined)
        : req.user.branchId;
    return this.vehiclesService.findAll(effectiveBranchId, status);
  }

  @Get('available')
  getAvailable(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.vehiclesService.getAvailable(resolveBranchScope(req.user, branchId));
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateVehicleDto: UpdateVehicleDto,
    @Req() req: { user: { branchId?: string; role: Role } },
  ) {
    return this.vehiclesService.update(id, updateVehicleDto, req.user);
  }
}

