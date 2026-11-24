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
import { DriversService } from './drivers.service';
import { DriverStatus, Role } from '@prisma/client';
import { resolveBranchScope } from '../auth/branch-scope';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('drivers')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.DISPATCHER)
export class DriversController {
  constructor(private readonly driversService: DriversService) {}

  @Get()
  findAll(
    @Req() req: { user: { branchId?: string | null; role: Role } },
    @Query('branchId') branchId?: string,
    @Query('status') status?: DriverStatus,
  ) {
    const effectiveBranchId =
      req.user.role === Role.ADMIN
        ? (branchId && branchId !== 'ALL' ? branchId : undefined)
        : resolveBranchScope(req.user, branchId);
    return this.driversService.findAll(effectiveBranchId, status);
  }

  @Get('available')
  getAvailable(
    @Req() req: { user: { branchId?: string | null; role: Role } },
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.driversService.getAvailable(resolveBranchScope(req.user, branchId));
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { branchId?: string | null; role: Role } },
  ) {
    return this.driversService.findOneAuthorized(id, req.user);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDriverDto: UpdateDriverDto,
    @Req() req: { user: { branchId?: string | null; role: Role } },
  ) {
    return this.driversService.update(id, updateDriverDto, req.user);
  }
}

