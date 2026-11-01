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
import { SalesOrdersService } from './sales-orders.service';
import { CheckoutOrderDto } from './dto/checkout-order.dto';
import { CheckoutMultiSourceDto } from './dto/checkout-multi-source.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { QuerySalesOrdersDto } from './dto/query-sales-orders.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthenticatedUser } from '../auth/branch-scope';

@Controller('sales-orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class SalesOrdersController {
  constructor(private readonly salesOrdersService: SalesOrdersService) {}

  // ================= 1. CHECKOUT ORDER (LEGACY / SINGLE-SOURCE) =================
  @Post('checkout')
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  checkout(
    @Body() dto: CheckoutOrderDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.salesOrdersService.checkoutOrder(dto, req.user);
  }

  // ================= 2. CHECKOUT MULTI-SOURCE ORDER (NEW ATOMIC FLOW) =================
  @Post('checkout-multi-source')
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  checkoutMultiSource(
    @Body() dto: CheckoutMultiSourceDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.salesOrdersService.checkoutMultiSourceOrder(dto, req.user);
  }

  // ================= 3. CANCEL ORDER =================
  @Post(':id/cancel')
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.salesOrdersService.cancelOrder(id, dto, req.user);
  }

  // ================= 4. GET ORDER DETAILS =================
  @Get(':id')
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  findOne(
    @Param('id') id: string,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.salesOrdersService.findSalesOrderById(id, req.user);
  }

  // ================= 5. QUERY ORDERS (STAFF & ADMIN) =================
  @Get()
  @Roles(Role.ADMIN, Role.STAFF, Role.CUSTOMER)
  findAll(
    @Query() query: QuerySalesOrdersDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.salesOrdersService.querySalesOrders(query, req.user);
  }
}
