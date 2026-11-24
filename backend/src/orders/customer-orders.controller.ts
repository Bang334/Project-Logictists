import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CustomerOrdersService } from './customer-orders.service';
import { QueryCustomerOrdersDto } from './dto/query-customer-orders.dto';
import { CreateCustomerOrderDto } from './dto/create-customer-order.dto';
import { CustomerOrderTrackingService } from './customer-order-tracking.service';

@Controller('customer/orders')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.CUSTOMER)
export class CustomerOrdersController {
  constructor(
    private readonly customerOrdersService: CustomerOrdersService,
    private readonly customerOrderTrackingService: CustomerOrderTrackingService,
  ) {}

  @Post()
  create(
    @Req() req: { user: { id: string } },
    @Body() dto: CreateCustomerOrderDto,
  ) {
    return this.customerOrdersService.createForUser(req.user.id, dto);
  }

  @Get()
  findAll(
    @Req() req: { user: { id: string } },
    @Query() query: QueryCustomerOrdersDto,
  ) {
    return this.customerOrdersService.findAllForUser(req.user.id, query);
  }

  @Get(':id')
  findOne(
    @Req() req: { user: { id: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customerOrdersService.findOneForUser(req.user.id, id);
  }

  @Get(':id/tracking')
  tracking(
    @Req() req: { user: { id: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customerOrderTrackingService.findForUser(req.user.id, id);
  }
}
