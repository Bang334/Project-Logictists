import { Module } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { BranchesController } from './branches.controller';
import { MapboxModule } from '../mapbox/mapbox.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [MapboxModule, SettingsModule],
  providers: [BranchesService],
  controllers: [BranchesController],
  exports: [BranchesService],
})
export class BranchesModule {}
