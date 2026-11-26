import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import {
  CreateLoadRestrictionZoneDto,
  UpdateLoadRestrictionZoneDto,
} from './dto/zone.dto';
import { ZonesService } from './zones.service';

@Controller('zones')
export class ZonesController {
  constructor(private readonly zonesService: ZonesService) {}

  @RequirePermission('settings.read')
  @Get()
  list(
    @Req() req: AuthRequest,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.zonesService.list(req.user, branchId);
  }

  @RequirePermission('settings.manage')
  @Post()
  create(@Body() dto: CreateLoadRestrictionZoneDto, @Req() req: AuthRequest) {
    return this.zonesService.create(dto, req.user);
  }

  @RequirePermission('settings.manage')
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLoadRestrictionZoneDto,
    @Req() req: AuthRequest,
  ) {
    return this.zonesService.update(id, dto, req.user);
  }

  @RequirePermission('settings.manage')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.zonesService.remove(id, req.user);
  }
}
