import { Body, Controller, Get, Param, Patch, Post, Query, Req, ParseEnumPipe, ParseUUIDPipe } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { AuthRequest, RequirePermission } from '../auth/access';
@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  @RequirePermission('orders.read')
  @Get()
  findAll(@Req() req: AuthRequest, @Query('status', new ParseEnumPipe(OrderStatus, { optional: true })) status?: OrderStatus, @Query('customerId') customerId?: string, @Query('branchId') branchId?: string) { return this.service.findAll(req.user, status, customerId, branchId); }
  @RequirePermission('orders.read')
  @Get('available-for-dispatch')
  available(@Req() req: AuthRequest, @Query('branchId') branchId?: string) { return this.service.getAvailableForDispatch(req.user, branchId); }
  @RequirePermission('orders.read')
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(id, req.user); }
  @RequirePermission('orders.write')
  @Post()
  create(@Req() req: AuthRequest, @Body() dto: CreateOrderDto) { return this.service.create(dto, req.user); }
  @RequirePermission('orders.write')
  @Patch(':id')
  update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderDto) { return this.service.update(id, dto, req.user); }
}
