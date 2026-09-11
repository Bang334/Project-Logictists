import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { OrderStatus, Role } from '@prisma/client';
import { resolveBranchScope } from '../auth/branch-scope';

@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  findAll(
    @Query('status') status?: OrderStatus,
    @Query('customerId') customerId?: string,
    @Query('branchId') branchId?: string,
    @Req() req?: { user?: { branchId?: string; role?: Role } },
  ) {
    const effectiveBranchId =
      req?.user?.role === Role.ADMIN
        ? (branchId || undefined)
        : (req?.user?.branchId || branchId || undefined);
    return this.ordersService.findAll(status, customerId, effectiveBranchId);
  }

  @Get('available-for-dispatch')
  getAvailableForDispatch(
    @Req() req: { user: { branchId?: string; role: Role } },
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.ordersService.getAvailableForDispatch(
      resolveBranchScope(req.user, branchId),
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findOne(id);
  }

  @Post()
  create(
    @Body() createOrderDto: CreateOrderDto,
    @Req() req: { user: { branchId?: string; role: Role } },
  ) {
    const effectiveBranchId =
      req.user.role === Role.ADMIN
        ? (createOrderDto.branchId || req.user.branchId)
        : req.user.branchId;
    return this.ordersService.create(createOrderDto, effectiveBranchId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateOrderDto: UpdateOrderDto,
    @Req() req: { user: { branchId?: string; role: Role } },
  ) {
    return this.ordersService.update(id, updateOrderDto, req.user);
  }
}
