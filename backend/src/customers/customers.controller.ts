import { Controller, Get, Param, Req, ParseUUIDPipe, Query } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { AuthRequest, RequirePermission } from '../auth/access';
@Controller('customers')
@RequirePermission('customers.read')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}
  @Get()
  findAll(@Req() req: AuthRequest, @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string) { return this.service.findAll(req.user, branchId); }
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(id, req.user); }
}
