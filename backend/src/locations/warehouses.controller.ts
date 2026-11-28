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
} from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { CreateWarehouseDto, UpdateWarehouseDto } from './dto/warehouse.dto';
import { WarehousesService } from './warehouses.service';

@Controller('locations/warehouses')
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  @RequirePermission('branches.read')
  @Get()
  list(
    @Req() req: AuthRequest,
    @Query('branchId') branchId?: string,
  ) {
    return this.warehousesService.listWarehouses(req.user, branchId);
  }

  @RequirePermission('branches.manage')
  @Post()
  create(@Req() req: AuthRequest, @Body() dto: CreateWarehouseDto) {
    return this.warehousesService.createWarehouse(req.user, dto);
  }

  @RequirePermission('branches.manage')
  @Patch(':id')
  update(
    @Req() req: AuthRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarehouseDto,
  ) {
    return this.warehousesService.updateWarehouse(req.user, id, dto);
  }
}
