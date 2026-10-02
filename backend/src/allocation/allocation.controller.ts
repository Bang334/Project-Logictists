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
import { AllocationService } from './allocation.service';
import { AllocateOrderDto } from './dto/allocate-order.dto';
import { QueryPickupPointsDto } from './dto/query-pickup-points.dto';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthenticatedUser } from '../auth/branch-scope';

@Controller('allocation')
export class AllocationController {
  constructor(private readonly allocationService: AllocationService) {}

  // ================= 1. GỢI Ý ĐIỂM NHẬN CHO KHÁCH HÀNG (TIER 1) =================
  @Get('pickup-points')
  findValidPickupPoints(@Query() query: QueryPickupPointsDto) {
    return this.allocationService.findValidPickupPoints(query);
  }

  // ================= 2. KÍCH HOẠT PHÂN BỔ NGUỒN CUNG ỨNG (TIER 2 - STAFF/ADMIN) =================
  @Post('orders')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.STAFF)
  allocateOrder(
    @Body() dto: AllocateOrderDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.allocationService.allocateSourceForOrder(dto, req.user);
  }

  // ================= 3. XEM GIẢI THÍCH LỊCH SỬ PHÂN BỔ =================
  @Get('orders/:salesOrderId/attempts')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.STAFF)
  getAttemptsForOrder(
    @Param('salesOrderId') salesOrderId: string,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.allocationService.getAttemptsForOrder(salesOrderId, req.user);
  }
}
