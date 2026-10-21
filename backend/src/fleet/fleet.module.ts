import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller';
import { FleetService } from './fleet.service';
@Module({ providers: [FleetService], controllers: [FleetController], exports: [FleetService] })
export class FleetModule {}
