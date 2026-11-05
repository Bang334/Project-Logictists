import { Body, Controller, Get, Param, Patch, Req, ParseUUIDPipe } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { Headers, Post, Query } from '@nestjs/common';
import { BranchListDto, BranchStatusDto, CreateBranchDto } from './dto/admin-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { AuthRequest, RequirePermission } from '../auth/access';
@Controller('branches')
export class BranchesController {
  constructor(private readonly service: BranchesService) {}
  @RequirePermission('branches.manage')
  @Get('admin-list')
  listAdmin(@Query() query: BranchListDto, @Req() req: AuthRequest) { return this.service.listAdmin(query, req.user); }
  @RequirePermission('branches.manage')
  @Post()
  create(@Body() dto: CreateBranchDto, @Req() req: AuthRequest, @Headers('idempotency-key') key = '') { return this.service.create(dto, req.user, key); }
  @RequirePermission('branches.manage')
  @Get(':id/impacts')
  impacts(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.service.impacts(id, req.user); }
  @RequirePermission('branches.manage')
  @Patch(':id/status')
  status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: BranchStatusDto, @Req() req: AuthRequest, @Headers('idempotency-key') key = '') { return this.service.setActive(id, dto, req.user, key); }
  @RequirePermission('branches.read')
  @Get()
  findAll(@Req() req: AuthRequest) { return this.service.findAll(req.user); }
  @RequirePermission('branches.read')
  @Get(':id')
  findOne(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(id, req.user); }
  @RequirePermission('branches.manage')
  @Patch(':id')
  update(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) { return this.service.update(id, dto, req.user); }
}
