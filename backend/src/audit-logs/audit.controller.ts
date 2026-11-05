import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { AuditQueryDto } from './audit.dto';
import { AuditService } from './audit.service';

@Controller('audit-logs')
@RequirePermission('authenticated')
export class AuditController {
  constructor(private readonly service: AuditService) {}
  @Get() @Header('Cache-Control', 'private, no-store')
  list(@Query() query: AuditQueryDto, @Req() req: AuthRequest) { return this.service.list(query, req.user); }
  @Get(':source/:id') @Header('Cache-Control', 'private, no-store')
  detail(@Param('source') source: string, @Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.service.detail(source, id, req.user); }
}
