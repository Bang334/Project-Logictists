import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  NotFoundException, Param, ParseUUIDPipe, Post, Put, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertPermission, AuthRequest, RequirePermission } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import { parseWorkPolicyToDrivingRest } from '../trips/interprovincial-policy';
import { TollCorridorInputDto, WorkPolicyInputDto } from './dto/transport-settings.dto';

@Controller('settings/transport')
export class TransportSettingsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('work-policies')
  @RequirePermission('settings.read')
  listWorkPolicies(@Req() req: AuthRequest) {
    assertPermission(req.user, 'settings.read');
    return this.prisma.workPolicy.findMany({
      where: { jurisdiction: 'VN' },
      orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
    });
  }

  @Post('work-policies')
  @RequirePermission('settings.manage')
  createWorkPolicy(@Req() req: AuthRequest, @Body() dto: WorkPolicyInputDto) {
    assertPermission(req.user, 'settings.manage');
    const data = this.workPolicyData(dto);
    return this.write(() => this.prisma.workPolicy.create({ data }));
  }

  @Put('work-policies/:id')
  @RequirePermission('settings.manage')
  updateWorkPolicy(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WorkPolicyInputDto) {
    assertPermission(req.user, 'settings.manage');
    const data = this.workPolicyData(dto);
    return this.write(() => this.prisma.workPolicy.update({ where: { id, jurisdiction: 'VN' }, data }));
  }

  @Delete('work-policies/:id')
  @RequirePermission('settings.manage')
  deleteWorkPolicy(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    assertPermission(req.user, 'settings.manage');
    return this.write(() => this.prisma.workPolicy.delete({ where: { id, jurisdiction: 'VN' } }));
  }

  @Get('toll-corridors')
  @RequirePermission('settings.read')
  listTollCorridors(@Req() req: AuthRequest) {
    assertPermission(req.user, 'settings.read');
    return this.prisma.tollCorridor.findMany({ orderBy: [{ fromProvinceCode: 'asc' }, { toProvinceCode: 'asc' }] });
  }

  @Post('toll-corridors')
  @RequirePermission('settings.manage')
  createTollCorridor(@Req() req: AuthRequest, @Body() dto: TollCorridorInputDto) {
    assertPermission(req.user, 'settings.manage');
    const data = this.tollCorridorData(dto);
    return this.write(() => this.prisma.tollCorridor.create({ data }));
  }

  @Put('toll-corridors/:id')
  @RequirePermission('settings.manage')
  updateTollCorridor(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TollCorridorInputDto) {
    assertPermission(req.user, 'settings.manage');
    const data = this.tollCorridorData(dto);
    return this.write(() => this.prisma.tollCorridor.update({ where: { id }, data }));
  }

  @Delete('toll-corridors/:id')
  @RequirePermission('settings.manage')
  deleteTollCorridor(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    assertPermission(req.user, 'settings.manage');
    return this.write(() => this.prisma.tollCorridor.delete({ where: { id } }));
  }

  private workPolicyData(dto: WorkPolicyInputDto) {
    const data = {
      code: dto.code.toUpperCase(), revision: dto.revision, jurisdiction: 'VN',
      effectiveFrom: new Date(dto.effectiveFrom),
      effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
      approvalReference: dto.approvalReference?.trim() || null,
      limits: { ...dto.limits },
    };
    if (data.effectiveTo && data.effectiveTo < data.effectiveFrom) {
      throw new BadRequestException('Ngày hết hiệu lực phải từ ngày bắt đầu trở đi');
    }
    parseWorkPolicyToDrivingRest(data);
    return data;
  }

  private tollCorridorData(dto: TollCorridorInputDto) {
    const fromProvinceCode = dto.fromProvinceCode.toUpperCase();
    const toProvinceCode = dto.toProvinceCode.toUpperCase();
    if (fromProvinceCode === toProvinceCode) {
      throw new BadRequestException('Tỉnh đi và tỉnh đến phải khác nhau');
    }
    return {
      fromProvinceCode, toProvinceCode, baseTollVnd: dto.baseTollVnd, active: dto.active,
      highwayName: dto.highwayName?.trim() || null, distanceHintKm: dto.distanceHintKm ?? null,
    };
  }

  private async write<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') throw new ConflictException('Mã và phiên bản hoặc cặp tỉnh đã tồn tại');
        if (error.code === 'P2025') throw new NotFoundException('Không tìm thấy cấu hình vận tải');
      }
      throw error;
    }
  }
}
