import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { CreateUserDto, ListUsersDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users.read')
  list(@Query() query: ListUsersDto) { return this.users.list(query); }

  @Post()
  @RequirePermission('users.create')
  create(@Body() dto: CreateUserDto) { return this.users.create(dto); }

  @Patch(':id/lock')
  @RequirePermission('users.lock')
  lock(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.users.lock(id, req.user.id); }
}
