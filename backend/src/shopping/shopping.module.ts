import { Module } from '@nestjs/common';
import { ShoppingController } from './shopping.controller';
import { ShoppingService } from './shopping.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MapboxModule } from '../mapbox/mapbox.module';

@Module({
  imports: [PrismaModule, MapboxModule],
  controllers: [ShoppingController],
  providers: [ShoppingService],
  exports: [ShoppingService],
})
export class ShoppingModule {}

