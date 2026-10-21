import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { CreateCustomerDto, CustomerQueryDto, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';
@Controller('customers')
@RequirePermission('customers.read')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}
  @Get() legacy(@Req() req: AuthRequest, @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string) { return this.service.findAll(req.user, branchId); }
  @Get('page') list(@Req() req: AuthRequest, @Query() query: CustomerQueryDto) { return this.service.list(req.user, query); }
  @Get('lookup') lookup(@Req() req: AuthRequest, @Query() query: CustomerQueryDto) { return this.service.lookup(req.user, query); }
  @Get(':id/orders') orders(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query() query: CustomerQueryDto) { return this.service.orders(id, req.user, query); }
  @Get(':id') detail(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string) { return this.service.findOne(id, req.user, branchId); }
  @Post() @RequirePermission('customers.write') create(@Req() req: AuthRequest, @Body() dto: CreateCustomerDto, @Headers('idempotency-key') key?: string) { return this.service.create(dto, req.user, key); }
  @Patch(':id') @RequirePermission('customers.write') update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto, @Headers('idempotency-key') key?: string) { return this.service.update(id, dto, req.user, key); }
}
