import { Module } from '@nestjs/common';
import { RetailAnalyticsService } from './retail-analytics.service';
import { RetailAnalyticsController } from './retail-analytics.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [RetailAnalyticsController],
  providers: [RetailAnalyticsService],
  exports: [RetailAnalyticsService],
})
export class RetailAnalyticsModule {}
