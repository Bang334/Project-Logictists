import { Body, Controller, Get, Param, Patch, Req, ParseUUIDPipe } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { AuthRequest, RequirePermission } from '../auth/access';
@Controller('branches')
export class BranchesController {
  constructor(private readonly service: BranchesService) {}
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
