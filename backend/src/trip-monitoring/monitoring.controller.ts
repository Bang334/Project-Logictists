import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req, StreamableFile } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { MonitoringQuery, MonitoringPageQuery } from './monitoring.dto';
import { MonitoringService } from './monitoring.service';

@Controller('trip-monitoring')
@RequirePermission('trips.read')
export class MonitoringController {
  constructor(private readonly service: MonitoringService) {}
  @Get() @Header('Cache-Control', 'private, no-store')
  list(@Req() req: AuthRequest, @Query() query: MonitoringQuery) { return this.service.list(req.user, query); }
  @Get('resources') @Header('Cache-Control', 'private, no-store')
  resources(@Req() req: AuthRequest, @Query() query: MonitoringQuery) { return this.service.resources(req.user, query); }
  @Get(':id') @Header('Cache-Control', 'private, no-store')
  detail(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.detail(req.user, id); }
  @Get(':id/events') @Header('Cache-Control', 'private, no-store')
  events(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Query() query: MonitoringPageQuery) { return this.service.events(req.user, id, query); }
  @Get(':id/pod/:podId') @Header('Cache-Control', 'private, no-store') @Header('X-Content-Type-Options', 'nosniff')
  async pod(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Param('podId', ParseUUIDPipe) podId: string) {
    const file = await this.service.pod(req.user, id, podId);
    return new StreamableFile(file.buffer, { type: file.mimeType, disposition: 'inline', length: file.sizeBytes });
  }
}
