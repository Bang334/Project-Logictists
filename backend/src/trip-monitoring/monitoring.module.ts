import { Module } from '@nestjs/common';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { StorageService } from '../common/services/storage.service';

@Module({ controllers: [MonitoringController], providers: [MonitoringService, StorageService] })
export class MonitoringModule {}
