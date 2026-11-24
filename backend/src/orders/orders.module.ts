import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { MapboxModule } from '../mapbox/mapbox.module';
import { CustomerOrdersController } from './customer-orders.controller';
import { CustomerOrdersService } from './customer-orders.service';
import { CustomerBranchesController } from './customer-branches.controller';
import { CustomerOrderConfirmationService } from './customer-order-confirmation.service';
import { CustomerOrderTrackingService } from './customer-order-tracking.service';

@Module({
  imports: [MapboxModule],
  providers: [
    OrdersService,
    CustomerOrderConfirmationService,
    CustomerOrdersService,
    CustomerOrderTrackingService,
  ],
  controllers: [
    OrdersController,
    CustomerOrdersController,
    CustomerBranchesController,
  ],
  exports: [OrdersService],
})
export class OrdersModule {}
