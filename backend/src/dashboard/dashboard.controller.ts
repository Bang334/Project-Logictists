import { BadRequestException, Controller, Get, Header, Query, Req } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AuthRequest, RequirePermission } from '../auth/access';
import { DashboardItemsQuery, DashboardQuery } from './dashboard.dto';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@RequirePermission('authenticated')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}
  private principal(req: AuthRequest) {
    const branch = req.headers['x-branch-id'];
    if (branch && branch !== 'ALL' && (typeof branch !== 'string' || !isUUID(branch))) throw new BadRequestException('Chi nhánh không hợp lệ');
    return { ...req.user, selectedBranchId: typeof branch === 'string' && branch !== 'ALL' ? branch : undefined };
  }
  @Get('summary') @Header('Cache-Control', 'private, no-store')
  summary(@Req() req: AuthRequest, @Query() q: DashboardQuery) { return this.service.summary(this.principal(req), q); }
  @Get('items') @Header('Cache-Control', 'private, no-store')
  items(@Req() req: AuthRequest, @Query() q: DashboardItemsQuery) { return this.service.items(this.principal(req), q); }
}
