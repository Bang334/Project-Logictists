import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { TransportSettingsController } from './transport-settings.controller';

@Module({
  controllers: [SettingsController, TransportSettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
