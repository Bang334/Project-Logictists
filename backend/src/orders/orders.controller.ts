import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { AuthenticatedUser, resolveBranchScope } from '../auth/branch-scope';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ConfirmCustomerOrderDto } from './dto/confirm-customer-order.dto';
import { CustomerOrderConfirmationService } from './customer-order-confirmation.service';

@Controller('orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.DISPATCHER)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly confirmationService: CustomerOrderConfirmationService,
  ) {}

  @Get()
  findAll(
    @Req() req: { user: { branchId?: string | null; role: Role } },
    @Query('status') status?: OrderStatus,
    @Query('customerId') customerId?: string,
    @Query('branchId') branchId?: string,
  ) {
    const effectiveBranchId =
      req.user.role === Role.ADMIN
        ? (branchId || undefined)
        : resolveBranchScope(req.user, branchId);
    return this.ordersService.findAll(status, customerId, effectiveBranchId);
  }

  @Get('available-for-dispatch')
  getAvailableForDispatch(
    @Req() req: { user: { branchId?: string | null; role: Role } },
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ) {
    return this.ordersService.getAvailableForDispatch(
      resolveBranchScope(req.user, branchId),
    );
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Req() req: { user: { branchId?: string | null; role: Role } },
  ) {
    return this.ordersService.findOneAuthorized(id, req.user);
  }

  @Post()
  create(
    @Body() createOrderDto: CreateOrderDto,
    @Req() req: { user: { branchId?: string | null; role: Role } },
  ) {
    const effectiveBranchId =
      req.user.role === Role.ADMIN
        ? (createOrderDto.branchId || req.user.branchId || undefined)
        : (req.user.branchId || undefined);
    return this.ordersService.create(createOrderDto, effectiveBranchId);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmCustomerOrderDto,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.confirmationService.confirm(id.toLowerCase(), dto, req.user);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateOrderDto: UpdateOrderDto,
    @Req() req: { user: { branchId?: string | null; role: Role } },
  ) {
    return this.ordersService.update(id, updateOrderDto, req.user);
  }
}
