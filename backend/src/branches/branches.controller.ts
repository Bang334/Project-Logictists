import {
  Body,
  Controller,
  ForbiddenException,
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

@Controller('branches')
@UseGuards(AuthGuard('jwt'))
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  findAll() {
    return this.branchesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.branchesService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateBranchDto: UpdateBranchDto,
    @Req() req: { user: { role: Role; branchId?: string } },
  ) {
    if (req.user.role !== Role.ADMIN && req.user.branchId !== id) {
      throw new ForbiddenException('Bạn chỉ có quyền cập nhật chi nhánh mà tài khoản được gán');
    }
    return this.branchesService.update(id, updateBranchDto);
  }
}
