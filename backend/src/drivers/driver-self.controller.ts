import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { DriversService } from './drivers.service';
import { QueryDriverActivityDto } from './dto/query-driver-activity.dto';

@Controller('driver')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.DRIVER)
export class DriverSelfController {
  constructor(private readonly drivers: DriversService) {}

  @Get('me')
  getProfile(@Req() req: { user: { id: string } }, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).length) throw new BadRequestException('Hồ sơ tài xế không nhận tham số truy vấn');
    return this.drivers.getSelfProfile(req.user.id);
  }

  @Get('me/activity-summary')
  getActivitySummary(@Req() req: { user: { id: string } }, @Query() query: QueryDriverActivityDto) {
    return this.drivers.getActivitySummary(req.user.id, query);
  }
}
