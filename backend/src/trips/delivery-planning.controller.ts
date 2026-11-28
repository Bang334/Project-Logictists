import { Body, Controller, Get, Header, Headers, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthRequest, Public, RequirePermission } from '../auth/access';
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
  @Get('batches/:batchId/appointments/:id/recipient-link') @RequirePermission('trips.plan')
  @Header('Cache-Control', 'no-store')
  recipientLink(@Req() request: AuthRequest, @Param('batchId') batchId: string, @Param('id') id: string) {
    return this.delivery.getRecipientLink(request.user, batchId, id);
  }
  @Post('batches') @RequirePermission('trips.plan')
  propose(@Req() request: AuthRequest, @Body() dto: ProposeDeliveryBatchDto) { return this.delivery.propose(request.user, dto); }
  @Post('batches/:id/optimize') @RequirePermission('trips.plan')
  optimize(@Req() request: AuthRequest, @Param('id') id: string, @Body() dto: OptimizeDeliveryBatchDto) { return this.delivery.optimize(request.user, id, dto); }
}

@Controller('delivery-planning/recipient')
export class RecipientDeliveryController {
  constructor(private readonly delivery: DeliveryPlanningService) {}

  @Get() @Public() @Header('Cache-Control', 'no-store')
  get(@Headers('x-delivery-token') token = '') {
    return this.delivery.recipientAppointment(typeof token === 'string' ? token : '');
  }

  @Post() @Public() @Header('Cache-Control', 'no-store')
  respond(@Headers('x-delivery-token') token = '', @Body() dto: RespondDeliveryAppointmentDto) {
    return this.delivery.respondAsRecipient(typeof token === 'string' ? token : '', dto);
  }
}
