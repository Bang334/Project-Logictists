import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertPermission, branchFilter, Principal } from '../auth/access';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateLoadRestrictionZoneDto,
  CurfewWindowDto,
  UpdateLoadRestrictionZoneDto,
} from './dto/zone.dto';
import { parseTimeToMinutes, ZoneCurfewRecord } from './geo.utils';

@Injectable()
export class ZonesService {
  constructor(private readonly prisma: PrismaService) {}

  private validatePolygon(polygon: number[][][]): number[][][] {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      throw new BadRequestException('Polygon vùng cấm tải phải có ít nhất 1 vòng tọa độ.');
    }
    const outer = polygon[0];
    if (!Array.isArray(outer) || outer.length < 3) {
      throw new BadRequestException('Vòng ngoài polygon phải có ít nhất 3 đỉnh.');
    }
    return polygon.map((ring, idx) => {
      if (!Array.isArray(ring) || ring.length < 3) {
        throw new BadRequestException(`Vòng tọa độ #${idx + 1} không hợp lệ.`);
      }
      const normalized = ring.map((pt) => {
        if (!Array.isArray(pt) || pt.length < 2) {
          throw new BadRequestException('Mỗi đỉnh polygon phải là cặp [longitude, latitude].');
        }
        const lng = Number(pt[0]);
        const lat = Number(pt[1]);
        if (
          !Number.isFinite(lng) ||
          !Number.isFinite(lat) ||
          lng < -180 ||
          lng > 180 ||
          lat < -90 ||
          lat > 90
        ) {
          throw new BadRequestException(`Tọa độ [${lng}, ${lat}] nằm ngoài phạm vi WGS84.`);
        }
        return [lng, lat];
      });
      const first = normalized[0];
      const last = normalized[normalized.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        normalized.push([first[0], first[1]]);
      }
      return normalized;
    });
  }

  private validateCurfewWindows(windows: CurfewWindowDto[]): Array<{ startTime: string; endTime: string }> {
    if (!Array.isArray(windows) || windows.length === 0) {
      throw new BadRequestException('Vùng cấm tải phải có ít nhất 1 khung giờ cấm.');
    }
    return windows.map((win) => {
      const startMin = parseTimeToMinutes(win.startTime);
      const endMin = parseTimeToMinutes(win.endTime);
      if (endMin <= startMin) {
        throw new BadRequestException(
          `Khung giờ cấm ${win.startTime}–${win.endTime} không hợp lệ (giờ kết thúc phải sau giờ bắt đầu).`,
        );
      }
      return { startTime: win.startTime.trim(), endTime: win.endTime.trim() };
    });
  }

  async list(user: Principal, branchId?: string) {
    const scope = branchFilter(user, 'settings.read', branchId);
    return this.prisma.loadRestrictionZone.findMany({
      where: { branchId: scope },
      orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async findActiveByBranch(branchId: string): Promise<ZoneCurfewRecord[]> {
    const rows = await this.prisma.loadRestrictionZone.findMany({
      where: { branchId, active: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      active: row.active,
      maxPayloadKg: row.maxPayloadKg,
      polygon: row.polygon,
      curfewWindows: row.curfewWindows,
    }));
  }

  async create(dto: CreateLoadRestrictionZoneDto, user: Principal) {
    assertPermission(user, 'settings.manage', dto.branchId);
    const branch = await this.prisma.branch.findUnique({
      where: { id: dto.branchId },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundException('Không tìm thấy chi nhánh.');
    }
    const polygon = this.validatePolygon(dto.polygon);
    const curfewWindows = this.validateCurfewWindows(dto.curfewWindows);

    return this.prisma.loadRestrictionZone.create({
      data: {
        branchId: dto.branchId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        active: dto.active ?? true,
        maxPayloadKg: dto.maxPayloadKg,
        polygon: polygon as Prisma.InputJsonValue,
        curfewWindows: curfewWindows as Prisma.InputJsonValue,
      },
    });
  }

  async update(id: string, dto: UpdateLoadRestrictionZoneDto, user: Principal) {
    const existing = await this.prisma.loadRestrictionZone.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy vùng cấm tải.');
    }
    assertPermission(user, 'settings.manage', existing.branchId);

    const data: Prisma.LoadRestrictionZoneUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description.trim() || null;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.maxPayloadKg !== undefined) data.maxPayloadKg = dto.maxPayloadKg;
    if (dto.polygon !== undefined) {
      data.polygon = this.validatePolygon(dto.polygon) as Prisma.InputJsonValue;
    }
    if (dto.curfewWindows !== undefined) {
      data.curfewWindows = this.validateCurfewWindows(dto.curfewWindows) as Prisma.InputJsonValue;
    }

    return this.prisma.loadRestrictionZone.update({
      where: { id },
      data,
    });
  }

  async remove(id: string, user: Principal) {
    const existing = await this.prisma.loadRestrictionZone.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Không tìm thấy vùng cấm tải.');
    }
    assertPermission(user, 'settings.manage', existing.branchId);
    await this.prisma.loadRestrictionZone.delete({ where: { id } });
    return { deleted: true, id };
  }
}
