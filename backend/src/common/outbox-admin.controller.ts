import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthenticatedUser } from '../auth/branch-scope';
import { QueryOutboxFailuresDto } from './dto/query-outbox.dto';
import { OutboxService } from './services/outbox.service';

@Controller('admin/outbox')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN)
export class OutboxAdminController {
  constructor(private readonly outboxService: OutboxService) {}

  @Get('failures')
  listFailures(@Query() query: QueryOutboxFailuresDto) {
    return this.outboxService.listFailures(query.page, query.limit);
  }

  @Post(':id/retry')
  retry(
    @Param('id') id: string,
    @Req() req: { user: AuthenticatedUser },
  ) {
    return this.outboxService.retryDeadLetter(id, req.user.id);
  }
}
