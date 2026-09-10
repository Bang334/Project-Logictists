import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus } from '@prisma/client';

@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(
    @Query('status') status?: OrderStatus,
    @Query('customerId') customerId?: string,
    @Req() req?: { user?: { branchId?: string } },
  ) {
    return this.ordersService.findAll(status, customerId, req?.user?.branchId);
  }

  @Get('available-for-dispatch')
  getAvailableForDispatch(@Req() req: { user: { branchId?: string } }) {
    return this.ordersService.getAvailableForDispatch(req.user.branchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Post()
  create(@Body() createOrderDto: CreateOrderDto, @Req() req: { user: { branchId?: string } }) {
    return this.ordersService.create(createOrderDto, req.user.branchId);
  }
}
