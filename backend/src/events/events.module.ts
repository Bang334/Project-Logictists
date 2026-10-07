import { Global, Module } from '@nestjs/common';
import { EventsGateway } from './events.gateway';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [AuthModule, PrismaModule],
  providers: [EventsGateway],
  exports: [EventsGateway],
})
export class EventsModule {}
