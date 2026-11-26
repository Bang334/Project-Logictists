import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import {
  ResetBranchOverridesDto,
  SettingAuditLogsQueryDto,
  UpdateBranchSettingsDto,
  UpdateCompanySettingsDto,
} from './dto/settings.dto';
import { SettingsService } from './settings.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @RequirePermission('settings.read')
  @Get('company')
  getCompanySettings(@Req() req: AuthRequest) {
    return this.settingsService.getCompanyScoped(req.user);
  }

  @RequirePermission('settings.manage')
  @Put('company')
  updateCompanySettings(
    @Body() dto: UpdateCompanySettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.settingsService.updateCompanySettings(dto, req.user);
  }

  @RequirePermission('settings.read')
  @Get('effective')
  getEffectiveSettings(
    @Req() req: AuthRequest,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.settingsService.getEffectiveForUser(req.user, branchId);
  }

  @RequirePermission('settings.read')
  @Get('audit-logs')
  getAuditLogs(
    @Query() query: SettingAuditLogsQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.settingsService.getAuditLogs(req.user, query);
  }

  @RequirePermission('settings.read')
  @Get('branches/:branchId')
  getBranchSettings(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Req() req: AuthRequest,
  ) {
    return this.settingsService.getBranchScoped(branchId, req.user);
  }

  @RequirePermission('settings.manage')
  @Put('branches/:branchId')
  updateBranchSettings(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpdateBranchSettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.settingsService.updateBranchSettings(branchId, dto, req.user);
  }

  @RequirePermission('settings.manage')
  @Delete('branches/:branchId/overrides')
  resetBranchOverrides(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: ResetBranchOverridesDto,
    @Req() req: AuthRequest,
  ) {
    return this.settingsService.resetBranchOverrides(branchId, dto, req.user);
  }
}
