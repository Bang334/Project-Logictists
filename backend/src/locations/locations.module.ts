import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';

@Module({
  controllers: [LocationsController, WarehousesController],
  providers: [LocationsService, WarehousesService],
  exports: [LocationsService, WarehousesService],
})
export class LocationsModule {}
