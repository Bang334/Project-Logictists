import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { AuthenticatedUser, resolveLocationScope } from '../auth/branch-scope';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  CreateHandoverDto,
  PackOrderDto,
  QueryOrderPreparationDto,
  RecordPreparedItemDto,
} from './dto/fulfillment.dto';
import { PackAndMeasureGroupDto } from './dto/pack-group.dto';
import { OrderProcessingService } from './fulfillment.service';

@Controller('order-processing')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.STAFF)
export class OrderProcessingController {
  constructor(private readonly service: OrderProcessingService) {}

  // ================= 1. MULTI-SOURCE FULFILLMENT GROUPS =================
  @Get('groups')
  getGroupQueue(
    @Query('locationId') locationId: string | undefined,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locId = resolveLocationScope(req.user, locationId);
    return this.service.getGroupPreparationQueue(locId, req.user);
  }

  @Get('groups/:id')
  getGroupDetail(@Param('id') id: string, @Req() req: { user: AuthenticatedUser }) {
    return this.service.getGroupDetail(id, req.user);
  }

  @Post('groups/:id/start')
  startGroup(@Param('id') id: string, @Req() req: { user: AuthenticatedUser }) {
    return this.service.startGroupPreparation(id, req.user);
  }

  @Post('groups/pack-and-measure')
  packAndMeasureGroup(
    @Body() dto: PackAndMeasureGroupDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.service.packAndMeasureGroup(dto, req.user);
  }

  // ================= 2. LEGACY PREPARATION =================
  @Get('orders')
  getQueue(
    @Query() query: QueryOrderPreparationDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, query.locationId);
    return this.service.getPreparationQueue({ ...query, locationId });
  }

  @Get('orders/:id')
  getDetail(@Param('id') id: string, @Req() req: { user: AuthenticatedUser }) {
    return this.service.getOrderDetail(id, req.user);
  }

  @Post('orders/:id/start')
  start(@Param('id') id: string, @Req() req: { user: AuthenticatedUser }) {
    return this.service.startPreparation(id, req.user);
  }

  @Post('prepared-items')
  recordPreparedItem(
    @Body() dto: RecordPreparedItemDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.service.recordPreparedItem(dto, req.user);
  }

  @Post('packages')
  pack(@Body() dto: PackOrderDto, @Req() req: { user: AuthenticatedUser }) {
    return this.service.packOrder(dto, req.user);
  }

  // ================= 3. HANDOVER =================
  @Post('handovers')
  handover(@Body() dto: CreateHandoverDto, @Req() req: { user: AuthenticatedUser }) {
    return this.service.createHandover(dto, req.user);
  }

  @Get('handovers')
  getHandovers(
    @Query('sourceLocationId') sourceLocationId: string | undefined,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.service.getHandovers(resolveLocationScope(req.user, sourceLocationId));
  }
}
