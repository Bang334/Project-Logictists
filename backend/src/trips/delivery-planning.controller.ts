import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthRequest, RequirePermission } from '../auth/access';
import { DeliveryPlanningService } from './delivery-planning.service';
import { OptimizeDeliveryBatchDto, ProposeDeliveryBatchDto, RespondDeliveryAppointmentDto } from './dto/delivery-planning.dto';

@Controller('delivery-planning')
@UseGuards(AuthGuard('jwt'))
export class DeliveryPlanningController {
  constructor(private readonly delivery: DeliveryPlanningService) {}
  @Get('mine') @RequirePermission('authenticated')
  mine(@Req() request: AuthRequest, @Query('page', new ParseIntPipe({ optional: true })) page = 1) {
    return this.delivery.mine(request.user, Math.max(1, page));
  }
  @Post('appointments/:id/respond') @RequirePermission('authenticated')
  respond(@Req() request: AuthRequest, @Param('id') id: string, @Body() dto: RespondDeliveryAppointmentDto) {
    return this.delivery.respond(request.user, id, dto);
  }
  @Get('batches') @RequirePermission('trips.plan')
  list(@Req() request: AuthRequest, @Query('branchId') branchId: string) { return this.delivery.list(request.user, branchId); }
  @Get('batches/:id') @RequirePermission('trips.plan')
  get(@Req() request: AuthRequest, @Param('id') id: string) { return this.delivery.getBatch(request.user, id); }
  @Post('batches') @RequirePermission('trips.plan')
  propose(@Req() request: AuthRequest, @Body() dto: ProposeDeliveryBatchDto) { return this.delivery.propose(request.user, dto); }
  @Post('batches/:id/optimize') @RequirePermission('trips.plan')
  optimize(@Req() request: AuthRequest, @Param('id') id: string, @Body() dto: OptimizeDeliveryBatchDto) { return this.delivery.optimize(request.user, id, dto); }
}
