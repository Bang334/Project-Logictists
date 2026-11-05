import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { AuthRequest, RequirePermission } from '../auth/access';
import { AccountVersionDto, CreateUserDto, ListUsersDto, UpdateUserDto } from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('users.read')
  list(@Query() query: ListUsersDto) { return this.users.list(query); }

  @Post()
  @RequirePermission('users.create')
  create(@Body() dto: CreateUserDto, @Req() req: AuthRequest, @Headers('idempotency-key') key = '') { return this.users.create(dto, req.user.id, key); }

  @Get('available-drivers')
  @RequirePermission('users.create')
  availableDrivers(@Query() query: ListUsersDto) { return this.users.availableDrivers(query); }

  @Get(':id')
  @RequirePermission('users.read')
  detail(@Param('id', ParseUUIDPipe) id: string) { return this.users.detail(id); }

  @Patch(':id')
  @RequirePermission('users.create')
  edit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @Req() req: AuthRequest) { return this.users.edit(id, dto, req.user.id); }

  @Patch(':id/unlock')
  @RequirePermission('users.lock')
  unlock(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AccountVersionDto, @Req() req: AuthRequest) { return this.users.edit(id, dto, req.user.id, true); }

  @Patch(':id/lock')
  @RequirePermission('users.lock')
  lock(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest, @Body() dto: AccountVersionDto) { return this.users.lock(id, req.user.id, dto.expectedUpdatedAt); }
}
