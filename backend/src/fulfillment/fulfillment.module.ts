import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderProcessingController } from './fulfillment.controller';
import { OrderProcessingService } from './fulfillment.service';

@Module({
  imports: [PrismaModule, CommonModule, InventoryModule],
  controllers: [OrderProcessingController],
  providers: [OrderProcessingService],
  exports: [OrderProcessingService],
})
export class OrderProcessingModule {}
