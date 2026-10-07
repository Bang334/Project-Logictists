import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { PickupService } from './pickup.service';
import {
  CreateTransferShipmentDto,
  InboundScanDto,
  VerifyCollectionDto,
  QueryHoldingsDto,
} from './dto/pickup.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  AuthenticatedUser,
  resolveLocationScope,
} from '../auth/branch-scope';

@Controller('pickup')
export class PickupController {
  constructor(private readonly pickupService: PickupService) {}

  // 1. Tạo yêu cầu trung chuyển (R7-01, R7-03)
  @Post('transfer-shipments')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.STAFF)
  createTransfer(
    @Body() dto: CreateTransferShipmentDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.pickupService.createTransferShipment(dto, req.user);
  }

  // 2. Quét nhập kiện tại Điểm Nhận (R7-07, R7-08)
  @Post('inbound-scan')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.STAFF)
  inboundScan(
    @Body() dto: InboundScanDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.pickupService.inboundScanAtPickupPoint(dto, req.user);
  }

  // 3. Xác thực OTP/QR giao khách nhận hàng (R7-09)
  @Post('verify-collection')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.STAFF)
  verifyCollection(
    @Body() dto: VerifyCollectionDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.pickupService.verifyAndCollect(dto, req.user);
  }

  // 4. Danh sách kiện lưu giữ tại điểm (Holdings) (R7-08, R7-10)
  @Get('holdings')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.STAFF)
  getHoldings(
    @Query() query: QueryHoldingsDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    const locationId = resolveLocationScope(req.user, query.locationId);
    return this.pickupService.getHoldings({ ...query, locationId });
  }

  // 5. Khách hàng xem mã OTP/QR nhận hàng (R7-11)
  @Get('customer-token')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.CUSTOMER)
  getCustomerToken(
    @Query('salesOrderId') salesOrderId: string,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.pickupService.getCustomerCollectionToken(salesOrderId, req.user);
  }
}
