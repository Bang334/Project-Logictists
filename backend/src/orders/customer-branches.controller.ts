import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CustomerOrdersService } from './customer-orders.service';

@Controller('customer/branches')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.CUSTOMER)
export class CustomerBranchesController {
  constructor(private readonly customerOrdersService: CustomerOrdersService) {}

  @Get()
  findActiveBranches() {
    return this.customerOrdersService.findActiveBranches();
  }
}
