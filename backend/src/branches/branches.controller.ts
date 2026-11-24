import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { BranchesService } from './branches.service';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { Role } from '@prisma/client';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { assertBranchAccess, resolveBranchScope } from '../auth/branch-scope';

@Controller('branches')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.DISPATCHER)
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  findAll(@Req() req: { user: { role: Role; branchId?: string | null } }) {
    const branchId =
      req.user.role === Role.ADMIN
        ? undefined
        : resolveBranchScope(req.user);
    return this.branchesService.findAll(branchId);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @Req() req: { user: { role: Role; branchId?: string | null } },
  ) {
    assertBranchAccess(req.user, id);
    return this.branchesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateBranchDto: UpdateBranchDto,
    @Req() req: { user: { role: Role; branchId?: string | null } },
  ) {
    assertBranchAccess(req.user, id);
    return this.branchesService.update(id, updateBranchDto);
  }
}
