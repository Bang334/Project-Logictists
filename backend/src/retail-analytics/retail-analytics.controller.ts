import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { RetailAnalyticsService } from './retail-analytics.service';
import {
  RecordRetailPaymentDto,
  RefundRetailOrderDto,
  AnalyticsFilterDto,
} from './dto/analytics.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  AuthenticatedUser,
  resolveLocationScope,
} from '../auth/branch-scope';

@Controller('retail-analytics')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.STAFF)
export class RetailAnalyticsController {
  constructor(private readonly analyticsService: RetailAnalyticsService) {}

  // 1. Ghi nhận thanh toán (R8-01)
  @Post('payments')
  recordPayment(
    @Body() dto: RecordRetailPaymentDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.analyticsService.recordRetailPayment(dto, req.user);
  }

  // 2. Hoàn tiền (R8-02)
  @Post('refunds')
  refundOrder(
    @Body() dto: RefundRetailOrderDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.analyticsService.refundRetailOrder(dto, req.user);
  }

  // 3. Phễu đơn hàng (R8-03)
  @Get('funnel')
  getFunnel(
    @Query() filter: AnalyticsFilterDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, filter.locationId);
    return this.analyticsService.getOrderFunnelMetrics({ ...filter, locationId });
  }

  // 4. Hiệu suất Fulfillment & Short-pick (R8-03, R8-05)
  @Get('fulfillment-performance')
  getFulfillmentPerformance(
    @Query() filter: AnalyticsFilterDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, filter.locationId);
    return this.analyticsService.getFulfillmentPerformance({ ...filter, locationId });
  }

  // 5. Tỷ lệ lấp đầy điểm nhận (R8-03)
  @Get('occupancy')
  getOccupancy(
    @Query('locationId') requestedLocationId: string | undefined,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, requestedLocationId);
    return this.analyticsService.getPickupPointOccupancy(locationId);
  }

  // 6. Tổng hợp tài chính bán lẻ (R8-06)
  @Get('financial-summary')
  getFinancialSummary(
    @Query() filter: AnalyticsFilterDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, filter.locationId);
    return this.analyticsService.getFinancialSummary({ ...filter, locationId });
  }

  // 7. Đối soát toàn diện đơn hàng (R8-08)
  @Get('reconcile/:salesOrderId')
  reconcileOrder(
    @Param('salesOrderId') salesOrderId: string,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.analyticsService.reconcileOrderData(salesOrderId, req.user);
  }
}
